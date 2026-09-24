import type { DB } from "./db.js";
import { HttpError, resolveTime } from "./time.js";

// ---- 行类型 ---------------------------------------------------------------

export interface ContractVersion {
  version_id: number;
  contract_id: string;
  version_tag: string;
  effective_from: string;
  effective_to: string | null;
  currency: string;
  daily_limit: number;
  period_limit: number;
  overage_approver: string | null;
  vehicle_types: string | null;
  accounts: string | null;
}

export interface FxRate {
  rate_id: number;
  from_currency: string;
  to_currency: string;
  numerator: number;
  denominator: number;
  effective_from: string;
}

function jsonArray(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_scope", "范围字段必须为数组");
  return value.map(String);
}

// ---- 管理操作 -------------------------------------------------------------

export function registerPartner(db: DB, input: { partnerId: string; name: string }): void {
  db.prepare("INSERT INTO partners(partner_id, name) VALUES(?, ?)").run(input.partnerId, input.name);
}

export function registerSite(
  db: DB,
  input: { siteId: string; qualified?: boolean; occurredAt?: string }
): void {
  const at = resolveTime(input.occurredAt);
  db.prepare("INSERT INTO sites(site_id) VALUES(?)").run(input.siteId);
  db.prepare(
    "INSERT INTO site_status_events(site_id, status, occurred_at) VALUES(?, ?, ?)"
  ).run(input.siteId, input.qualified === false ? "disqualified" : "qualified", at);
}

export function createContract(
  db: DB,
  input: { contractId: string; partnerId: string; activeAt?: string }
): void {
  const at = resolveTime(input.activeAt);
  const partner = db.prepare("SELECT 1 FROM partners WHERE partner_id = ?").get(input.partnerId);
  if (!partner) throw new HttpError(404, "partner_not_found", `合作方不存在：${input.partnerId}`);
  db.prepare("INSERT INTO contracts(contract_id, partner_id) VALUES(?, ?)").run(
    input.contractId,
    input.partnerId
  );
  db.prepare(
    "INSERT INTO contract_status_events(contract_id, status, occurred_at) VALUES(?, 'active', ?)"
  ).run(input.contractId, at);
}

export interface NewVersion {
  versionTag: string;
  effectiveFrom?: string;
  currency: string;
  dailyLimit: number;
  periodLimit: number;
  overageApprover?: string | null;
  vehicleTypes?: string[] | null;
  accounts?: string[] | null;
  sites: string[];
}

/** 登记新版本；同一合同此前开放（effective_to 为空）的版本在新生效时刻关闭。 */
export function addContractVersion(db: DB, contractId: string, input: NewVersion): number {
  const from = resolveTime(input.effectiveFrom);
  const contract = db.prepare("SELECT 1 FROM contracts WHERE contract_id = ?").get(contractId);
  if (!contract) throw new HttpError(404, "contract_not_found", `合同不存在：${contractId}`);
  for (const field of ["dailyLimit", "periodLimit"] as const) {
    if (!Number.isInteger(input[field]) || (input[field] as number) < 0) {
      throw new HttpError(400, "invalid_limit", `${field} 必须为非负整数（最小货币单位）`);
    }
  }
  if (!Array.isArray(input.sites) || input.sites.length === 0) {
    throw new HttpError(400, "sites_required", "合同版本必须声明至少一个适用站点");
  }

  const tx = db.transaction(() => {
    const open = db
      .prepare(
        `SELECT version_id, version_tag, effective_from FROM contract_versions
          WHERE contract_id = ? AND effective_to IS NULL`
      )
      .get(contractId) as { version_id: number; version_tag: string; effective_from: string } | undefined;

    if (open) {
      // 版本只向前演进：新版本在当前开放版本的生效时刻之后接替
      if (from <= open.effective_from) {
        throw new HttpError(409, "version_overlap", "新版本生效时刻必须晚于当前开放版本", {
          existingVersion: open.version_tag,
        });
      }
    } else {
      // 没有开放版本时，只允许填补空白，不得与任何已关闭区间相交
      const hit = db
        .prepare(
          `SELECT version_tag FROM contract_versions
            WHERE contract_id = ? AND effective_from <= ? AND effective_to > ?`
        )
        .get(contractId, from, from);
      if (hit) {
        throw new HttpError(409, "version_overlap", "该时刻已被历史版本覆盖", {
          existingVersion: (hit as { version_tag: string }).version_tag,
        });
      }
    }

    const info = db
      .prepare(
        `INSERT INTO contract_versions
           (contract_id, version_tag, effective_from, currency, daily_limit, period_limit,
            overage_approver, vehicle_types, accounts)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        contractId,
        input.versionTag,
        from,
        input.currency,
        input.dailyLimit,
        input.periodLimit,
        input.overageApprover ?? null,
        JSON.stringify(jsonArray(input.vehicleTypes ?? null)),
        JSON.stringify(jsonArray(input.accounts ?? null))
      );
    const versionId = Number(info.lastInsertRowid);
    const siteStmt = db.prepare(
      "INSERT INTO contract_version_sites(version_id, site_id) VALUES(?, ?)"
    );
    for (const siteId of input.sites) {
      const site = db.prepare("SELECT 1 FROM sites WHERE site_id = ?").get(siteId);
      if (!site) throw new HttpError(400, "site_not_found", `站点不存在：${siteId}`);
      siteStmt.run(versionId, siteId);
    }
    // 关闭此前开放的旧版本（其区间截至新版本生效时刻，左闭右开）
    db.prepare(
      `UPDATE contract_versions SET effective_to = ?
        WHERE contract_id = ? AND effective_to IS NULL AND version_id <> ?`
    ).run(from, contractId, versionId);
    return versionId;
  });
  return tx();
}

export function setContractStatus(
  db: DB,
  input: { contractId: string; status: "active" | "paused"; reason?: string; occurredAt?: string }
): string {
  const at = resolveTime(input.occurredAt);
  const exists = db.prepare("SELECT 1 FROM contracts WHERE contract_id = ?").get(input.contractId);
  if (!exists) throw new HttpError(404, "contract_not_found", `合同不存在：${input.contractId}`);
  db.prepare(
    "INSERT INTO contract_status_events(contract_id, status, reason, occurred_at) VALUES(?, ?, ?, ?)"
  ).run(input.contractId, input.status, input.reason ?? null, at);
  return at;
}

export function setSiteStatus(
  db: DB,
  input: { siteId: string; status: "qualified" | "disqualified"; reason?: string; occurredAt?: string }
): string {
  const at = resolveTime(input.occurredAt);
  const exists = db.prepare("SELECT 1 FROM sites WHERE site_id = ?").get(input.siteId);
  if (!exists) throw new HttpError(404, "site_not_found", `站点不存在：${input.siteId}`);
  db.prepare(
    "INSERT INTO site_status_events(site_id, status, reason, occurred_at) VALUES(?, ?, ?, ?)"
  ).run(input.siteId, input.status, input.reason ?? null, at);
  return at;
}

export function addGuarantee(
  db: DB,
  input: { partnerId: string; delta: number; currency?: string; occurredAt?: string; note?: string }
): string {
  const at = resolveTime(input.occurredAt);
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new HttpError(400, "invalid_delta", "担保变动必须为非零整数（入账正、撤回负）");
  }
  const partner = db.prepare("SELECT 1 FROM partners WHERE partner_id = ?").get(input.partnerId);
  if (!partner) throw new HttpError(404, "partner_not_found", `合作方不存在：${input.partnerId}`);
  const row = db
    .prepare("SELECT currency FROM guarantee_events WHERE partner_id = ? LIMIT 1")
    .get(input.partnerId) as { currency: string } | undefined;
  // 担保余额按合作方单一币种维护；首笔事件声明币种，后续沿用
  const currency = row?.currency ?? input.currency ?? process.env.APP_GUARANTEE_CURRENCY ?? "GUAR";
  if (row && input.currency && input.currency !== row.currency) {
    throw new HttpError(409, "guarantee_currency_conflict", "同一合作方的担保币种不可变更", {
      currency: row.currency,
    });
  }
  const guar = guaranteeAt(db, input.partnerId, at);
  if (guar.balance + input.delta < 0) {
    throw new HttpError(409, "guarantee_negative", "撤回后担保余额不得为负", { balance: guar.balance });
  }
  db.prepare(
    "INSERT INTO guarantee_events(partner_id, currency, delta, occurred_at, note) VALUES(?, ?, ?, ?, ?)"
  ).run(input.partnerId, currency, input.delta, at, input.note ?? null);
  return at;
}

export function addFxRate(
  db: DB,
  input: {
    fromCurrency: string;
    toCurrency: string;
    numerator: number;
    denominator: number;
    effectiveFrom?: string;
  }
): void {
  const from = resolveTime(input.effectiveFrom);
  if (!Number.isInteger(input.numerator) || !Number.isInteger(input.denominator) ||
      input.numerator <= 0 || input.denominator <= 0) {
    throw new HttpError(400, "invalid_rate", "汇率分子分母必须为正整数");
  }
  db.prepare(
    `INSERT INTO fx_rates(from_currency, to_currency, numerator, denominator, effective_from)
     VALUES(?, ?, ?, ?, ?)`
  ).run(input.fromCurrency, input.toCurrency, input.numerator, input.denominator, from);
}

export function signPeriod(
  db: DB,
  input: { contractId: string; periodKey: string; note?: string; signedAt?: string }
): void {
  const at = resolveTime(input.signedAt);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.periodKey)) {
    throw new HttpError(400, "invalid_period", "账期格式必须为 YYYY-MM");
  }
  db.prepare(
    "INSERT OR IGNORE INTO period_locks(contract_id, period_key, signed_at, note) VALUES(?, ?, ?, ?)"
  ).run(input.contractId, input.periodKey, at, input.note ?? null);
}

// ---- as-of 读取（全部按发生时刻，不按写入时刻） ----------------------------

export function contractVersionAt(db: DB, contractId: string, at: string): ContractVersion | null {
  return (
    (db
      .prepare(
        `SELECT * FROM contract_versions
          WHERE contract_id = ? AND effective_from <= ?
            AND (effective_to IS NULL OR effective_to > ?)
          ORDER BY effective_from DESC, version_id DESC LIMIT 1`
      )
      .get(contractId, at, at) as ContractVersion | undefined) ?? null
  );
}

export function contractStatusAt(db: DB, contractId: string, at: string): string | null {
  const row = db
    .prepare(
      `SELECT status FROM contract_status_events
        WHERE contract_id = ? AND occurred_at <= ?
        ORDER BY occurred_at DESC, id DESC LIMIT 1`
    )
    .get(contractId, at) as { status: string } | undefined;
  return row?.status ?? null;
}

export function siteStatusAt(db: DB, siteId: string, at: string): string | null {
  const row = db
    .prepare(
      `SELECT status FROM site_status_events
        WHERE site_id = ? AND occurred_at <= ?
        ORDER BY occurred_at DESC, id DESC LIMIT 1`
    )
    .get(siteId, at) as { status: string } | undefined;
  return row?.status ?? null;
}

export function versionIncludesSite(db: DB, versionId: number, siteId: string): boolean {
  return Boolean(
    db.prepare(
      "SELECT 1 FROM contract_version_sites WHERE version_id = ? AND site_id = ?"
    ).get(versionId, siteId)
  );
}

/** as-of 担保余额；返回余额与币种（无任何事件时余额 0、币种 null）。 */
export function guaranteeAt(
  db: DB,
  partnerId: string,
  at: string
): { balance: number; currency: string | null } {
  const rows = db
    .prepare(
      "SELECT currency, delta FROM guarantee_events WHERE partner_id = ? AND occurred_at <= ?"
    )
    .all(partnerId, at) as { currency: string; delta: number }[];
  if (rows.length === 0) return { balance: 0, currency: null };
  return { balance: rows.reduce((s, r) => s + r.delta, 0), currency: rows[0].currency };
}

export function fxAt(db: DB, from: string, to: string, at: string): FxRate | null {
  if (from === to) return null; // 同币种无需冻结汇率
  return (
    (db
      .prepare(
        `SELECT * FROM fx_rates
          WHERE from_currency = ? AND to_currency = ? AND effective_from <= ?
          ORDER BY effective_from DESC, rate_id DESC LIMIT 1`
      )
      .get(from, to, at) as FxRate | undefined) ?? null
  );
}

export function periodIsLocked(db: DB, contractId: string, period: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM period_locks WHERE contract_id = ? AND period_key = ?").get(
      contractId,
      period
    )
  );
}
