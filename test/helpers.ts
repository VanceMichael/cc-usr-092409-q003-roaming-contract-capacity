import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../src/db.js";
import { migrate, openDatabase } from "../src/db.js";
import {
  addContractVersion,
  addFxRate,
  addGuarantee,
  createContract,
  registerPartner,
  registerSite,
  setContractStatus,
  setSiteStatus,
  signPeriod,
} from "../src/catalog.js";

export interface Fixture {
  db: DB;
  partnerId: string;
  contractId: string;
  siteId: string;
  currency: string;
}

export function memoryDb(): DB {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export function fileDb(): { db: DB; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "charging-"));
  const path = join(dir, "test.sqlite3");
  const db = openDatabase(path);
  migrate(db);
  return { db, path };
}

export interface SeedOptions {
  dailyLimit?: number;
  periodLimit?: number;
  currency?: string;
  guarantee?: number;
  guaranteeCurrency?: string;
  sites?: string[];
  vehicleTypes?: string[] | null;
  accounts?: string[] | null;
  overageApprover?: string | null;
  versionFrom?: string;
  versionTag?: string;
}

const BASE_TIME = "2026-09-15T10:00:00.000Z";

/** 搭好 partner/site/contract/version/guarantee 的标准基线。 */
export function seedFixture(db: DB, opts: SeedOptions = {}): Fixture {
  const partnerId = "p1";
  const contractId = "c1";
  const siteId = "site-1";
  const currency = opts.currency ?? "EUR";

  registerPartner(db, { partnerId, name: "漫游车队 A" });
  registerSite(db, { siteId, occurredAt: "2026-01-01T00:00:00.000Z" });
  createContract(db, { contractId, partnerId, activeAt: "2026-01-01T00:00:00.000Z" });
  addContractVersion(db, contractId, {
    versionTag: opts.versionTag ?? "v1",
    effectiveFrom: opts.versionFrom ?? "2026-01-01T00:00:00.000Z",
    currency,
    dailyLimit: opts.dailyLimit ?? 1000,
    periodLimit: opts.periodLimit ?? 10000,
    overageApprover: opts.overageApprover === undefined ? "bob" : opts.overageApprover,
    vehicleTypes: opts.vehicleTypes === undefined ? null : opts.vehicleTypes,
    accounts: opts.accounts === undefined ? null : opts.accounts,
    sites: opts.sites ?? [siteId],
  });
  if (opts.guarantee !== 0) {
    addGuarantee(db, {
      partnerId,
      delta: opts.guarantee ?? 1_000_000,
      currency: opts.guaranteeCurrency ?? currency,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
  }
  return { db, partnerId, contractId, siteId, currency };
}

export const T = {
  base: BASE_TIME,
  site2: "site-2",
} as const;

export {
  addContractVersion,
  addFxRate,
  addGuarantee,
  createContract,
  registerPartner,
  registerSite,
  setContractStatus,
  setSiteStatus,
  signPeriod,
};
