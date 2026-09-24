import type { DB } from "./db.js";
import { contractVersionAt } from "./catalog.js";
import { appendLedger, catchupHold, getSession } from "./sessions.js";
import { HttpError, resolveTime } from "./time.js";

export interface ExemptionInput {
  contractId: string;
  kind: "overage" | "risk_resume";
  amount?: number;
  approver: string;
  note?: string;
  scope: { type: "session" | "day" | "period"; value: string };
  eventTime?: string;
}

interface ReviewRow {
  id: number;
  session_id: string;
  reason: string;
  detail: string | null;
  status: "open" | "exempted" | "aborted";
  detected_event_time: string;
}

/**
 * 授予人工豁免 / 超额授权。
 * overage 必须由会话所见合同版本声明的 overage_approver 签发；
 * 额度不直接写台账，而是作为 cap 之上的授权余量参与准入与计量判定，可全程追溯。
 */
export function grantExemption(db: DB, raw: ExemptionInput): number {
  const at = resolveTime(raw.eventTime);
  const amount = raw.amount ?? 0;
  if (!Number.isInteger(amount) || amount < 0) {
    throw new HttpError(400, "invalid_amount", "授权额度必须为非负整数");
  }
  if (!raw.approver) throw new HttpError(400, "approver_required", "豁免必须记录授权人");
  if (raw.scope.type === "day" && !/^\d{4}-\d{2}-\d{2}$/.test(raw.scope.value)) {
    throw new HttpError(400, "invalid_scope", "day 作用域必须为 YYYY-MM-DD");
  }
  if (raw.scope.type === "period" && !/^\d{4}-\d{2}$/.test(raw.scope.value)) {
    throw new HttpError(400, "invalid_scope", "period 作用域必须为 YYYY-MM");
  }

  const tx = db.transaction((): number => {
    const contract = db.prepare("SELECT 1 FROM contracts WHERE contract_id = ?").get(raw.contractId);
    if (!contract) throw new HttpError(404, "contract_not_found", `合同不存在：${raw.contractId}`);

    if (raw.kind === "overage") {
      const version = contractVersionAt(db, raw.contractId, at);
      if (!version || !version.overage_approver) {
        throw new HttpError(403, "overage_not_configured", "当前合同版本未声明超额授权人");
      }
      if (version.overage_approver !== raw.approver) {
        throw new HttpError(403, "approver_unauthorized", "授权人与合同声明的超额授权人不符", {
          requiredApprover: version.overage_approver,
          versionTag: version.version_tag,
        });
      }
    }

    const info = db
      .prepare(
        `INSERT INTO manual_exemptions
           (review_id, session_id, contract_id, kind, scope_type, scope_value, amount, approver, note, granted_at)
         VALUES(NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        raw.scope.type === "session" ? raw.scope.value : null,
        raw.contractId,
        raw.kind,
        raw.scope.type,
        raw.scope.value,
        amount,
        raw.approver,
        raw.note ?? null,
        at
      );
    return Number(info.lastInsertRowid);
  });
  return tx.immediate();
}

/** 列出待人工裁决的风险复核（重启后恢复队列）。 */
export function listOpenReviews(db: DB): ReviewRow[] {
  return db
    .prepare("SELECT * FROM risk_reviews WHERE status = 'open' ORDER BY id")
    .all() as ReviewRow[];
}

/**
 * 风险复核裁决：
 * - exempt：登记 risk_resume 豁免，在途会话恢复 started，并尝试把占用追补到已计量值；
 * - abort：人工确认中止，释放剩余占用（会话绝不被系统静默中止，只能由人工在此显式终止）。
 */
export function resolveReview(
  db: DB,
  input: { reviewId: number; action: "exempt" | "abort"; approver: string; note?: string; eventTime?: string }
): ReviewRow {
  const at = resolveTime(input.eventTime);
  const tx = db.transaction((): ReviewRow => {
    const review = db.prepare("SELECT * FROM risk_reviews WHERE id = ?").get(input.reviewId) as
      | ReviewRow
      | undefined;
    if (!review) throw new HttpError(404, "review_not_found", `复核单不存在：${input.reviewId}`);
    if (review.status !== "open") {
      throw new HttpError(409, "review_resolved", `复核单已裁决：${review.status}`);
    }
    if (!input.approver) throw new HttpError(400, "approver_required", "裁决必须记录操作人");

    const session = getSession(db, review.session_id);

    if (input.action === "abort") {
      if ((session.status === "started" || session.status === "risk_review") && session.held_amount !== 0) {
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
          refType: "review_abort",
          refId: String(review.id),
        });
        db.prepare(
          "UPDATE charging_sessions SET status = 'aborted', held_amount = 0, held_converted = 0 WHERE session_id = ?"
        ).run(session.session_id);
      }
    } else {
      // 放行：登记风险豁免，在途会话恢复；已完成会话只补登记，不改状态
      db
        .prepare(
          `INSERT INTO manual_exemptions
             (review_id, session_id, contract_id, kind, scope_type, scope_value, amount, approver, note, granted_at)
           VALUES(?, ?, ?, 'risk_resume', 'session', ?, 0, ?, ?, ?)`
        )
        .run(
          review.id,
          session.session_id,
          session.contract_id,
          session.session_id,
          input.approver,
          input.note ?? null,
          at
        );
      if (session.status === "risk_review") {
        db.prepare("UPDATE charging_sessions SET status = 'started' WHERE session_id = ?").run(
          session.session_id
        );
        // 豁免可能已带来超额授权：尝试把占用追补到真实计量
        catchupHold(db, session.session_id, at);
      }
    }

    db.prepare("UPDATE risk_reviews SET status = ?, resolved_at = ? WHERE id = ?").run(
      input.action === "abort" ? "aborted" : "exempted",
      at,
      review.id
    );
    return db.prepare("SELECT * FROM risk_reviews WHERE id = ?").get(input.reviewId) as ReviewRow;
  });
  return tx.immediate();
}

// ---- 追溯：一次拒绝或放行 -> 条款 / 额度变化 / 豁免 / 结算去向 ---------------

export function trace(db: DB, key: string): Record<string, unknown> {
  const decisions = db
    .prepare("SELECT * FROM admission_decisions WHERE request_key = ? ORDER BY id")
    .all(key) as Record<string, unknown>[];
  const session = db
    .prepare("SELECT * FROM charging_sessions WHERE session_id = ?")
    .get(key) as Record<string, unknown> | undefined;

  let frozenVersion: Record<string, unknown> | null = null;
  let whitelist: string[] = [];
  if (session) {
    frozenVersion = db
      .prepare("SELECT * FROM contract_versions WHERE version_id = ?")
      .get(session.version_id) as Record<string, unknown>;
    whitelist = (
      db
        .prepare("SELECT site_id FROM contract_version_sites WHERE version_id = ?")
        .all(session.version_id) as { site_id: string }[]
    ).map((r) => r.site_id);
  }

  const sessionId = session ? key : null;
  const ledger = sessionId
    ? db
        .prepare("SELECT * FROM quota_ledger WHERE session_id = ? ORDER BY id")
        .all(sessionId)
    : [];
  const segments = sessionId
    ? db
        .prepare("SELECT * FROM meter_segments WHERE session_id = ? ORDER BY segment_no")
        .all(sessionId)
    : [];
  const reviews = sessionId
    ? (db
        .prepare("SELECT * FROM risk_reviews WHERE session_id = ? ORDER BY id")
        .all(sessionId) as Record<string, unknown>[])
    : [];
  const contractId = (session?.contract_id as string | undefined) ?? "";
  const day = (session?.day_key as string | undefined) ?? "";
  const period = (session?.period_key as string | undefined) ?? "";
  const exemptions = session
    ? db
        .prepare(
          `SELECT e.* FROM manual_exemptions e
            WHERE e.session_id = ?
               OR (e.contract_id = ? AND e.scope_type = 'day' AND e.scope_value = ?)
               OR (e.contract_id = ? AND e.scope_type = 'period' AND e.scope_value = ?)`
        )
        .all(key, contractId, day, contractId, period)
    : db
        .prepare("SELECT * FROM manual_exemptions WHERE session_id = ?")
        .all(key);
  const settlement = sessionId
    ? db.prepare("SELECT * FROM settlements WHERE session_id = ?").get(sessionId)
    : null;
  const periodLock = session
    ? db
        .prepare("SELECT * FROM period_locks WHERE contract_id = ? AND period_key = ?")
        .get(session.contract_id, session.period_key)
    : null;

  return {
    key,
    decisions: decisions.map((d) => ({
      ...d,
      reasons: JSON.parse((d.reasons as string | null) ?? "[]"),
      snapshot: JSON.parse((d.snapshot as string | null) ?? "null"),
    })),
    session: session ?? null,
    frozenContractVersion: frozenVersion
      ? {
          ...frozenVersion,
          vehicle_types: JSON.parse((frozenVersion.vehicle_types as string | null) ?? "null"),
          accounts: JSON.parse((frozenVersion.accounts as string | null) ?? "null"),
          siteWhitelist: whitelist,
        }
      : null,
    quotaChanges: ledger,
    meterSegments: segments,
    riskReviews: reviews.map((r) => ({
      ...r,
      detail: JSON.parse((r.detail as string | null) ?? "{}"),
    })),
    exemptions,
    settlement,
    periodLock,
  };
}

export function sessionView(db: DB, sessionId: string): Record<string, unknown> {
  const session = getSession(db, sessionId) as unknown as Record<string, unknown>;
  const reviews = db
    .prepare("SELECT * FROM risk_reviews WHERE session_id = ? ORDER BY id")
    .all(sessionId);
  return { ...session, riskReviews: reviews };
}
