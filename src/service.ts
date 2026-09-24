import type Database from "better-sqlite3";
import { ServiceError } from "./errors.js";
import {
  convert,
  dayKey,
  nowIso,
  parseTime,
  periodKey,
  requestHash,
  round2,
  uuid,
} from "./util.js";
import type {
  ContractVersionInput,
  EndSessionInput,
  ExemptionInput,
  FragmentInput,
  FxRateInput,
  StartSessionInput,
} from "./types.js";

interface ContractVersionRow {
  contract_id: string;
  version: number;
  partner_id: string;
  currency: string;
  daily_limit: number;
  period_limit: number;
  overage_approver: string | null;
  valid_from: string;
  valid_to: string | null;
}

interface SessionRow {
  session_id: string;
  idempotency_key: string;
  contract_id: string;
  contract_version: number;
  site_id: string;
  account_id: string | null;
  vehicle_model: string | null;
  amount_currency: string;
  fx_version: number | null;
  fx_rate: number;
  day_key: string;
  period_key: string;
  event_started_at: string;
  recorded_started_at: string;
  offline: number;
  estimated_amount: number;
  held_amount: number;
  captured_amount: number | null;
  status: string;
  frozen_guarantee_ids: string;
  frozen_lifecycle_seq: number | null;
  frozen_site_seq: number | null;
  request_hash: string;
  settlement_id: string | null;
}

interface PendingAdmissionEvent {
  sessionId: string;
  hash: string | null;
  decision: string;
  reason: string;
  contractId: string | null;
  contractVersion: number | null;
  fxVersion: number | null;
  occurredAt: string | null;
  detail: unknown;
}

/**
 * 准入失败控制流：携带待写事件与对外错误。事件不能在即将回滚的事务内写，
 * 否则拒绝不留痕、无法追溯；由 startSession 外层在回滚后单独持久化。
 */
class AdmissionRollback extends Error {
  constructor(
    public event: PendingAdmissionEvent,
    public serviceError: ServiceError,
  ) {
    super(serviceError.message);
  }
}

/**
 * 立即事务：BEGIN IMMEDIATE 立即取得写锁，把“读余额→判定→写占用”串成串行临界区，
 * 多进程并发下后到者阻塞，杜绝两个会话同时透支同一额度。
 */
function withImmediate<T>(db: Database.Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

export class ClearingService {
  constructor(private db: Database.Database) {}

  // ---- 管理端：合同 ----

  createContract(contractId: string, partnerId: string) {
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO contracts(contract_id, partner_id, created_at, updated_at)
       VALUES(?, ?, ?, ?)`,
    ).run(contractId, partnerId, now, now);
    return { contractId, partnerId, createdAt: now };
  }

  /** 发布不可变新版本；版本号自增。发布不影响已进行会话（它们持有冻结版本）。 */
  publishVersion(contractId: string, input: ContractVersionInput) {
    const contract = this.db.prepare("SELECT 1 FROM contracts WHERE contract_id=?").get(contractId);
    if (!contract) throw new ServiceError("contract_not_found", 404, `合同 ${contractId} 不存在`);
    const validFrom = parseTime(input.validFrom, "validFrom").toISOString();
    const validTo = input.validTo ? parseTime(input.validTo, "validTo").toISOString() : null;
    if (validTo && validTo <= validFrom) {
      throw new ServiceError("invalid_validity", 400, "validTo 必须晚于 validFrom");
    }
    if (!(input.sites?.length > 0)) {
      throw new ServiceError("invalid_sites", 400, "至少声明一个适用站点，['*'] 表示全部");
    }
    if (input.dailyLimit < 0 || input.periodLimit < 0 || input.dailyLimit > input.periodLimit) {
      throw new ServiceError("invalid_limits", 400, "额度不能为负，且单日上限不得大于账期上限");
    }

    const version = (
      this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM contract_versions WHERE contract_id=?")
        .get(contractId) as { v: number }
    ).v;
    const publishedAt = nowIso();

    const apply = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO contract_versions(contract_id, version, partner_id, currency,
           daily_limit, period_limit, period_granularity, overage_approver,
           valid_from, valid_to, published_at)
         VALUES(?, ?, ?, ?, ?, ?, 'monthly', ?, ?, ?, ?)`,
      ).run(
        contractId, version, input.partnerId, input.currency,
        input.dailyLimit, input.periodLimit, input.overageApprover ?? null,
        validFrom, validTo, publishedAt,
      );
      const insSite = this.db.prepare(
        "INSERT INTO contract_version_sites(contract_id, version, site_id) VALUES(?, ?, ?)");
      for (const site of new Set(input.sites)) insSite.run(contractId, version, site);
      const insScope = this.db.prepare(
        "INSERT INTO contract_version_scopes(contract_id, version, scope_type, scope_value) VALUES(?, ?, ?, ?)");
      for (const m of new Set(input.vehicleModels ?? ["*"])) insScope.run(contractId, version, "vehicle_model", m);
      for (const a of new Set(input.accounts ?? ["*"])) insScope.run(contractId, version, "account", a);
      this.db.prepare("UPDATE contracts SET updated_at=? WHERE contract_id=?").run(publishedAt, contractId);
    });
    apply();
    return { contractId, version, publishedAt, validFrom, validTo };
  }

  /** 暂停/恢复合同。只阻断未开始会话；进行中会话由风险复核任务发现，不静默中止。 */
  setContractSuspended(contractId: string, suspend: boolean, reason?: string, occurredAt?: string) {
    const contract = this.db.prepare("SELECT 1 FROM contracts WHERE contract_id=?").get(contractId);
    if (!contract) throw new ServiceError("contract_not_found", 404, `合同 ${contractId} 不存在`);
    const at = (occurredAt ? parseTime(occurredAt, "occurredAt") : new Date()).toISOString();
    this.db.prepare(
      "INSERT INTO contract_lifecycle(contract_id, action, occurred_at, reason) VALUES(?, ?, ?, ?)",
    ).run(contractId, suspend ? "suspend" : "resume", at, reason ?? null);
    this.db.prepare("UPDATE contracts SET updated_at=? WHERE contract_id=?").run(nowIso(), contractId);
    this.detectReviews();
    return { contractId, action: suspend ? "suspend" : "resume", occurredAt: at };
  }

  // ---- 管理端：担保 ----

  addGuarantee(guaranteeId: string, contractId: string, amount: number, currency: string) {
    if (!(amount > 0)) throw new ServiceError("invalid_guarantee", 400, "担保金额必须为正");
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO guarantees(guarantee_id, contract_id, amount, currency, status, created_at)
       VALUES(?, ?, ?, ?, 'active', ?)`,
    ).run(guaranteeId, contractId, amount, currency, now);
    return { guaranteeId, contractId, amount, currency, createdAt: now };
  }

  /** 撤回担保：未开始会话立即失去支撑，进行中会话转入风险复核。 */
  withdrawGuarantee(guaranteeId: string, reason?: string) {
    const g = this.db.prepare("SELECT * FROM guarantees WHERE guarantee_id=?").get(guaranteeId) as
      | { contract_id: string; status: string }
      | undefined;
    if (!g) throw new ServiceError("guarantee_not_found", 404, `担保 ${guaranteeId} 不存在`);
    if (g.status === "withdrawn") throw new ServiceError("guarantee_withdrawn", 409, "担保已撤回");
    const now = nowIso();
    this.db.prepare(
      "UPDATE guarantees SET status='withdrawn', withdrawn_at=? WHERE guarantee_id=?",
    ).run(now, guaranteeId);
    this.detectReviews();
    return { guaranteeId, contractId: g.contract_id, withdrawnAt: now, reason: reason ?? null };
  }

  // ---- 管理端：站点资格 ----

  setSiteEligibility(siteId: string, qualified: boolean, reason?: string, occurredAt?: string) {
    const at = (occurredAt ? parseTime(occurredAt, "occurredAt") : new Date()).toISOString();
    this.db.prepare(
      "INSERT INTO site_eligibility_events(site_id, action, occurred_at, reason) VALUES(?, ?, ?, ?)",
    ).run(siteId, qualified ? "qualify" : "disqualify", at, reason ?? null);
    this.detectReviews();
    return { siteId, qualified, occurredAt: at };
  }

  // ---- 管理端：汇率版本 ----

  publishFxRate(input: FxRateInput) {
    const effectiveAt = parseTime(input.effectiveAt, "effectiveAt").toISOString();
    if (!(input.rate > 0)) throw new ServiceError("invalid_fx_rate", 400, "汇率必须为正");
    const info = this.db.prepare(
      `INSERT INTO fx_rate_versions(base_currency, quote_currency, rate, effective_at, published_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run(input.baseCurrency, input.quoteCurrency, input.rate, effectiveAt, nowIso());
    return { fxVersion: Number(info.lastInsertRowid), effectiveAt };
  }

  // ---- 管理端：人工豁免 ----

  addExemption(input: ExemptionInput) {
    const extraDaily = round2(input.extraDaily ?? 0);
    const extraPeriod = round2(input.extraPeriod ?? 0);
    if (extraDaily < 0 || extraPeriod < 0 || (extraDaily === 0 && extraPeriod === 0)) {
      throw new ServiceError("invalid_exemption", 400, "豁免额必须为正");
    }
    if (!input.approver) throw new ServiceError("invalid_exemption", 400, "豁免必须记录授权人");
    const id = uuid();
    this.db.prepare(
      `INSERT INTO exemptions(exemption_id, contract_id, currency, session_id, day_key, period_key,
         extra_daily, extra_period, approver, reason, source, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
    ).run(
      id, input.contractId, input.currency, input.sessionId ?? null,
      input.dayKey ?? null, input.periodKey ?? null,
      extraDaily, extraPeriod, input.approver, input.reason ?? null, nowIso(),
    );
    return { exemptionId: id, extraDaily, extraPeriod };
  }

  // ---- 会话准入 ----

  /**
   * 会话启动准入。离线补传以 startedAt（发生时刻）为准冻结合同/汇率/担保/站点状态，
   * 但不得越过该时刻之后已签署的结算。全部读写在一个 IMMEDIATE 事务内完成。
   */
  startSession(input: StartSessionInput) {
    if (!input.sessionId || !input.idempotencyKey || !input.contractId || !input.siteId) {
      throw new ServiceError("invalid_request", 400, "sessionId/idempotencyKey/contractId/siteId 必填");
    }
    if (!(input.amount >= 0) || !input.currency) {
      throw new ServiceError("invalid_request", 400, "预估金额与币种必填且不能为负");
    }
    const recordedAt = new Date();
    const startedAt = input.startedAt ? parseTime(input.startedAt, "startedAt") : recordedAt;
    if (startedAt > recordedAt) {
      throw new ServiceError("invalid_started_at", 400, "事件发生时刻不能晚于当前时刻");
    }
    const offline = input.startedAt != null && startedAt.getTime() < recordedAt.getTime() - 5_000;
    const atIso = startedAt.toISOString();
    const hash = requestHash({
      sessionId: input.sessionId,
      contractId: input.contractId,
      siteId: input.siteId,
      accountId: input.accountId ?? null,
      vehicleModel: input.vehicleModel ?? null,
      amount: round2(input.amount),
      currency: input.currency,
      // 仅离线补传显式给定时纳入发生时刻；在线启动用当前时刻，不进哈希，保证重放稳定
      startedAt: input.startedAt ? atIso : null,
    });

    const txBody = () => {
      // 1) 幂等：相同启动请求返回原占用；同键异文冲突
      const existing = this.db.prepare("SELECT * FROM sessions WHERE idempotency_key=?")
        .get(input.idempotencyKey) as SessionRow | undefined;
      if (existing) {
        if (existing.request_hash === hash && existing.session_id === input.sessionId) {
          this.logAdmission(input.sessionId, "replay", "idempotent_replay", existing, atIso);
          return this.sessionView(existing);
        }
        throw new AdmissionRollback(
          {
            sessionId: input.sessionId, hash, decision: "conflict",
            reason: "idempotency_key_payload_mismatch",
            contractId: existing.contract_id, contractVersion: existing.contract_version,
            fxVersion: existing.fx_version, occurredAt: atIso,
            detail: { storedSessionId: existing.session_id },
          },
          new ServiceError("idempotency_conflict", 409,
            "幂等键已用于不同的启动请求（同键异文）", { idempotencyKey: input.idempotencyKey }),
        );
      }
      const sameSession = this.db.prepare("SELECT 1 FROM sessions WHERE session_id=?").get(input.sessionId);
      if (sameSession) {
        throw new AdmissionRollback(
          {
            sessionId: input.sessionId, hash, decision: "conflict", reason: "session_id_exists",
            contractId: null, contractVersion: null, fxVersion: null, occurredAt: atIso, detail: null,
          },
          new ServiceError("session_exists", 409, `会话 ${input.sessionId} 已存在但幂等键不同`),
        );
      }

      // 2) 冻结所见合同版本
      const version = this.db.prepare(
        `SELECT * FROM contract_versions
         WHERE contract_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)
         ORDER BY version DESC LIMIT 1`,
      ).get(input.contractId, atIso, atIso) as ContractVersionRow | undefined;
      if (!version) this.deny(input, atIso, hash, "no_active_contract_version", "发生时刻无生效合同版本");

      // 3) 合同是否在发生时刻被暂停（同时冻结所见生命周期序号，供在途变化检测）
      const lifecycle = this.db.prepare(
        "SELECT action, seq FROM contract_lifecycle WHERE contract_id=? AND occurred_at<=? ORDER BY seq DESC LIMIT 1",
      ).get(input.contractId, atIso) as { action: string; seq: number } | undefined;
      if (lifecycle?.action === "suspend") {
        this.deny(input, atIso, hash, "contract_suspended", "合同在事件发生时刻处于暂停状态");
      }

      // 4) 版本白名单（冻结）+ 站点资格（按发生时刻）
      const sites = this.db.prepare(
        "SELECT site_id FROM contract_version_sites WHERE contract_id=? AND version=?",
      ).all(input.contractId, version!.version).map((r: any) => r.site_id as string);
      if (!sites.includes("*") && !sites.includes(input.siteId)) {
        this.deny(input, atIso, hash, "site_not_whitelisted", `站点 ${input.siteId} 不在合同版本白名单`, {
          whitelist: sites,
        });
      }
      const siteEvent = this.db.prepare(
        "SELECT action, seq FROM site_eligibility_events WHERE site_id=? AND occurred_at<=? ORDER BY seq DESC LIMIT 1",
      ).get(input.siteId, atIso) as { action: string; seq: number } | undefined;
      if (siteEvent?.action === "disqualify") {
        this.deny(input, atIso, hash, "site_disqualified", "站点在事件发生时刻已丧失资格");
      }
      const frozenLifecycleSeq = lifecycle?.seq ?? null;
      const frozenSiteSeq = siteEvent?.seq ?? null;

      // 5) 车型 / 账户范围
      this.assertScope(input.contractId, version!.version, "vehicle_model", input.vehicleModel, () =>
        this.deny(input, atIso, hash, "vehicle_model_out_of_scope", `车型 ${input.vehicleModel ?? "（未提供）"} 不在合同范围`));
      this.assertScope(input.contractId, version!.version, "account", input.accountId, () =>
        this.deny(input, atIso, hash, "account_out_of_scope", `账户 ${input.accountId ?? "（未提供）"} 不在合同范围`));

      // 6) 冻结汇率版本
      let fxVersion: number | null = null;
      let fxRate = 1;
      if (input.currency !== version!.currency) {
        const fx = this.db.prepare(
          `SELECT rowid AS vid, rate FROM fx_rate_versions
           WHERE base_currency=? AND quote_currency=? AND effective_at<=?
           ORDER BY effective_at DESC LIMIT 1`,
        ).get(input.currency, version!.currency, atIso) as { vid: number; rate: number } | undefined;
        if (!fx) {
          this.deny(input, atIso, hash, "fx_rate_unavailable",
            `缺少 ${input.currency}->${version!.currency} 在发生时刻可用的汇率版本`);
        }
        fxVersion = fx!.vid;
        fxRate = fx!.rate;
      }

      // 7) 冻结担保（发生时刻有效，币种须与合同一致），担保总额须覆盖本次预估占用
      const guarantees = this.db.prepare(
        `SELECT guarantee_id, amount FROM guarantees
         WHERE contract_id=? AND currency=?
           AND created_at<=? AND (withdrawn_at IS NULL OR withdrawn_at>?) AND status='active'`,
      ).all(input.contractId, version!.currency, atIso, atIso) as { guarantee_id: string; amount: number }[];
      const guaranteeTotal = round2(guarantees.reduce((s, g) => s + g.amount, 0));

      // 8) 离线屏障：按发生时刻判断，但不得越过该时刻之后已签署的结算。
      //    若事件所属账期已在事件发生之后被签署锁定，补录会改变已清分账期 → 拒绝。
      const dKey = dayKey(startedAt);
      const pKey = periodKey(startedAt);
      const barrier = this.db.prepare(
        `SELECT settlement_id FROM settlements
         WHERE contract_id=? AND period_key=? AND status='signed' AND signed_at>? LIMIT 1`,
      ).get(input.contractId, pKey, atIso);
      if (barrier) {
        this.deny(input, atIso, hash, "settlement_barrier",
          "事件所属账期存在发生时刻之后签署的结算，离线事件不可越过已签署结算", { periodKey: pKey });
      }

      // 9) 额度：单日/账期已用量按台账净额汇总（过期占用已由释放分录冲平）
      const holdAmount = convert(input.amount, fxRate);
      if (guaranteeTotal < holdAmount) {
        this.deny(input, atIso, hash, "guarantee_insufficient",
          `有效担保 ${guaranteeTotal} 不足以覆盖预估占用 ${holdAmount}`, { guaranteeTotal, holdAmount });
      }
      const usedDay = this.windowUsage(input.contractId, version!.currency, dKey);
      const usedPeriod = this.windowUsage(input.contractId, version!.currency, pKey);
      const extraDay = this.exemptionTotal(input.contractId, version!.currency, dKey, null);
      const extraPeriod = this.exemptionTotal(input.contractId, version!.currency, pKey, null);

      const capDay = round2(version!.daily_limit + extraDay);
      const capPeriod = round2(version!.period_limit + extraPeriod);
      const overDay = round2(usedDay + holdAmount - capDay);
      const overPeriod = round2(usedPeriod + holdAmount - capPeriod);

      let exemptionId: string | null = null;
      if (overDay > 0 || overPeriod > 0) {
        // 超额：仅当请求携带且与合同声明一致的授权人时，按缺口写入会话级豁免后放行
        if (!version!.overage_approver || input.approvedBy !== version!.overage_approver) {
          this.deny(input, atIso, hash, "quota_exceeded",
            "占用将突破单日或账期上限，且缺少与合同声明一致的超额授权", {
              usedDay, capDay, overDay, usedPeriod, capPeriod, overPeriod,
              requiredApprover: version!.overage_approver ?? null,
            });
        }
        exemptionId = uuid();
        this.db.prepare(
          `INSERT INTO exemptions(exemption_id, contract_id, currency, session_id, day_key, period_key,
             extra_daily, extra_period, approver, reason, source, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'review', ?)`,
        ).run(
          exemptionId, input.contractId, version!.currency, input.sessionId,
          dKey, pKey, Math.max(overDay, 0), Math.max(overPeriod, 0),
          input.approvedBy!, "启动时超额授权自动提额", nowIso(),
        );
      }

      // 10) 建账：会话 + 有期限占用 + 台账分录 + 放行事件，同一事务提交
      const now = nowIso();
      const holdId = uuid();
      const ttlMs = (input.holdTtlSeconds ?? 4 * 3600) * 1000;
      const expiresAt = new Date(recordedAt.getTime() + ttlMs).toISOString();
      this.db.prepare(
        `INSERT INTO sessions(session_id, idempotency_key, contract_id, contract_version, site_id,
           account_id, vehicle_model, amount_currency, fx_version, fx_rate, day_key, period_key,
           event_started_at, recorded_started_at, offline, estimated_amount, held_amount, status,
           frozen_guarantee_ids, frozen_lifecycle_seq, frozen_site_seq, request_hash, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.sessionId, input.idempotencyKey, input.contractId, version!.version, input.siteId,
        input.accountId ?? null, input.vehicleModel ?? null, input.currency, fxVersion, fxRate,
        dKey, pKey, atIso, now, offline ? 1 : 0, round2(input.amount), holdAmount,
        JSON.stringify(guarantees.map((g) => g.guarantee_id)),
        frozenLifecycleSeq, frozenSiteSeq,
        hash, now, now,
      );
      this.db.prepare(
        `INSERT INTO holds(hold_id, session_id, contract_id, currency, initial_amount, amount,
           status, expires_at, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)`,
      ).run(holdId, input.sessionId, input.contractId, version!.currency, holdAmount, holdAmount,
        expiresAt, now, now);
      this.postLedger("hold", holdAmount, input.sessionId, holdId, dKey, pKey, input.contractId,
        version!.currency, "会话准入占用");
      this.logAdmission(input.sessionId, "admit", null, {
        contract_id: input.contractId,
        contract_version: version!.version,
        fx_version: fxVersion,
      } as SessionRow, atIso, {
        holdId, holdAmount, fxVersion, fxRate,
        dayKey: dKey, periodKey: pKey, exemptionId,
        usedDay, usedPeriod, offline,
      });
      return this.sessionView(input.sessionId);
    };

    try {
      return withImmediate(this.db, txBody);
    } catch (err) {
      // 事务回滚后单独持久化准入事件（拒绝/冲突），保证每次尝试都可追溯
      if (err instanceof AdmissionRollback) {
        this.persistAdmissionEvent(err.event);
        throw err.serviceError;
      }
      throw err;
    }
  }

  private persistAdmissionEvent(event: PendingAdmissionEvent) {
    const write = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO admission_events(session_id, request_hash, decision, reason, contract_id,
           contract_version, fx_version, occurred_at, evaluated_at, detail)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.sessionId, event.hash, event.decision, event.reason,
        event.contractId, event.contractVersion, event.fxVersion,
        event.occurredAt, nowIso(), event.detail ? JSON.stringify(event.detail) : null,
      );
    });
    write();
  }

  /** 拒绝：构造待持久化事件并中止事务；由 startSession 在回滚后写事件，再抛对外错误。 */
  private deny(
    input: StartSessionInput, atIso: string, hash: string,
    reason: string, message: string, detail?: unknown,
  ): never {
    const v = this.db.prepare(
      "SELECT version FROM contract_versions WHERE contract_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) ORDER BY version DESC LIMIT 1",
    ).get(input.contractId, atIso, atIso) as { version: number } | undefined;
    throw new AdmissionRollback(
      {
        sessionId: input.sessionId, hash, decision: "reject", reason,
        contractId: input.contractId, contractVersion: v?.version ?? null, fxVersion: null,
        occurredAt: atIso, detail,
      },
      new ServiceError(reason, 422, message, { sessionId: input.sessionId, ...(detail as object ?? {}) }),
    );
  }

  private assertScope(
    contractId: string, version: number, scopeType: string,
    value: string | undefined, onMiss: () => never,
  ) {
    const rows = this.db.prepare(
      "SELECT scope_value FROM contract_version_scopes WHERE contract_id=? AND version=? AND scope_type=?",
    ).all(contractId, version, scopeType).map((r: any) => r.scope_value as string);
    if (rows.includes("*")) return;
    if (value && rows.includes(value)) return;
    onMiss();
  }

  private windowUsage(contractId: string, currency: string, key: string): number {
    const col = key.length === 10 ? "day_key" : "period_key";
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS used FROM quota_ledger
       WHERE contract_id=? AND currency=? AND ${col}=?`,
    ).get(contractId, currency, key) as { used: number };
    return round2(row.used);
  }

  private exemptionTotal(
    contractId: string, currency: string, key: string, sessionId: string | null,
  ): number {
    const col = key.length === 10 ? "day_key" : "period_key";
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(extra_${col === "day_key" ? "daily" : "period"}), 0) AS extra
       FROM exemptions
       WHERE contract_id=? AND currency=?
         AND ((${col}=?) OR (session_id IS NOT NULL AND session_id=?))`,
    ).get(contractId, currency, key, sessionId) as { extra: number };
    return round2(row.extra);
  }

  private postLedger(
    type: string, amount: number, sessionId: string, holdId: string,
    dKey: string, pKey: string, contractId: string, currency: string, note: string,
  ) {
    this.db.prepare(
      `INSERT INTO quota_ledger(contract_id, currency, day_key, period_key, session_id, hold_id,
         entry_type, amount, created_at, note)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(contractId, currency, dKey, pKey, sessionId, holdId, type, amount, nowIso(), note);
  }

  private logAdmission(
    sessionId: string, decision: string, reason: string | null,
    session?: SessionRow | { contract_id: string; contract_version: number; fx_version: number | null },
    occurredAt?: string, detail?: unknown,
  ) {
    const s = session as SessionRow | undefined;
    this.db.prepare(
      `INSERT INTO admission_events(session_id, request_hash, decision, reason, contract_id,
         contract_version, fx_version, occurred_at, evaluated_at, detail)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId, s?.request_hash ?? null, decision, reason,
      s?.contract_id ?? null, s?.contract_version ?? null, s?.fx_version ?? null,
      occurredAt ?? null, nowIso(), detail ? JSON.stringify(detail) : null,
    );
  }

  // ---- 计量片段：逐步调整占用 ----

  addFragment(sessionId: string, input: FragmentInput) {
    return withImmediate(this.db, () => {
      const session = this.requireActiveSession(sessionId);
      const hold = this.db.prepare("SELECT * FROM holds WHERE session_id=?").get(sessionId) as
        | { hold_id: string; amount: number; status: string; currency: string; contract_id: string }
        | undefined;
      if (!hold || hold.status === "expired") {
        throw new ServiceError("hold_expired", 409,
          "占用已过期释放，计量片段不能再调整该会话；请结束会话并按复核流程处理");
      }
      const existing = this.db.prepare(
        "SELECT amount, currency FROM meter_fragments WHERE session_id=? AND fragment_id=?",
      ).get(sessionId, input.fragmentId) as { amount: number; currency: string } | undefined;
      if (existing) {
        if (existing.amount !== input.amount || existing.currency !== input.currency) {
          throw new ServiceError("fragment_conflict", 409, `片段 ${input.fragmentId} 同 ID 异文`);
        }
        return { sessionId, fragmentId: input.fragmentId, replayed: true };
      }
      if (input.currency !== session.amount_currency) {
        throw new ServiceError("currency_mismatch", 400, "片段币种须与启动报送币种一致（汇率已冻结）");
      }
      const prev = this.db.prepare(
        "SELECT MAX(seq) AS seq, amount FROM meter_fragments WHERE session_id=? ORDER BY seq DESC LIMIT 1",
      ).get(sessionId) as { seq: number | null; amount: number | null };
      if (prev.seq != null && input.seq <= prev.seq) {
        throw new ServiceError("fragment_out_of_order", 400, `片段序号须递增，已有最大序号 ${prev.seq}`);
      }
      if (prev.amount != null && input.amount < prev.amount) {
        throw new ServiceError("fragment_regression", 400, "累计计量金额不能回退");
      }
      const now = nowIso();
      this.db.prepare(
        `INSERT INTO meter_fragments(fragment_id, session_id, seq, observed_at, amount, currency, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.fragmentId, sessionId, input.seq,
        parseTime(input.observedAt, "observedAt").toISOString(), round2(input.amount), input.currency, now);

      const target = convert(input.amount, session.fx_rate);
      const delta = round2(target - hold.amount);
      if (delta !== 0) {
        this.db.prepare("UPDATE holds SET amount=?, updated_at=? WHERE hold_id=?")
          .run(target, now, hold.hold_id);
        this.db.prepare("UPDATE sessions SET held_amount=?, updated_at=? WHERE session_id=?")
          .run(target, now, sessionId);
        this.postLedger("adjust", delta, sessionId, hold.hold_id, session.day_key, session.period_key,
          hold.contract_id, hold.currency, `片段 ${input.fragmentId} 调整占用`);
        this.raiseQuotaReviewIfNeeded(session, target);
      }
      return { sessionId, fragmentId: input.fragmentId, heldAmount: target, delta };
    });
  }

  /** 进行中超额不静默中止，也不拒绝计量，而是挂入风险复核。 */
  private raiseQuotaReviewIfNeeded(session: SessionRow, held: number) {
    const currency = this.sessionCurrency(session);
    const version = this.db.prepare(
      "SELECT daily_limit, period_limit FROM contract_versions WHERE contract_id=? AND version=?",
    ).get(session.contract_id, session.contract_version) as { daily_limit: number; period_limit: number };
    const usedDay = this.windowUsage(session.contract_id, currency, session.day_key);
    const usedPeriod = this.windowUsage(session.contract_id, currency, session.period_key);
    const dayExtra = this.exemptionTotal(session.contract_id, currency, session.day_key, session.session_id);
    const periodExtra = this.exemptionTotal(session.contract_id, currency, session.period_key, session.session_id);
    if (usedDay > round2(version.daily_limit + dayExtra) ||
        usedPeriod > round2(version.period_limit + periodExtra)) {
      this.db.prepare(
        `INSERT OR IGNORE INTO risk_reviews(review_id, session_id, reason, status, detail, detected_at)
         VALUES(?, ?, 'quota_exceeded', 'pending', ?, ?)`,
      ).run(uuid(), session.session_id, JSON.stringify({ held, usedDay, usedPeriod }), nowIso());
    }
  }

  private sessionCurrency(session: SessionRow): string {
    const hold = this.db.prepare("SELECT currency FROM holds WHERE session_id=?").get(session.session_id) as
      | { currency: string }
      | undefined;
    return hold?.currency ?? this.holdCurrency(session);
  }

  // ---- 会话结束：结转真实金额，释放剩余量 ----

  endSession(sessionId: string, input: EndSessionInput) {
    return withImmediate(this.db, () => {
      const session = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId) as
        | SessionRow
        | undefined;
      if (!session) throw new ServiceError("session_not_found", 404, `会话 ${sessionId} 不存在`);
      if (session.status === "completed") {
        return { sessionId, replayed: true, settlementId: session.settlement_id,
          capturedAmount: session.captured_amount };
      }
      if (input.currency !== session.amount_currency) {
        throw new ServiceError("currency_mismatch", 400, "结算币种须与启动报送币种一致（汇率已冻结）");
      }
      if (!(input.amount >= 0)) throw new ServiceError("invalid_amount", 400, "结算金额不能为负");

      const hold = this.db.prepare("SELECT * FROM holds WHERE session_id=?").get(sessionId) as
        | { hold_id: string; amount: number; status: string; currency: string }
        | undefined;
      const actual = convert(input.amount, session.fx_rate);
      const now = nowIso();
      const outstanding = hold && hold.status !== "expired" ? hold.amount : 0;
      const delta = round2(actual - outstanding);
      if (hold && hold.status !== "expired") {
        if (delta !== 0) {
          this.postLedger("capture", delta, sessionId, hold.hold_id, session.day_key,
            session.period_key, session.contract_id, hold.currency, "结束结转真实金额");
        }
        this.db.prepare(
          "UPDATE holds SET status='captured', amount=?, captured_at=?, updated_at=? WHERE hold_id=?",
        ).run(actual, now, now, hold.hold_id);
      } else {
        // 占用此前已过期释放：按真实金额重新入账一笔 capture，台账净额即真实消费
        this.postLedger("capture", actual, sessionId, hold?.hold_id ?? "expired", session.day_key,
          session.period_key, session.contract_id, this.holdCurrency(session),
          "过期释放后结束，按真实金额入账");
      }

      const settlementId = uuid();
      const currency = hold?.currency ?? this.holdCurrency(session);
      this.db.prepare(
        `INSERT INTO settlements(settlement_id, contract_id, session_id, day_key, period_key,
           amount, currency, status, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      ).run(settlementId, session.contract_id, sessionId, session.day_key, session.period_key,
        actual, currency, now);
      this.db.prepare(
        `UPDATE sessions SET status='completed', held_amount=?, captured_amount=?, settlement_id=?,
           ended_at=?, updated_at=? WHERE session_id=?`,
      ).run(actual, actual, settlementId,
        input.endedAt ? parseTime(input.endedAt, "endedAt").toISOString() : now, now, sessionId);
      return {
        sessionId, settlementId, capturedAmount: actual, currency,
        releasedAmount: Math.max(0, round2(outstanding - actual)),
        holdWasExpired: outstanding === 0 && hold?.status === "expired",
      };
    });
  }

  private holdCurrency(session: SessionRow): string {
    const v = this.db.prepare("SELECT currency FROM contract_versions WHERE contract_id=? AND version=?")
      .get(session.contract_id, session.contract_version) as { currency: string };
    return v.currency;
  }

  /** 签署结算：签署后成为离线补传不可越过的屏障。 */
  signSettlement(settlementId: string, signedBy: string) {
    const s = this.db.prepare("SELECT * FROM settlements WHERE settlement_id=?").get(settlementId) as
      | { status: string; session_id: string }
      | undefined;
    if (!s) throw new ServiceError("settlement_not_found", 404, `结算 ${settlementId} 不存在`);
    if (s.status === "signed") throw new ServiceError("settlement_signed", 409, "结算已签署");
    const now = nowIso();
    this.db.prepare("UPDATE settlements SET status='signed', signed_at=?, signed_by=? WHERE settlement_id=?")
      .run(now, signedBy, settlementId);
    return { settlementId, signedAt: now, signedBy };
  }

  // ---- 风险复核 ----

  resolveReview(reviewId: string, status: "waived" | "rejected", resolver: string, note?: string) {
    const r = this.db.prepare("SELECT * FROM risk_reviews WHERE review_id=?").get(reviewId) as
      | { status: string; session_id: string }
      | undefined;
    if (!r) throw new ServiceError("review_not_found", 404, `复核任务 ${reviewId} 不存在`);
    if (r.status !== "pending") throw new ServiceError("review_resolved", 409, "复核任务已处理");
    const now = nowIso();
    this.db.prepare(
      "UPDATE risk_reviews SET status=?, resolved_at=?, resolver=?, resolution_note=? WHERE review_id=?",
    ).run(status, now, resolver, note ?? null, reviewId);
    return { reviewId, sessionId: r.session_id, status, resolvedAt: now };
  }

  /**
   * 扫描进行中会话：其启动时冻结的前提（合同状态/担保/站点资格）此后是否已变化。
   * 变化只产生待复核任务，绝不静默中止会话。可重复调用（按 会话+原因 去重）。
   */
  detectReviews() {
    const created: { sessionId: string; reason: string; detail: unknown }[] = [];
    const sessions = this.db.prepare(
      "SELECT * FROM sessions WHERE status='in_progress'",
    ).all() as SessionRow[];
    for (const s of sessions) {
      const open = (reason: string, detail: unknown) => {
        const info = this.db.prepare(
          `INSERT OR IGNORE INTO risk_reviews(review_id, session_id, reason, status, detail, detected_at)
           VALUES(?, ?, ?, 'pending', ?, ?)`,
        ).run(uuid(), s.session_id, reason, JSON.stringify(detail), nowIso());
        if (info.changes > 0) created.push({ sessionId: s.session_id, reason, detail });
      };

      // 启动冻结序号之后出现暂停（含短暂暂停后恢复），即进行中前提已变化
      const suspendedAfter = this.db.prepare(
        `SELECT seq, occurred_at FROM contract_lifecycle
         WHERE contract_id=? AND seq>? AND action='suspend' ORDER BY seq DESC LIMIT 1`,
      ).get(s.contract_id, s.frozen_lifecycle_seq ?? 0) as
        | { seq: number; occurred_at: string }
        | undefined;
      if (suspendedAfter) {
        open("contract_suspended", { suspendedAt: suspendedAfter.occurred_at });
      }

      // 启动时冻结的担保此后被撤回
      const frozen: string[] = JSON.parse(s.frozen_guarantee_ids);
      for (const gid of frozen) {
        const g = this.db.prepare(
          "SELECT status, withdrawn_at FROM guarantees WHERE guarantee_id=?",
        ).get(gid) as { status: string; withdrawn_at: string | null } | undefined;
        if (g?.status === "withdrawn") open("guarantee_withdrawn", { guaranteeId: gid, withdrawnAt: g.withdrawn_at });
      }

      // 启动冻结序号之后站点被取消资格
      const disqualifiedAfter = this.db.prepare(
        `SELECT seq, occurred_at FROM site_eligibility_events
         WHERE site_id=? AND seq>? AND action='disqualify' ORDER BY seq DESC LIMIT 1`,
      ).get(s.site_id, s.frozen_site_seq ?? 0) as
        | { seq: number; occurred_at: string }
        | undefined;
      if (disqualifiedAfter) {
        open("site_disqualified", { siteId: s.site_id, disqualifiedAt: disqualifiedAfter.occurred_at });
      }
    }
    return created;
  }

  // ---- 过期释放与重启恢复 ----

  /**
   * 过期占用释放：到期未结束的占用冲减台账（净额归零），占用置 expired，
   * 会话转入风险复核而非静默消失。服务启动与定时清扫都会调用，故重启后继续释放。
   */
  expireHolds(at = new Date()) {
    const expired: { sessionId: string; holdId: string; amount: number }[] = [];
    const rows = this.db.prepare(
      `SELECT h.* FROM holds h JOIN sessions s ON s.session_id=h.session_id
       WHERE h.status='held' AND h.expires_at<=?`,
    ).all(at.toISOString()) as {
      hold_id: string; session_id: string; amount: number;
      currency: string; contract_id: string; expires_at: string;
    }[];
    const apply = this.db.transaction(() => {
      for (const h of rows) {
        const s = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(h.session_id) as SessionRow;
        if (s.status !== "in_progress") continue;
        this.postLedger("expire", -h.amount, h.session_id, h.hold_id, s.day_key, s.period_key,
          h.contract_id, h.currency, "占用到期释放");
        this.db.prepare("UPDATE holds SET status='expired', updated_at=? WHERE hold_id=?")
          .run(nowIso(), h.hold_id);
        this.db.prepare("UPDATE sessions SET held_amount=0, updated_at=? WHERE session_id=?")
          .run(nowIso(), h.session_id);
        this.db.prepare(
          `INSERT OR IGNORE INTO risk_reviews(review_id, session_id, reason, status, detail, detected_at)
           VALUES(?, ?, 'hold_expired', 'pending', ?, ?)`,
        ).run(uuid(), h.session_id, JSON.stringify({ holdId: h.hold_id, expiresAt: h.expires_at }), nowIso());
        expired.push({ sessionId: h.session_id, holdId: h.hold_id, amount: h.amount });
      }
    });
    apply();
    return expired;
  }

  /** 重启恢复：先补过期释放，再补在途前提变化的复核任务。 */
  recoverOnStartup() {
    const expired = this.expireHolds();
    const detected = this.detectReviews();
    return {
      expired,
      reviews: [
        ...expired.map((e) => ({ sessionId: e.sessionId, reason: "hold_expired" })),
        ...detected,
      ],
    };
  }

  /** 周期性清扫（过期释放 + 待复核发现）。 */
  runSweepers() {
    return this.recoverOnStartup();
  }

  // ---- 查询：全链路追溯 ----

  private requireActiveSession(sessionId: string): SessionRow {
    const s = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId) as
      | SessionRow
      | undefined;
    if (!s) throw new ServiceError("session_not_found", 404, `会话 ${sessionId} 不存在`);
    if (s.status !== "in_progress") {
      throw new ServiceError("session_not_active", 409, `会话当前状态 ${s.status}，不可再写计量`);
    }
    return s;
  }

  private sessionView(id: string | SessionRow) {
    const s = typeof id === "string"
      ? this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(id) as SessionRow
      : id;
    const hold = this.db.prepare("SELECT * FROM holds WHERE session_id=?").get(s.session_id) as
      | Record<string, unknown>
      | undefined;
    return {
      sessionId: s.session_id,
      idempotencyKey: s.idempotency_key,
      status: s.status,
      contractId: s.contract_id,
      contractVersion: s.contract_version,
      siteId: s.site_id,
      accountId: s.account_id,
      vehicleModel: s.vehicle_model,
      dayKey: s.day_key,
      periodKey: s.period_key,
      eventStartedAt: s.event_started_at,
      recordedStartedAt: s.recorded_started_at,
      offline: !!s.offline,
      fx: s.fx_version == null ? null : { version: s.fx_version, rate: s.fx_rate },
      estimatedAmount: s.estimated_amount,
      heldAmount: s.held_amount,
      capturedAmount: s.captured_amount,
      frozenGuaranteeIds: JSON.parse(s.frozen_guarantee_ids),
      hold: hold ? {
        holdId: hold.hold_id,
        amount: hold.amount,
        status: hold.status,
        expiresAt: hold.expires_at,
      } : null,
      settlementId: s.settlement_id,
    };
  }

  /** 从一次拒绝或放行追到合同条款、额度变化、人工豁免与最终结算去向。 */
  traceSession(sessionId: string) {
    const s = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId) as
      | SessionRow
      | undefined;
    if (!s) {
      // 被拒会话没有 session 行，但 admission_events 仍可追溯
      const events = this.db.prepare(
        "SELECT * FROM admission_events WHERE session_id=? ORDER BY event_id",
      ).all(sessionId);
      if (events.length === 0) {
        throw new ServiceError("session_not_found", 404, `未找到会话或准入事件 ${sessionId}`);
      }
      return { sessionId, admitted: false, admissionEvents: events.map(this.mapAdmission) };
    }
    const version = this.db.prepare(
      "SELECT * FROM contract_versions WHERE contract_id=? AND version=?",
    ).get(s.contract_id, s.contract_version) as Record<string, unknown>;
    const sites = this.db.prepare(
      "SELECT site_id FROM contract_version_sites WHERE contract_id=? AND version=?",
    ).all(s.contract_id, s.contract_version).map((r: any) => r.site_id);
    const scopes = this.db.prepare(
      "SELECT scope_type, scope_value FROM contract_version_scopes WHERE contract_id=? AND version=?",
    ).all(s.contract_id, s.contract_version);
    const frozen: string[] = JSON.parse(s.frozen_guarantee_ids);
    const guarantees = frozen.length
      ? this.db.prepare(
          `SELECT guarantee_id, amount, currency, status, withdrawn_at FROM guarantees
           WHERE guarantee_id IN (${frozen.map(() => "?").join(",")})`,
        ).all(...frozen)
      : [];
    const ledger = this.db.prepare(
      "SELECT * FROM quota_ledger WHERE session_id=? ORDER BY ledger_id",
    ).all(sessionId);
    const exemptions = this.db.prepare(
      "SELECT * FROM exemptions WHERE session_id=? OR (contract_id=? AND (day_key=? OR period_key=?)) ORDER BY created_at",
    ).all(sessionId, s.contract_id, s.day_key, s.period_key);
    const reviews = this.db.prepare(
      "SELECT * FROM risk_reviews WHERE session_id=? ORDER BY detected_at",
    ).all(sessionId);
    const fragments = this.db.prepare(
      "SELECT * FROM meter_fragments WHERE session_id=? ORDER BY seq",
    ).all(sessionId);
    const settlement = s.settlement_id
      ? this.db.prepare("SELECT * FROM settlements WHERE settlement_id=?").get(s.settlement_id)
      : null;
    const events = this.db.prepare(
      "SELECT * FROM admission_events WHERE session_id=? ORDER BY event_id",
    ).all(sessionId);

    return {
      sessionId,
      admitted: true,
      session: this.sessionView(s),
      frozenContract: {
        ...this.mapVersion(version),
        sites,
        scopes: scopes.map((r: any) => ({ type: r.scope_type, value: r.scope_value })),
      },
      frozenGuarantees: guarantees,
      fragments: fragments.map((f: any) => ({
        fragmentId: f.fragment_id, seq: f.seq, observedAt: f.observed_at,
        amount: f.amount, currency: f.currency,
      })),
      quotaLedger: ledger.map((l: any) => ({
        type: l.entry_type, amount: l.amount, dayKey: l.day_key, periodKey: l.period_key,
        at: l.created_at, note: l.note,
      })),
      exemptions: exemptions.map((e: any) => ({
        exemptionId: e.exemption_id, extraDaily: e.extra_daily, extraPeriod: e.extra_period,
        approver: e.approver, reason: e.reason, source: e.source, at: e.created_at,
      })),
      riskReviews: reviews.map((r: any) => ({
        reviewId: r.review_id, reason: r.reason, status: r.status, detail: safeJson(r.detail),
        detectedAt: r.detected_at, resolvedAt: r.resolved_at, resolver: r.resolver,
        resolutionNote: r.resolution_note,
      })),
      settlement: settlement ? {
        settlementId: (settlement as any).settlement_id,
        status: (settlement as any).status,
        amount: (settlement as any).amount,
        currency: (settlement as any).currency,
        signedAt: (settlement as any).signed_at,
        signedBy: (settlement as any).signed_by,
      } : null,
      admissionEvents: events.map(this.mapAdmission),
    };
  }

  private mapVersion(v: Record<string, unknown>) {
    return {
      contractId: v.contract_id,
      version: v.version,
      partnerId: v.partner_id,
      currency: v.currency,
      dailyLimit: v.daily_limit,
      periodLimit: v.period_limit,
      overageApprover: v.overage_approver,
      validFrom: v.valid_from,
      validTo: v.valid_to,
      publishedAt: v.published_at,
    };
  }

  private mapAdmission(e: any) {
    return {
      decision: e.decision,
      reason: e.reason,
      contractId: e.contract_id,
      contractVersion: e.contract_version,
      fxVersion: e.fx_version,
      occurredAt: e.occurred_at,
      evaluatedAt: e.evaluated_at,
      detail: safeJson(e.detail),
    };
  }

  listPendingReviews() {
    return this.db.prepare(
      "SELECT * FROM risk_reviews WHERE status='pending' ORDER BY detected_at",
    ).all().map((r: any) => ({
      reviewId: r.review_id, sessionId: r.session_id, reason: r.reason,
      detail: safeJson(r.detail), detectedAt: r.detected_at,
    }));
  }
}

function safeJson(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}
