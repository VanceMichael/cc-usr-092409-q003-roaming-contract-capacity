import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../src/time.js";
import {
  addContractVersion,
  addFxRate,
  addGuarantee,
  seedFixture,
  memoryDb,
  setContractStatus,
  setSiteStatus,
} from "./helpers.ts";
import { startSession } from "../src/sessions.js";
import { trace } from "../src/reviews.js";

const T0 = "2026-09-15T10:00:00.000Z";
const T1 = "2026-09-15T11:00:00.000Z";

function expectError(fn: () => unknown, code: string): HttpError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HttpError);
    assert.equal(err.code, code);
    return err;
  }
  throw new assert.AssertionError({ message: `期望抛出 ${code}` });
}

test("合同/站点/担保齐备时放行并冻结合同版本与占用", () => {
  const db = memoryDb();
  const f = seedFixture(db, { dailyLimit: 1000, periodLimit: 10000 });
  const session = startSession(db, {
    requestKey: "k1",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 600,
    eventTime: T0,
  });
  assert.equal(session.status, "started");
  assert.equal(session.held_amount, 600);
  assert.equal(session.day_key, "2026-09-15");
  assert.equal(session.period_key, "2026-09");

  const dayHeld = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM quota_ledger WHERE bucket='held'")
    .get() as { s: number };
  assert.equal(dayHeld.s, 600);
});

test("超单日上限被拒绝，原因与额度快照可追溯", () => {
  const db = memoryDb();
  const f = seedFixture(db, { dailyLimit: 500 });
  const err = expectError(
    () =>
      startSession(db, {
        requestKey: "k-denied",
        contractId: f.contractId,
        siteId: f.siteId,
        estimatedAmount: 600,
        eventTime: T0,
      }),
    "admission_denied"
  );
  assert.ok((err.extra!.reasons as string[]).includes("daily_cap_exceeded"));

  const t = trace(db, "k-denied");
  const decisions = t.decisions as { decision: string; reasons: string[]; snapshot: Record<string, unknown> }[];
  assert.equal(decisions[0].decision, "denied");
  assert.deepEqual(decisions[0].reasons, ["daily_cap_exceeded"]);
  assert.equal(decisions[0].snapshot.dailyLimit, 500);
  assert.equal(decisions[0].snapshot.dayProjected, 600);
  // 被拒不得产生任何占用
  const held = db.prepare("SELECT COUNT(*) AS n FROM quota_ledger WHERE bucket='held'").get() as { n: number };
  assert.equal(held.n, 0);
});

test("相同启动请求返回原占用（幂等重放）", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  const input = {
    requestKey: "k-idem",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 100,
    eventTime: T0,
  };
  const first = startSession(db, input);
  const second = startSession(db, { ...input });
  assert.equal(first.session_id, second.session_id);
  assert.equal(second.held_amount, 100);
  const rows = db
    .prepare("SELECT COUNT(*) AS n FROM charging_sessions WHERE session_id = 'k-idem'")
    .get() as { n: number };
  assert.equal(rows.n, 1);
  const decisions = db
    .prepare("SELECT decision FROM admission_decisions WHERE request_key='k-idem' ORDER BY id")
    .all() as { decision: string }[];
  assert.deepEqual(decisions.map((d) => d.decision), ["allowed", "replay"]);
});

test("同键异文进入冲突且不产生第二个占用", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  startSession(db, {
    requestKey: "k-conflict",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 100,
    eventTime: T0,
  });
  expectError(
    () =>
      startSession(db, {
        requestKey: "k-conflict",
        contractId: f.contractId,
        siteId: f.siteId,
        estimatedAmount: 200,
        eventTime: T0,
      }),
    "request_conflict"
  );
  const held = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM quota_ledger WHERE bucket='held'")
    .get() as { s: number };
  assert.equal(held.s, 100);
  const decisions = db
    .prepare("SELECT decision FROM admission_decisions WHERE request_key='k-conflict' ORDER BY id")
    .all() as { decision: string }[];
  assert.deepEqual(decisions.map((d) => d.decision), ["allowed", "conflict"]);
});

test("合同暂停只阻断未开始会话", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  setContractStatus(db, { contractId: f.contractId, status: "paused", occurredAt: T0 });
  const err = expectError(
    () =>
      startSession(db, {
        requestKey: "k-paused",
        contractId: f.contractId,
        siteId: f.siteId,
        estimatedAmount: 10,
        eventTime: T0,
      }),
    "admission_denied"
  );
  assert.ok((err.extra!.reasons as string[]).includes("contract_paused"));
});

test("站点取消资格或不在白名单内被拒绝", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  setSiteStatus(db, { siteId: f.siteId, status: "disqualified", occurredAt: T0 });
  let err = expectError(
    () =>
      startSession(db, {
        requestKey: "k-dq",
        contractId: f.contractId,
        siteId: f.siteId,
        estimatedAmount: 10,
        eventTime: T0,
      }),
    "admission_denied"
  );
  assert.ok((err.extra!.reasons as string[]).includes("site_not_qualified"));

  // 合格但不在该合同版本白名单
  const db2 = memoryDb();
  const f2 = seedFixture(db2);
  err = expectError(
    () =>
      startSession(db2, {
        requestKey: "k-wl",
        contractId: f2.contractId,
        siteId: "site-other",
        estimatedAmount: 10,
        eventTime: T0,
      }),
    "admission_denied"
  );
  // site-other 连站点主数据都没有 -> site_not_qualified
  assert.ok((err.extra!.reasons as string[]).includes("site_not_qualified"));
});

test("车型与账户范围被冻结在准入时刻", () => {
  const db = memoryDb();
  const f = seedFixture(db, { vehicleTypes: ["bus"], accounts: ["acct-1"] });
  const err = expectError(
    () =>
      startSession(db, {
        requestKey: "k-scope",
        contractId: f.contractId,
        siteId: f.siteId,
        estimatedAmount: 10,
        vehicleType: "truck",
        accountId: "acct-1",
        eventTime: T0,
      }),
    "admission_denied"
  );
  assert.ok((err.extra!.reasons as string[]).includes("vehicle_type_out_of_scope"));
  const ok = startSession(db, {
    requestKey: "k-scope-ok",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 10,
    vehicleType: "bus",
    accountId: "acct-1",
    eventTime: T0,
  });
  assert.equal(ok.status, "started");
});

test("币种不同被拒；担保为外币时冻结汇率版本并向上取整占用", () => {
  const db = memoryDb();
  const f = seedFixture(db, { currency: "EUR", guarantee: 105, guaranteeCurrency: "USD" });
  addFxRate(db, {
    fromCurrency: "EUR",
    toCurrency: "USD",
    numerator: 11,
    denominator: 10,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  });

  // 100 EUR -> 110 USD（ceil），担保仅 105，拒绝
  const err = expectError(
    () =>
      startSession(db, {
        requestKey: "k-fx-deny",
        contractId: f.contractId,
        siteId: f.siteId,
        estimatedAmount: 100,
        eventTime: T0,
      }),
    "admission_denied"
  );
  assert.ok((err.extra!.reasons as string[]).includes("guarantee_insufficient"));

  // 提升担保到 110 后放行，会话冻结该汇率版本
  addGuarantee(db, { partnerId: f.partnerId, delta: 5, occurredAt: "2026-09-01T00:00:00.000Z" });
  const session = startSession(db, {
    requestKey: "k-fx-ok",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 100,
    eventTime: T0,
  });
  assert.equal(session.held_converted, 110);
  assert.ok(session.fx_rate_id);

  // 后来新增更优汇率不影响已冻结的会话
  addFxRate(db, {
    fromCurrency: "EUR",
    toCurrency: "USD",
    numerator: 1,
    denominator: 1,
    effectiveFrom: "2026-09-16T00:00:00.000Z",
  });
  const t = trace(db, "k-fx-ok");
  assert.equal((t.session as { fx_rate_id: number }).fx_rate_id, session.fx_rate_id);
});

test("合同版本在插枪后更新：新会话用新版本，旧会话仍冻结旧版本", () => {
  const db = memoryDb();
  const f = seedFixture(db, { dailyLimit: 100, versionTag: "v1" });
  // 离线插枪发生在 T0，当时只有 v1
  const old = startSession(db, {
    requestKey: "k-oldver",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 80,
    eventTime: T0,
  });

  // 节假日新版本 T1 生效（额度提高、白名单变化），自动接替开放区间
  addContractVersion(db, f.contractId, {
    versionTag: "v2-holiday",
    effectiveFrom: T1,
    currency: "EUR",
    dailyLimit: 2000,
    periodLimit: 20000,
    overageApprover: "carol",
    sites: [f.siteId],
  });

  // T1 之后的会话冻结 v2
  const fresh = startSession(db, {
    requestKey: "k-newver",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 1500,
    eventTime: T1,
  });
  assert.notEqual(old.version_id, fresh.version_id);
  const v2 = db
    .prepare("SELECT version_tag, daily_limit, effective_to FROM contract_versions WHERE version_id=?")
    .get(fresh.version_id) as { version_tag: string; daily_limit: number; effective_to: string | null };
  assert.equal(v2.version_tag, "v2-holiday");
  assert.equal(v2.daily_limit, 2000);
  assert.equal(v2.effective_to, null);
  const v1 = db
    .prepare("SELECT effective_to FROM contract_versions WHERE version_id=?")
    .get(old.version_id) as { effective_to: string };
  assert.equal(v1.effective_to, T1); // 旧版本区间在 T1 关闭

  // T0 的晚到事件按发生时刻仍匹配 v1，不会被 v2 的额度放行
  // （旧会话已冻结 v1，这里验证 as-of 查询）
  const t = trace(db, "k-oldver");
  assert.equal((t.frozenContractVersion as { version_tag: string }).version_tag, "v1");
});

test("生效时刻早于当前开放版本的新合同版本被拒绝", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  expectError(
    () =>
      addContractVersion(db, f.contractId, {
        versionTag: "v-backdated",
        effectiveFrom: "2025-12-31T00:00:00.000Z",
        currency: "EUR",
        dailyLimit: 1,
        periodLimit: 1,
        sites: [f.siteId],
      }),
    "version_overlap"
  );
});

test("放行 trace 可追到冻结条款、额度变化", () => {  const db = memoryDb();
  const f = seedFixture(db);
  startSession(db, {
    requestKey: "k-trace",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 300,
    eventTime: T0,
  });
  const t = trace(db, "k-trace");
  assert.equal((t.decisions as { decision: string }[])[0].decision, "allowed");
  const frozen = t.frozenContractVersion as { version_tag: string; daily_limit: number; siteWhitelist: string[] };
  assert.equal(frozen.version_tag, "v1");
  assert.equal(frozen.daily_limit, 1000);
  assert.deepEqual(frozen.siteWhitelist, [f.siteId]);
  const changes = t.quotaChanges as { change_type: string; amount: number }[];
  assert.equal(changes[0].change_type, "hold");
  assert.equal(changes[0].amount, 300);
});
