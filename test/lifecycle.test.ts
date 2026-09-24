import assert from "node:assert/strict";
import test from "node:test";
import {
  addGuarantee,
  memoryDb,
  seedFixture,
  setContractStatus,
  setSiteStatus,
  signPeriod,
} from "./helpers.ts";
import {
  applyMeterSegment,
  endSession,
  startSession,
  sweepExpiredHolds,
  sweepRiskChanges,
} from "../src/sessions.js";
import { grantExemption, listOpenReviews, resolveReview, trace } from "../src/reviews.js";
import { HttpError } from "../src/time.js";

const T0 = "2026-09-15T10:00:00.000Z";
const T1 = "2026-09-15T11:00:00.000Z";
const T2 = "2026-09-15T12:00:00.000Z";

function expectCode(fn: () => unknown, code: string): HttpError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HttpError, `期望 HttpError 但得到：${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  throw new assert.AssertionError({ message: `期望抛出 ${code} 但未抛错` });
}

function heldSum(db: ReturnType<typeof memoryDb>): number {
  return (
    db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM quota_ledger WHERE bucket='held'").get() as {
      s: number;
    }
  ).s;
}

test("计量片段逐步调增占用，结束时结转真实金额并释放剩余", () => {
  const db = memoryDb();
  const f = seedFixture(db, { dailyLimit: 1000, periodLimit: 10000 });
  startSession(db, {
    requestKey: "k-life",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 100,
    eventTime: T0,
  });
  assert.equal(heldSum(db), 100);

  const m1 = applyMeterSegment(db, {
    sessionId: "k-life",
    segmentNo: 1,
    cumulativeAmount: 250,
    eventTime: T1,
  });
  assert.equal(m1.held_amount, 250);
  assert.equal(m1.measured_amount, 250);
  assert.equal(heldSum(db), 250); // 调增 150

  // 片段幂等：重复序号不重复入账
  applyMeterSegment(db, { sessionId: "k-life", segmentNo: 1, cumulativeAmount: 250, eventTime: T1 });
  assert.equal(heldSum(db), 250);

  const ended = endSession(db, { sessionId: "k-life", eventTime: T2 });
  assert.equal(ended.status, "completed");
  assert.equal(ended.settled_amount, 250);
  assert.equal(heldSum(db), 0); // 占用全部释放
  const consumed = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM quota_ledger WHERE bucket='consumed'")
    .get() as { s: number };
  assert.equal(consumed.s, 250);

  const t = trace(db, "k-life");
  assert.equal((t.settlement as { amount: number }).amount, 250);
  assert.equal((t.quotaChanges as { change_type: string }[]).at(-1)!.change_type, "settle");

  // 结束请求幂等
  const again = endSession(db, { sessionId: "k-life", eventTime: T2 });
  assert.equal(again.settled_amount, 250);
});

test("真实消费低于预估时释放剩余量", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  startSession(db, {
    requestKey: "k-under",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 400,
    eventTime: T0,
  });
  applyMeterSegment(db, { sessionId: "k-under", segmentNo: 1, cumulativeAmount: 300, eventTime: T1 });
  assert.equal(heldSum(db), 300); // 计量缩减即释放
  endSession(db, { sessionId: "k-under", finalAmount: 300, eventTime: T2 });
  assert.equal(heldSum(db), 0);
});

test("计量超额进入风险复核且不扩大占用，合同声明的授权人豁免后追补", () => {
  const db = memoryDb();
  const f = seedFixture(db, { dailyLimit: 500, periodLimit: 10000, overageApprover: "alice" });
  startSession(db, {
    requestKey: "k-over",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 400,
    eventTime: T0,
  });

  const m = applyMeterSegment(db, {
    sessionId: "k-over",
    segmentNo: 1,
    cumulativeAmount: 700,
    eventTime: T1,
  });
  assert.equal(m.status, "risk_review");
  assert.equal(m.held_amount, 400); // 占用未扩大
  assert.equal(m.measured_amount, 700); // 真实计量照记

  // 非声明授权人无权豁免
  expectCode(
    () =>
      grantExemption(db, {
        contractId: f.contractId,
        kind: "overage",
        amount: 300,
        approver: "mallory",
        scope: { type: "session", value: "k-over" },
      }),
    "approver_unauthorized"
  );

  // 声明的超额授权人 alice 追加 300 单日授权
  grantExemption(db, {
    contractId: f.contractId,
    kind: "overage",
    amount: 300,
    approver: "alice",
    scope: { type: "session", value: "k-over" },
    eventTime: T1,
  });

  const open = listOpenReviews(db);
  assert.ok(open.some((r) => r.session_id === "k-over" && r.reason === "overage_unauthorized"));
  const reviewId = open.find((r) => r.session_id === "k-over")!.id;
  const resolved = resolveReview(db, {
    reviewId,
    action: "exempt",
    approver: "risk-desk",
    eventTime: T2,
  });
  assert.equal(resolved.status, "exempted");
  const after = db
    .prepare("SELECT * FROM charging_sessions WHERE session_id='k-over'")
    .get() as { status: string; held_amount: number };
  assert.equal(after.status, "started");
  assert.equal(after.held_amount, 700); // 追补到真实计量

  const t = trace(db, "k-over");
  const exemptions = t.exemptions as { approver: string; amount: number }[];
  assert.ok(exemptions.some((e) => e.approver === "alice" && e.amount === 300));
});

test("合同暂停时在途会话转入风险复核而不被中止，人工可放行或终止", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  startSession(db, {
    requestKey: "k-midpause",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 100,
    eventTime: T0,
  });
  setContractStatus(db, { contractId: f.contractId, status: "paused", occurredAt: T1 });
  const opened = sweepRiskChanges(db, T1);
  assert.ok(opened >= 1);
  const s = db
    .prepare("SELECT * FROM charging_sessions WHERE session_id='k-midpause'")
    .get() as { status: string; held_amount: number };
  assert.equal(s.status, "risk_review");
  assert.equal(s.held_amount, 100); // 占用保留，不静默中止

  // 计量在复核期仍可到达，但暂停等资格问题不开新重复单
  assert.doesNotThrow(() =>
    applyMeterSegment(db, { sessionId: "k-midpause", segmentNo: 1, cumulativeAmount: 120, eventTime: T1 })
  );

  const reviewId = listOpenReviews(db).find((r) => r.session_id === "k-midpause")!.id;
  resolveReview(db, { reviewId, action: "abort", approver: "risk-desk", eventTime: T2 });
  const after = db
    .prepare("SELECT * FROM charging_sessions WHERE session_id='k-midpause'")
    .get() as { status: string; held_amount: number };
  assert.equal(after.status, "aborted");
  assert.equal(after.held_amount, 0);
  assert.equal(heldSum(db), 0);
});

test("站点资格变化同样只转复核", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  startSession(db, {
    requestKey: "k-site",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 100,
    eventTime: T0,
  });
  setSiteStatus(db, { siteId: f.siteId, status: "disqualified", occurredAt: T1 });
  sweepRiskChanges(db, T1);
  const s = db
    .prepare("SELECT * FROM charging_sessions WHERE session_id='k-site'")
    .get() as { status: string };
  assert.equal(s.status, "risk_review");
});

test("担保撤回导致在途会话进入复核", () => {
  const db = memoryDb();
  const f = seedFixture(db, { guarantee: 1000 });
  startSession(db, {
    requestKey: "k-guar",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 600,
    eventTime: T0,
  });
  // 撤回 900 -> 余额 100 < 占用 600
  addGuarantee(db, { partnerId: f.partnerId, delta: -900, occurredAt: T1 });
  sweepRiskChanges(db, T1);
  const reviews = listOpenReviews(db).filter((r) => r.session_id === "k-guar");
  assert.ok(reviews.some((r) => r.reason === "guarantee_withdrawn"));
});

test("占用到期被扫描释放，进行中会话转为 expired", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  startSession(db, {
    requestKey: "k-exp",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 100,
    eventTime: T0,
    holdTtlSeconds: 7200,
  });
  // 未到期（11:00 < 12:00）
  assert.deepEqual(sweepExpiredHolds(db, T1), []);
  assert.equal(heldSum(db), 100);
  // 到期
  const expired = sweepExpiredHolds(db, "2026-09-15T12:00:01.000Z");
  assert.deepEqual(expired, ["k-exp"]);
  assert.equal(heldSum(db), 0);
  const s = db
    .prepare("SELECT * FROM charging_sessions WHERE session_id='k-exp'")
    .get() as { status: string };
  assert.equal(s.status, "expired");
});

test("结束时真实金额超 cap 据实结转并开 over_cap_settle 复核", () => {
  const db = memoryDb();
  const f = seedFixture(db, { dailyLimit: 500, periodLimit: 10000 });
  startSession(db, {
    requestKey: "k-capfinal",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 500,
    eventTime: T0,
  });
  // 计量超额：进复核、占用不扩
  applyMeterSegment(db, { sessionId: "k-capfinal", segmentNo: 1, cumulativeAmount: 650, eventTime: T1 });
  // 仍可结束：据实结转 650，超出日 cap
  const ended = endSession(db, { sessionId: "k-capfinal", eventTime: T2 });
  assert.equal(ended.status, "completed");
  assert.equal(ended.settled_amount, 650);
  const reviews = listOpenReviews(db).filter((r) => r.session_id === "k-capfinal");
  assert.ok(reviews.some((r) => r.reason === "over_cap_settle"));
  const consumed = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM quota_ledger WHERE bucket='consumed'")
    .get() as { s: number };
  assert.equal(consumed.s, 650);
});

test("离线开始事件按发生时刻判断：插枪后的新版本/资格变化不影响旧事件", () => {
  const db = memoryDb();
  // 初始版本日限 100；车辆离线插枪发生在 T0
  const f = seedFixture(db, { dailyLimit: 100 });
  // 站点在 T1 才被取消资格、合同在 T1 暂停——均晚于插枪
  setSiteStatus(db, { siteId: f.siteId, status: "disqualified", occurredAt: T1 });
  setContractStatus(db, { contractId: f.contractId, status: "paused", occurredAt: T1 });

  // 服务在 T2 才收到 T0 的事件：按 T0 所见状态放行
  const session = startSession(db, {
    requestKey: "k-offline",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 80,
    eventTime: T0,
  });
  assert.equal(session.status, "started");
  assert.equal(session.start_event_time, T0);
});

test("离线事件不能越过后来已签署的账期结算", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  signPeriod(db, { contractId: f.contractId, periodKey: "2026-09", signedAt: "2026-10-05T00:00:00.000Z" });
  expectCode(
    () =>
      startSession(db, {
        requestKey: "k-late",
        contractId: f.contractId,
        siteId: f.siteId,
        estimatedAmount: 10,
        eventTime: T0,
      }),
    "period_already_signed"
  );
  // 拒绝仍可追溯
  const t = trace(db, "k-late");
  assert.equal((t.decisions as { decision: string }[])[0].decision, "denied");
});

test("账期签署后晚到的计量/结束事件同样被拒绝", () => {
  const db = memoryDb();
  const f = seedFixture(db);
  startSession(db, {
    requestKey: "k-lockmeter",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 100,
    eventTime: "2026-09-30T23:00:00.000Z",
  });
  signPeriod(db, { contractId: f.contractId, periodKey: "2026-09", signedAt: "2026-10-05T00:00:00.000Z" });
  expectCode(
    () =>
      applyMeterSegment(db, {
        sessionId: "k-lockmeter",
        segmentNo: 1,
        cumulativeAmount: 120,
        eventTime: "2026-09-30T23:30:00.000Z",
      }),
    "period_already_signed"
  );
  expectCode(
    () => endSession(db, { sessionId: "k-lockmeter", eventTime: "2026-09-30T23:59:00.000Z" }),
    "period_already_signed"
  );
});

test("人工额度调整可临时抬高单日上限并留痕", () => {
  const db = memoryDb();
  const f = seedFixture(db, { dailyLimit: 100 });
  // 未经调整：150 被拒
  expectCode(
    () =>
      startSession(db, {
        requestKey: "k-manual-deny",
        contractId: f.contractId,
        siteId: f.siteId,
        estimatedAmount: 150,
        eventTime: T0,
      }),
    "admission_denied"
  );
  // 人工追加 100
  db.prepare(
    `INSERT INTO quota_ledger(contract_id, period_key, day_key, bucket, change_type, amount, currency, event_time, ref_type, ref_id)
     VALUES(?, '2026-09', '2026-09-15', 'manual', 'manual_adjust', 100, 'EUR', ?, 'exemption', 'ops')`
  ).run(f.contractId, "2026-09-15T09:00:00.000Z");
  const session = startSession(db, {
    requestKey: "k-manual-ok",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 150,
    eventTime: T0,
  });
  assert.equal(session.status, "started");
});

test("重启后继续过期释放与待复核任务", async () => {
  const { fileDb } = await import("./helpers.ts");
  const { db, path } = fileDb();
  const f = seedFixture(db, { guarantee: 1000 });
  startSession(db, {
    requestKey: "k-restart",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 600,
    eventTime: T0,
    holdTtlSeconds: 60,
  });
  addGuarantee(db, { partnerId: f.partnerId, delta: -950, occurredAt: T1 });
  db.close();

  // 重新打开同一文件库并执行恢复
  const { openDatabase, migrate } = await import("../src/db.js");
  const db2 = openDatabase(path);
  migrate(db2);
  const expired = sweepExpiredHolds(db2, "2026-09-15T13:00:00.000Z");
  assert.deepEqual(expired, ["k-restart"]);
  const opened = sweepRiskChanges(db2, "2026-09-15T13:00:00.000Z");
  // 占用已释放，担保不再超限；过期会话不产生复核
  assert.equal(opened, 0);
  const s = db2
    .prepare("SELECT * FROM charging_sessions WHERE session_id='k-restart'")
    .get() as { status: string };
  assert.equal(s.status, "expired");
  db2.close();
});

test("并发申请由 IMMEDIATE 事务串行化，绝不越过单日额度", () => {
  const db = memoryDb();
  const f = seedFixture(db, { dailyLimit: 100, periodLimit: 10000 });
  // 用 child 风格的方式在同一事件循环里交错：better-sqlite3 是同步的，
  // 两个事务只要各自独立读取-判定-写入，IMMEDIATE 会强制串行。
  // 这里验证串行交错场景下第二个申请必然被拒。
  startSession(db, {
    requestKey: "k-c1",
    contractId: f.contractId,
    siteId: f.siteId,
    estimatedAmount: 80,
    eventTime: T0,
  });
  let denied = 0;
  for (const key of ["k-c2", "k-c3"]) {
    try {
      startSession(db, {
        requestKey: key,
        contractId: f.contractId,
        siteId: f.siteId,
        estimatedAmount: 80,
        eventTime: T0,
      });
    } catch (err) {
      if (err instanceof HttpError && err.code === "admission_denied") denied++;
    }
  }
  assert.equal(denied, 2);
  assert.equal(
    (db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM quota_ledger WHERE bucket='held'").get() as { s: number }).s,
    80
  );
});
