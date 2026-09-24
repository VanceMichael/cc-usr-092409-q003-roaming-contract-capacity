import { createHash } from "node:crypto";
import type { DB } from "./db.js";
import {
  contractStatusAt,
  contractVersionAt,
  fxAt,
  guaranteeAt,
  periodIsLocked,
  siteStatusAt,
  versionIncludesSite,
  type ContractVersion,
  type FxRate,
} from "./catalog.js";
import {
  addSeconds,
  convertCeil,
  dayKey,
  HttpError,
  nowIso,
  periodKey,
  resolveTime,
} from "./time.js";

// ---- 行类型 ---------------------------------------------------------------

interface SessionRow {
  session_id: string;
  request_hash: string;
  contract_id: string;
  version_id: number;
  fx_rate_id: number | null;
  partner_id: string;
  guarantee_currency: string | null;
  site_id: string;
  vin: string | null;
  vehicle_type: string | null;
  account_id: string | null;
  currency: string;
  estimated_amount: number;
  held_amount: number;
  held_converted: number;
  measured_amount: number;
  settled_amount: number | null;
  day_key: string;
  period_key: string;
  start_event_time: string;
  start_seen_at: string;
  end_event_time: string | null;
  hold_expires_at: string;
  status: "started" | "risk_review" | "completed" | "expired" | "aborted";
}

const DEFAULT_HOLD_TTL_SECONDS = Number(process.env.APP_HOLD_TTL_SECONDS ?? "14400"); // 4 小时

// ---- 请求指纹（幂等 / 同键异文冲突） ---------------------------------------

export function canonicalize(body: Record<string, unknown>): string {
  const seen: unknown[] = [];
  const sort = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (seen.includes(value)) return;
    seen.push(value);
    if (Array.isArray(value)) return value.map(sort);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sort((value as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(sort(body));
}

function requestHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}

// ---- 额度视图：所有汇总只统计 event_time <= asOf 的台账行（离线 as-of） -----

function heldAt(db: DB, contractId: string, at: string, day: string, period: string) {
  const sql = `SELECT
      COALESCE(SUM(CASE WHEN day_key = @day THEN amount END), 0) AS day_held,
      COALESCE(SUM(CASE WHEN period_key = @period THEN amount END), 0) AS period_held
    FROM quota_ledger
    WHERE contract_id = @c AND bucket = 'held' AND event_time <= @at`;
  return db.prepare(sql).get({ c: contractId, at, day, period }) as {
    day_held: number;
    period_held: number;
  };
}

function consumedAt(db: DB, contractId: string, at: string, day: string, period: string) {
  const sql = `SELECT
      COALESCE(SUM(CASE WHEN day_key = @day THEN amount END), 0) AS day_consumed,
      COALESCE(SUM(CASE WHEN period_key = @period THEN amount END), 0) AS period_consumed
    FROM quota_ledger
    WHERE contract_id = @c AND bucket = 'consumed' AND event_time <= @at`;
  return db.prepare(sql).get({ c: contractId, at, day, period }) as {
    day_consumed: number;
    period_consumed: number;
  };
}

function manualHeadroom(db: DB, contractId: string, at: string, day: string, period: string) {
  const sql = `SELECT
      COALESCE(SUM(CASE WHEN day_key = @day THEN amount END), 0) AS day_manual,
      COALESCE(SUM(CASE WHEN period_key = @period THEN amount END), 0) AS period_manual
    FROM quota_ledger
    WHERE contract_id = @c AND bucket = 'manual' AND event_time <= @at`;
  return db.prepare(sql).get({ c: contractId, at, day, period }) as {
    day_manual: number;
    period_manual: number;
  };
}

/** 该合作方在 as-of 时刻被占用的担保币种总额（冻结汇率，随台账 converted_amount）。 */
export function guaranteeHeldAt(db: DB, partnerId: string, at: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(l.converted_amount), 0) AS held
         FROM quota_ledger l JOIN contracts c ON c.contract_id = l.contract_id
        WHERE c.partner_id = ? AND l.bucket = 'held' AND l.event_time <= ?`
    )
    .get(partnerId, at) as { held: number };
  return row.held;
}

/** 适用的人工超额授权总额（as-of：只看 at 之前已授予的豁免）。 */
function exemptionHeadroom(
  db: DB,
  contractId: string,
  at: string,
  day: string,
  period: string,
  requestKey: string
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS amount FROM manual_exemptions
        WHERE contract_id = ? AND kind = 'overage' AND granted_at <= ?
          AND ( (scope_type = 'session' AND scope_value = ?)
             OR (scope_type = 'day' AND scope_value = ?)
             OR (scope_type = 'period' AND scope_value = ?) )`
    )
    .get(contractId, at, requestKey, day, period) as { amount: number };
  return row.amount;
}

interface CapSnapshot {
  version: ContractVersion;
  day: string;
  period: string;
  dayHeld: number;
  periodHeld: number;
  dayConsumed: number;
  periodConsumed: number;
  dayManual: number;
  periodManual: number;
  exempted: number;
  dayCap: number;
  periodCap: number;
}

function capSnapshot(
  db: DB,
  version: ContractVersion,
  at: string,
  day: string,
  period: string,
  requestKey: string
): CapSnapshot {
  const held = heldAt(db, version.contract_id, at, day, period);
  const consumed = consumedAt(db, version.contract_id, at, day, period);
  const manual = manualHeadroom(db, version.contract_id, at, day, period);
  const exempted = exemptionHeadroom(db, version.contract_id, at, day, period, requestKey);
  return {
    version,
    day,
    period,
    dayHeld: held.day_held,
    periodHeld: held.period_held,
    dayConsumed: consumed.day_consumed,
    periodConsumed: consumed.period_consumed,
    dayManual: manual.day_manual,
    periodManual: manual.period_manual,
    exempted,
    dayCap: version.daily_limit + manual.day_manual + exempted,
    periodCap: version.period_limit + manual.period_manual + exempted,
  };
}

export function appendLedger(
  db: DB,
  input: {
    contractId: string;
    day: string;
    period: string;
    currency: string;
    sessionId?: string | null;
    bucket: "held" | "consumed" | "manual";
    changeType: string;
    amount: number;
    converted?: number | null;
    at: string;
    refType?: string | null;
    refId?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO quota_ledger
       (contract_id, period_key, day_key, session_id, ref_type, ref_id,
        bucket, change_type, amount, converted_amount, currency, event_time)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.contractId,
    input.period,
    input.day,
    input.sessionId ?? null,
    input.refType ?? null,
    input.refId ?? null,
    input.bucket,
    input.changeType,
    input.amount,
    input.converted ?? null,
    input.currency,
    input.at
  );
}

/** 人工额度调整（正追加、负扣回），写入 manual 台账桶，参与 cap 计算。 */
export function addManualAdjustment(
  db: DB,
  input: {
    contractId: string;
    amount: number;
    at: string;
    scope: "day" | "period";
    scopeValue: string; // YYYY-MM-DD 或 YYYY-MM
    currency: string;
    note?: string;
    approver: string;
  }
): void {
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new HttpError(400, "invalid_amount", "调整额必须为非零整数");
  }
  if (input.scope === "day" && !/^\d{4}-\d{2}-\d{2}$/.test(input.scopeValue)) {
    throw new HttpError(400, "invalid_scope", "day 作用域值必须为 YYYY-MM-DD");
  }
  if (input.scope === "period" && !/^\d{4}-\d{2}$/.test(input.scopeValue)) {
    throw new HttpError(400, "invalid_scope", "period 作用域值必须为 YYYY-MM");
  }
  const day = input.scope === "day" ? input.scopeValue : input.scopeValue + "-01";
  const period = input.scope === "period" ? input.scopeValue : input.scopeValue.slice(0, 7);
  appendLedger(db, {
    contractId: input.contractId,
    day,
    period,
    currency: input.currency,
    bucket: "manual",
    changeType: "manual_adjust",
    amount: input.amount,
    at: input.at,
    refType: "exemption",
    refId: input.approver,
  });
}

// ---- 会话启动 -------------------------------------------------------------

export interface StartInput {
  requestKey: string;
  contractId: string;
  siteId: string;
  estimatedAmount: number;
  currency?: string;
  vin?: string;
  vehicleType?: string;
  accountId?: string;
  eventTime?: string;
  holdTtlSeconds?: number;
}

function recordDecision(
  db: DB,
  input: {
    requestKey: string;
    hash: string;
    contractId: string | null;
    sessionId: string | null;
    decision: "allowed" | "denied" | "conflict" | "replay";
    reasons: unknown;
    snapshot: unknown;
    at: string;
  }
): void {
  db.prepare(
    `INSERT INTO admission_decisions
       (request_key, request_hash, contract_id, session_id, decision, reasons, snapshot, event_time)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.requestKey,
    input.hash,
    input.contractId,
    input.sessionId,
    input.decision,
    JSON.stringify(input.reasons),
    JSON.stringify(input.snapshot),
    input.at
  );
}

/**
 * 会话准入：在单个 IMMEDIATE 事务内完成“所见版本/汇率冻结 + 额度/担保校验 + 占用落账”。
 * 并发申请在 SQLite 层串行化，第二个事务看到第一个事务已提交的占用，故不透支。
 *
 * 事务返回判别结果而不是抛错：拒绝/冲突也要先提交 admission_decisions 留痕，
 * 提交后再由外层抛出 HttpError，否则回滚会让一次拒绝无从追溯。
 */
type StartResult =
  | { ok: true; session: SessionRow }
  | { ok: false; error: HttpError };

export function startSession(db: DB, raw: StartInput): SessionRow {
  if (!raw.requestKey || typeof raw.requestKey !== "string") {
    throw new HttpError(400, "request_key_required", "启动请求必须携带幂等键");
  }
  if (!Number.isInteger(raw.estimatedAmount) || raw.estimatedAmount < 0) {
    throw new HttpError(400, "invalid_estimate", "estimatedAmount 必须为非负整数（最小货币单位）");
  }
  const seenAt = nowIso();
  const at = resolveTime(raw.eventTime, seenAt);
  const ttl = raw.holdTtlSeconds ?? DEFAULT_HOLD_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new HttpError(400, "invalid_ttl", "占用有效期必须为正整数秒");
  }

  // 指纹只覆盖业务语义字段；TTL 等运维参数不参与冲突判定
  const fingerprintBody = {
    contractId: raw.contractId,
    siteId: raw.siteId,
    estimatedAmount: raw.estimatedAmount,
    currency: raw.currency ?? null,
    vin: raw.vin ?? null,
    vehicleType: raw.vehicleType ?? null,
    accountId: raw.accountId ?? null,
    eventTime: at,
  };
  const hash = requestHash(fingerprintBody);

  const tx = db.transaction((): StartResult => {
    // 1) 幂等：相同启动键
    const existing = db
      .prepare("SELECT * FROM charging_sessions WHERE session_id = ?")
      .get(raw.requestKey) as SessionRow | undefined;
    if (existing) {
      if (existing.request_hash !== hash) {
        recordDecision(db, {
          requestKey: raw.requestKey,
          hash,
          contractId: raw.contractId,
          sessionId: raw.requestKey,
          decision: "conflict",
          reasons: ["request_body_conflict"],
          snapshot: { incoming: fingerprintBody },
          at,
        });
        return {
          ok: false,
          error: new HttpError(409, "request_conflict", "同一启动键对应不同请求内容（同键异文）", {
            reasons: ["request_body_conflict"],
            requestKey: raw.requestKey,
            existingStatus: existing.status,
          }),
        };
      }
      recordDecision(db, {
        requestKey: raw.requestKey,
        hash,
        contractId: existing.contract_id,
        sessionId: existing.session_id,
        decision: "replay",
        reasons: [],
        snapshot: { replayed: true },
        at,
      });
      return { ok: true, session: existing }; // 相同启动请求返回原占用
    }

    // 2) as-of 准入判定（离线事件按发生时刻，不按到达时刻）
    const reasons: string[] = [];
    const day = dayKey(at);
    const period = periodKey(at);
    if (periodIsLocked(db, raw.contractId, period)) {
      // 后来已签署的结算：晚到事件不得越过
      recordDecision(db, {
        requestKey: raw.requestKey,
        hash,
        contractId: raw.contractId,
        sessionId: null,
        decision: "denied",
        reasons: ["period_already_signed"],
        snapshot: { at, period },
        at,
      });
      return {
        ok: false,
        error: new HttpError(409, "period_already_signed", `账期 ${period} 已签署，离线事件不得越过`, {
          reasons: ["period_already_signed"],
          period,
        }),
      };
    }

    const contractRow = db
      .prepare("SELECT partner_id FROM contracts WHERE contract_id = ?")
      .get(raw.contractId) as { partner_id: string } | undefined;
    if (!contractRow) {
      return { ok: false, error: new HttpError(404, "contract_not_found", `合同不存在：${raw.contractId}`) };
    }
    const version = contractVersionAt(db, raw.contractId, at);
    if (!version) reasons.push("no_effective_contract_version");
    if (contractStatusAt(db, raw.contractId, at) === "paused") reasons.push("contract_paused");
    if (siteStatusAt(db, raw.siteId, at) !== "qualified") reasons.push("site_not_qualified");
    if (version && !versionIncludesSite(db, version.version_id, raw.siteId)) {
      reasons.push("site_not_in_whitelist");
    }
    if (version) {
      if (raw.currency && raw.currency !== version.currency) reasons.push("currency_mismatch");
      const types = version.vehicle_types ? (JSON.parse(version.vehicle_types) as string[]) : null;
      if (types && (!raw.vehicleType || !types.includes(raw.vehicleType))) {
        reasons.push("vehicle_type_out_of_scope");
      }
      const accounts = version.accounts ? (JSON.parse(version.accounts) as string[]) : null;
      if (accounts && (!raw.accountId || !accounts.includes(raw.accountId))) {
        reasons.push("account_out_of_scope");
      }
    }

    let fx: FxRate | null = null;
    let holdConverted = 0;
    let guaranteeCurrency: string | null = null;
    let snapshot: Record<string, unknown> = { at, day, period };

    if (version) {
      // 担保：as-of 余额与已占用；冻结合同币种 -> 担保币种的汇率版本
      const guar = guaranteeAt(db, contractRow.partner_id, at);
      guaranteeCurrency = guar.currency;
      if (guar.currency && guar.currency !== version.currency) {
        fx = fxAt(db, version.currency, guar.currency, at);
        if (!fx) reasons.push("fx_rate_unavailable");
      }
      const caps = capSnapshot(db, version, at, day, period, raw.requestKey);
      snapshot = {
        ...snapshot,
        versionTag: version.version_tag,
        versionId: version.version_id,
        currency: version.currency,
        dailyLimit: version.daily_limit,
        periodLimit: version.period_limit,
        dayHeld: caps.dayHeld,
        periodHeld: caps.periodHeld,
        dayConsumed: caps.dayConsumed,
        periodConsumed: caps.periodConsumed,
        dayManual: caps.dayManual,
        periodManual: caps.periodManual,
        exempted: caps.exempted,
        guaranteeBalance: guar.balance,
        guaranteeCurrency: guar.currency,
      };

      if (fx && !reasons.includes("fx_rate_unavailable")) {
        holdConverted = convertCeil(raw.estimatedAmount, fx.numerator, fx.denominator);
        snapshot.fxRateId = fx.rate_id;
        snapshot.estimatedConverted = holdConverted;
      } else {
        holdConverted = raw.estimatedAmount;
      }

      // 单日 / 账期上限（含人工追加额度与已授予的超额授权）
      const dayProjected = caps.dayHeld + caps.dayConsumed + raw.estimatedAmount;
      const periodProjected = caps.periodHeld + caps.periodConsumed + raw.estimatedAmount;
      if (dayProjected > caps.dayCap) {
        reasons.push("daily_cap_exceeded");
        Object.assign(snapshot, { dayProjected, dayCap: caps.dayCap });
      }
      if (periodProjected > caps.periodCap) {
        reasons.push("period_cap_exceeded");
        Object.assign(snapshot, { periodProjected, periodCap: caps.periodCap });
      }
      // 担保余额（冻结汇率向上取整，宁可多占不透支）
      const guarProjected = guaranteeHeldAt(db, contractRow.partner_id, at) + holdConverted;
      snapshot.guaranteeProjected = guarProjected;
      if (guarProjected > guar.balance) reasons.push("guarantee_insufficient");
    }

    if (reasons.length > 0) {
      recordDecision(db, {
        requestKey: raw.requestKey,
        hash,
        contractId: raw.contractId,
        sessionId: null,
        decision: "denied",
        reasons,
        snapshot,
        at,
      });
      return {
        ok: false,
        error: new HttpError(403, "admission_denied", "会话准入被拒绝", { reasons, snapshot }),
      };
    }
    if (!version) {
      return { ok: false, error: new HttpError(500, "admission_inconsistent", "准入判定状态不一致") };
    }

    // 3) 放行：冻结合同版本与汇率版本，创建有期限占用
    const expiresAt = addSeconds(at, ttl);
    db.prepare(
      `INSERT INTO charging_sessions
         (session_id, request_hash, contract_id, version_id, fx_rate_id, partner_id,
          guarantee_currency, site_id, vin, vehicle_type, account_id, currency,
          estimated_amount, held_amount, held_converted, day_key, period_key,
          start_event_time, start_seen_at, hold_expires_at, status)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started')`
    ).run(
      raw.requestKey,
      hash,
      raw.contractId,
      version.version_id,
      fx?.rate_id ?? null,
      contractRow.partner_id,
      guaranteeCurrency,
      raw.siteId,
      raw.vin ?? null,
      raw.vehicleType ?? null,
      raw.accountId ?? null,
      version.currency,
      raw.estimatedAmount,
      raw.estimatedAmount,
      holdConverted,
      day,
      period,
      at,
      seenAt,
      expiresAt
    );
    appendLedger(db, {
      contractId: raw.contractId,
      day,
      period,
      currency: version.currency,
      sessionId: raw.requestKey,
      bucket: "held",
      changeType: "hold",
      amount: raw.estimatedAmount,
      converted: holdConverted,
      at,
    });
    recordDecision(db, {
      requestKey: raw.requestKey,
      hash,
      contractId: raw.contractId,
      sessionId: raw.requestKey,
      decision: "allowed",
      reasons: [],
      snapshot,
      at,
    });
    return {
      ok: true,
      session: db.prepare("SELECT * FROM charging_sessions WHERE session_id = ?").get(raw.requestKey) as SessionRow,
    };
  });

  const result = tx.immediate();
  if (!result.ok) throw result.error;
  return result.session;
}

// ---- 占用金额的带符号换算（增占用向上取整，释放向下取整，保守不透支） --------

function convertSigned(amount: number, fx: FxRate | null): number {
  if (!fx || amount === 0) return amount;
  const raw = (amount * fx.numerator) / fx.denominator;
  return amount > 0 ? Math.ceil(raw) : Math.floor(raw);
}

export function getSession(db: DB, sessionId: string): SessionRow {
  const row = db.prepare("SELECT * FROM charging_sessions WHERE session_id = ?").get(sessionId) as
    | SessionRow
    | undefined;
  if (!row) throw new HttpError(404, "session_not_found", `会话不存在：${sessionId}`);
  return row;
}

function frozenFx(db: DB, session: SessionRow): FxRate | null {
  if (!session.fx_rate_id) return null;
  const row = db.prepare("SELECT * FROM fx_rates WHERE rate_id = ?").get(session.fx_rate_id) as
    | FxRate
    | undefined;
  return row ?? null;
}

function openReview(
  db: DB,
  session: SessionRow,
  reason: "contract_paused" | "guarantee_withdrawn" | "site_disqualified" | "overage_unauthorized" | "over_cap_settle",
  detail: unknown,
  at: string
): void {
  const duplicate = db
    .prepare(
      "SELECT 1 FROM risk_reviews WHERE session_id = ? AND reason = ? AND status = 'open'"
    )
    .get(session.session_id, reason);
  if (duplicate) return;
  db.prepare(
    `INSERT INTO risk_reviews(session_id, reason, detail, status, detected_event_time)
     VALUES(?, ?, ?, 'open', ?)`
  ).run(session.session_id, reason, JSON.stringify(detail ?? {}), at);
  if (session.status === "started") {
    db.prepare("UPDATE charging_sessions SET status = 'risk_review' WHERE session_id = ?").run(
      session.session_id
    );
  }
}

/**
 * 对单个在途会话按 as-of 时刻检测合同暂停 / 担保撤回 / 站点资格变化。
 * 只把会话转入风险复核，绝不静默中止。
 */
export function detectSessionRisk(db: DB, sessionId: string, at = nowIso()): string[] {
  const opened: string[] = [];
  const tx = db.transaction(() => {
    const session = getSession(db, sessionId);
    if (session.status !== "started" && session.status !== "risk_review") return;
    if (contractStatusAt(db, session.contract_id, at) === "paused") {
      openReview(db, session, "contract_paused", { at }, at);
      opened.push("contract_paused");
    }
    if (siteStatusAt(db, session.site_id, at) === "disqualified") {
      openReview(db, session, "site_disqualified", { at }, at);
      opened.push("site_disqualified");
    }
    const guar = guaranteeAt(db, session.partner_id, at);
    if (guaranteeHeldAt(db, session.partner_id, at) > guar.balance) {
      openReview(db, session, "guarantee_withdrawn", { at, balance: guar.balance }, at);
      opened.push("guarantee_withdrawn");
    }
  });
  tx.immediate();
  return opened;
}

// ---- 计量片段：逐步调整占用 -----------------------------------------------

export interface MeterInput {
  sessionId: string;
  segmentNo: number;
  cumulativeAmount: number;
  eventTime?: string;
}

export function applyMeterSegment(db: DB, raw: MeterInput): SessionRow {
  if (!Number.isInteger(raw.segmentNo) || raw.segmentNo < 0) {
    throw new HttpError(400, "invalid_segment_no", "片段序号必须为非负整数");
  }
  if (!Number.isInteger(raw.cumulativeAmount) || raw.cumulativeAmount < 0) {
    throw new HttpError(400, "invalid_amount", "累计金额必须为非负整数");
  }
  const at = resolveTime(raw.eventTime);

  const tx = db.transaction((): SessionRow => {
    const session = getSession(db, raw.sessionId);
    if (session.status === "completed" || session.status === "aborted" || session.status === "expired") {
      throw new HttpError(409, "session_not_active", `会话当前状态 ${session.status}，不可再计量`);
    }
    if (at < session.start_event_time) {
      throw new HttpError(422, "event_before_start", "片段发生时刻早于会话开始时刻");
    }
    if (periodIsLocked(db, session.contract_id, periodKey(at))) {
      throw new HttpError(409, "period_already_signed", "片段所属账期已签署，不得补录");
    }

    // 片段幂等：相同 (session, segment_no) 直接重放
    const existingSeg = db
      .prepare("SELECT 1 FROM meter_segments WHERE session_id = ? AND segment_no = ?")
      .get(session.session_id, raw.segmentNo);
    if (existingSeg) return getSession(db, session.session_id);

    if (raw.cumulativeAmount < session.measured_amount) {
      throw new HttpError(422, "amount_regressed", "累计金额不得低于此前已确认的累计值");
    }

    db.prepare(
      `INSERT INTO meter_segments(session_id, segment_no, cumulative_amount, event_time)
       VALUES(?, ?, ?, ?)`
    ).run(session.session_id, raw.segmentNo, raw.cumulativeAmount, at);

    const fx = frozenFx(db, session);
    const version = contractVersionAt(db, session.contract_id, session.start_event_time);
    const targetHold = raw.cumulativeAmount;
    const delta = targetHold - session.held_amount;

    // 先记录真实计量；占用是否扩得上去取决于额度与授权
    db.prepare("UPDATE charging_sessions SET measured_amount = ? WHERE session_id = ?").run(
      raw.cumulativeAmount,
      session.session_id
    );

    let holdBlocked = false;
    if (delta > 0) {
      const caps = capSnapshot(
        db,
        version!,
        at,
        session.day_key,
        session.period_key,
        session.session_id
      );
      // 注意 caps 已含本会话现有 held；投影只加增量
      const dayProjected = caps.dayHeld + caps.dayConsumed + delta;
      const periodProjected = caps.periodHeld + caps.periodConsumed + delta;
      const guar = guaranteeAt(db, session.partner_id, at);
      const guarProjected = guaranteeHeldAt(db, session.partner_id, at) +
        convertSigned(delta, fx);
      const overCap = dayProjected > caps.dayCap || periodProjected > caps.periodCap;
      const overGuarantee = guarProjected > guar.balance;
      if (overCap || overGuarantee) {
        // 计量值照记，但占用不扩大；超额必须经声明的授权人豁免后由 catchupHold 追补
        holdBlocked = true;
        openReview(
          db,
          session,
          overCap ? "overage_unauthorized" : "guarantee_withdrawn",
          {
            at,
            delta,
            dayProjected,
            periodProjected,
            dayCap: caps.dayCap,
            periodCap: caps.periodCap,
            guarProjected,
            guaranteeBalance: guar.balance,
            overageApprover: version!.overage_approver,
          },
          at
        );
      }
    }

    if (!holdBlocked && delta !== 0) {
      // 在额度内：调整占用（缩减即逐步释放，增长即追加冻结）
      const deltaConverted = convertSigned(delta, fx);
      appendLedger(db, {
        contractId: session.contract_id,
        day: session.day_key,
        period: session.period_key,
        currency: session.currency,
        sessionId: session.session_id,
        bucket: "held",
        changeType: "adjust",
        amount: delta,
        converted: deltaConverted,
        at,
      });
      db.prepare(
        "UPDATE charging_sessions SET held_amount = held_amount + ?, held_converted = held_converted + ? WHERE session_id = ?"
      ).run(delta, deltaConverted, session.session_id);
    }

    // 片段到达时顺带检测资格类变化（在途不中止，只入复核）
    detectInTx(db, session, at);
    return getSession(db, session.session_id);
  });

  return tx.immediate();
}

/** 事务内调用的资格检测（不另开事务）。 */
function detectInTx(db: DB, session: SessionRow, at: string): void {
  if (contractStatusAt(db, session.contract_id, at) === "paused") {
    openReview(db, session, "contract_paused", { at }, at);
  }
  if (siteStatusAt(db, session.site_id, at) === "disqualified") {
    openReview(db, session, "site_disqualified", { at }, at);
  }
  const guar = guaranteeAt(db, session.partner_id, at);
  if (guaranteeHeldAt(db, session.partner_id, at) > guar.balance) {
    openReview(db, session, "guarantee_withdrawn", { at, balance: guar.balance }, at);
  }
}

// ---- 会话结束：结转真实金额并释放剩余占用 ---------------------------------

export interface EndInput {
  sessionId: string;
  finalAmount?: number;
  eventTime?: string;
}

export function endSession(db: DB, raw: EndInput): SessionRow {
  const at = resolveTime(raw.eventTime);
  const tx = db.transaction((): SessionRow => {
    const session = getSession(db, raw.sessionId);
    if (session.status === "completed") return session; // 结束请求幂等
    if (session.status === "aborted" || session.status === "expired") {
      throw new HttpError(409, "session_not_active", `会话当前状态 ${session.status}，不可结转`);
    }
    if (at < session.start_event_time) {
      throw new HttpError(422, "event_before_start", "结束时刻早于会话开始时刻");
    }
    if (periodIsLocked(db, session.contract_id, periodKey(at))) {
      throw new HttpError(409, "period_already_signed", "结束事件所属账期已签署，不得越过");
    }

    const finalAmount =
      raw.finalAmount !== undefined ? raw.finalAmount : session.measured_amount;
    if (!Number.isInteger(finalAmount) || finalAmount < 0) {
      throw new HttpError(400, "invalid_final_amount", "结算金额必须为非负整数");
    }
    const version = contractVersionAt(db, session.contract_id, session.start_event_time)!;

    // 1) 释放全部占用（合同币 + 冻结汇率下的担保币）
    if (session.held_amount !== 0) {
      appendLedger(db, {
        contractId: session.contract_id,
        day: session.day_key,
        period: session.period_key,
        currency: session.currency,
        sessionId: session.session_id,
        bucket: "held",
        changeType: "release",
        amount: -session.held_amount,
        converted: -session.held_converted,
        at,
      });
    }
    // 2) 结转真实消费
    appendLedger(db, {
      contractId: session.contract_id,
      day: session.day_key,
      period: session.period_key,
      currency: session.currency,
      sessionId: session.session_id,
      bucket: "consumed",
      changeType: "settle",
      amount: finalAmount,
      at,
    });
    db.prepare(
      `INSERT INTO settlements(session_id, contract_id, period_key, day_key, amount, currency, event_time)
       VALUES(?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.session_id,
      session.contract_id,
      session.period_key,
      session.day_key,
      finalAmount,
      session.currency,
      at
    );

    // 3) 真实金额超出可用额度：据实结转，但开风险复核并要求超额授权人事后追认
    const caps = capSnapshot(
      db,
      version,
      at,
      session.day_key,
      session.period_key,
      session.session_id
    );
    // consumed 已含本次 settle；直接比较
    if (caps.dayConsumed > caps.dayCap || caps.periodConsumed > caps.periodCap) {
      const reviewSession = { ...session, status: "completed" as const };
      openReview(
        db,
        reviewSession,
        "over_cap_settle",
        {
          at,
          finalAmount,
          dayConsumed: caps.dayConsumed,
          dayCap: caps.dayCap,
          periodConsumed: caps.periodConsumed,
          periodCap: caps.periodCap,
          overageApprover: version.overage_approver,
        },
        at
      );
    }

    db.prepare(
      `UPDATE charging_sessions
         SET status = 'completed', end_event_time = ?, settled_amount = ?,
             held_amount = 0, held_converted = 0
       WHERE session_id = ?`
    ).run(at, finalAmount, session.session_id);
    return getSession(db, session.session_id);
  });
  return tx.immediate();
}

// ---- 豁免后追补占用 -------------------------------------------------------

/**
 * 计量超限时占用未随真实金额扩大；人工豁免（超额授权或复核放行）后，
 * 按已确认的计量值尝试追补占用。若授权仍不足则保留差额、会话维持复核状态。
 * 必须在已打开 IMMEDIATE 事务的上下文内调用。
 */
export function catchupHold(db: DB, sessionId: string, at: string): number {
  const session = getSession(db, sessionId);
  const target = session.measured_amount;
  const delta = target - session.held_amount;
  if (delta <= 0) return 0;
  if (session.status !== "started" && session.status !== "risk_review") return 0;

  const version = contractVersionAt(db, session.contract_id, session.start_event_time)!;
  const fx = frozenFx(db, session);
  const caps = capSnapshot(db, version, at, session.day_key, session.period_key, session.session_id);
  const guar = guaranteeAt(db, session.partner_id, at);
  const deltaConverted = convertSigned(delta, fx);
  const dayProjected = caps.dayHeld + caps.dayConsumed + delta;
  const periodProjected = caps.periodHeld + caps.periodConsumed + delta;
  const guarProjected = guaranteeHeldAt(db, session.partner_id, at) + deltaConverted;
  if (dayProjected > caps.dayCap || periodProjected > caps.periodCap || guarProjected > guar.balance) {
    return 0; // 授权仍不足，等待后续豁免
  }
  appendLedger(db, {
    contractId: session.contract_id,
    day: session.day_key,
    period: session.period_key,
    currency: session.currency,
    sessionId: session.session_id,
    bucket: "held",
    changeType: "adjust",
    amount: delta,
    converted: deltaConverted,
    at,
    refType: "catchup",
  });
  db.prepare(
    "UPDATE charging_sessions SET held_amount = held_amount + ?, held_converted = held_converted + ? WHERE session_id = ?"
  ).run(delta, deltaConverted, session.session_id);
  return delta;
}

// ---- 过期释放（重启后继续执行） -------------------------------------------

/** 释放到点未结束的占用；风险复核中的会话保留占用，等待人工裁决。 */
export function sweepExpiredHolds(db: DB, now: string = nowIso()): string[] {
  const expired: string[] = [];
  const tx = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM charging_sessions
          WHERE status = 'started' AND hold_expires_at <= ?`
      )
      .all(now) as SessionRow[];
    for (const session of rows) {
      if (session.held_amount !== 0) {
        appendLedger(db, {
          contractId: session.contract_id,
          day: session.day_key,
          period: session.period_key,
          currency: session.currency,
          sessionId: session.session_id,
          bucket: "held",
          changeType: "release",
          amount: -session.held_amount,
          converted: -session.held_converted,
          at: now,
          refType: "expiry",
        });
      }
      db.prepare(
        "UPDATE charging_sessions SET status = 'expired', held_amount = 0, held_converted = 0 WHERE session_id = ?"
      ).run(session.session_id);
      expired.push(session.session_id);
    }
  });
  tx.immediate();
  return expired;
}

/** 扫描全部在途会话的资格变化（服务重启后继续待复核任务）。 */
export function sweepRiskChanges(db: DB, now: string = nowIso()): number {
  const rows = db
    .prepare(
      `SELECT session_id FROM charging_sessions WHERE status IN ('started', 'risk_review')`
    )
    .all() as { session_id: string }[];
  let count = 0;
  for (const row of rows) {
    const opened = detectSessionRisk(db, row.session_id, now);
    count += opened.length;
  }
  return count;
}
