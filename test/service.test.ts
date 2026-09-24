import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, openDatabase } from "../src/db.ts";
import { ClearingService } from "../src/service.ts";
import type { ContractVersionInput, StartSessionInput } from "../src/types.ts";

function makeService(): ClearingService {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  return new ClearingService(db);
}

interface FixtureOptions extends Partial<ContractVersionInput> {
  contractId?: string;
  guaranteeAmount?: number;
}

function setupFixture(svc: ClearingService, opts: FixtureOptions = {}) {
  const contractId = opts.contractId ?? "C1";
  svc.createContract(contractId, "P1");
  svc.publishVersion(contractId, {
    partnerId: "P1",
    currency: opts.currency ?? "CNY",
    dailyLimit: opts.dailyLimit ?? 1000,
    periodLimit: opts.periodLimit ?? 10_000,
    overageApprover: opts.overageApprover ?? "boss",
    validFrom: opts.validFrom ?? "2026-01-01T00:00:00Z",
    sites: opts.sites ?? ["S1", "S2"],
    vehicleModels: opts.vehicleModels ?? ["M1"],
    accounts: opts.accounts ?? ["A1"],
  });
  svc.addGuarantee("G1", contractId, opts.guaranteeAmount ?? 1_000_000, opts.currency ?? "CNY");
  return contractId;
}

function startInput(over: Partial<StartSessionInput> = {}): StartSessionInput {
  return {
    sessionId: "SESS-1",
    idempotencyKey: "K-1",
    contractId: "C1",
    siteId: "S1",
    accountId: "A1",
    vehicleModel: "M1",
    amount: 100,
    currency: "CNY",
    ...over,
  };
}

test("正常准入：冻结版本与占用，片段逐步调整，结束结转并释放剩余量，签署后可全链路追溯", () => {
  const svc = makeService();
  setupFixture(svc);

  const started = svc.startSession(startInput());
  assert.equal(started.status, "in_progress");
  assert.equal(started.heldAmount, 100);
  assert.equal(started.contractVersion, 1);
  assert.deepEqual(started.frozenGuaranteeIds, ["G1"]);
  assert.equal(started.fx, null);

  const f1 = svc.addFragment("SESS-1", { fragmentId: "f1", seq: 1, observedAt: "2026-09-24T01:00:00Z", amount: 60, currency: "CNY" });
  assert.equal(f1.heldAmount, 60);
  assert.equal(f1.delta, -40);
  const f2 = svc.addFragment("SESS-1", { fragmentId: "f2", seq: 2, observedAt: "2026-09-24T02:00:00Z", amount: 80, currency: "CNY" });
  assert.equal(f2.delta, 20);

  // 片段幂等重放
  const f1again = svc.addFragment("SESS-1", { fragmentId: "f1", seq: 1, observedAt: "2026-09-24T01:00:00Z", amount: 60, currency: "CNY" });
  assert.equal(f1again.replayed, true);

  const ended = svc.endSession("SESS-1", { amount: 75, currency: "CNY" });
  assert.equal(ended.capturedAmount, 75);
  assert.equal(ended.releasedAmount, 5);
  assert.ok(ended.settlementId);
  svc.signSettlement(ended.settlementId, "clearing-team");

  const trace = svc.traceSession("SESS-1");
  assert.equal(trace.admitted, true);
  assert.equal(trace.frozenContract.dailyLimit, 1000);
  assert.deepEqual(trace.frozenContract.sites, ["S1", "S2"]);
  const net = trace.quotaLedger.reduce((s: number, l: any) => s + l.amount, 0);
  assert.equal(net, 75); // hold 100 - 40 + 20 - 5(结转) = 75
  assert.equal(trace.settlement.status, "signed");
  assert.equal(trace.settlement.signedBy, "clearing-team");
  assert.equal(trace.admissionEvents[0].decision, "admit");
});

test("相同启动请求返回原占用；同键异文进入冲突", () => {
  const svc = makeService();
  setupFixture(svc);

  const first = svc.startSession(startInput());
  const again = svc.startSession(startInput());
  assert.equal(again.hold!.holdId, first.hold!.holdId);

  assert.throws(
    () => svc.startSession(startInput({ amount: 200 })),
    (err: any) => err.code === "idempotency_conflict",
  );

  // 冲突在准入事件中留痕
  const trace = svc.traceSession("SESS-1");
  assert.deepEqual(trace.admissionEvents.map((e: any) => e.decision), ["admit", "replay", "conflict"]);
});

test("单日/账期上限：无授权拒绝，授权人一致时自动提额放行，人工豁免亦可放行", () => {
  const svc = makeService();
  setupFixture(svc, { dailyLimit: 100, periodLimit: 150 });

  svc.startSession(startInput({ sessionId: "S-a", idempotencyKey: "K-a", amount: 100 }));

  // 第二笔 60 突破单日 100，无授权人 → 拒绝
  assert.throws(
    () => svc.startSession(startInput({ sessionId: "S-b", idempotencyKey: "K-b", amount: 60 })),
    (err: any) => err.code === "quota_exceeded",
  );

  // 授权人错误 → 仍拒绝
  assert.throws(
    () => svc.startSession(startInput({ sessionId: "S-b", idempotencyKey: "K-b", amount: 60, approvedBy: "someone-else" })),
    (err: any) => err.code === "quota_exceeded",
  );

  // 授权人与合同声明一致 → 自动提额放行
  const admitted = svc.startSession(startInput({ sessionId: "S-b", idempotencyKey: "K-b", amount: 60, approvedBy: "boss" }));
  assert.equal(admitted.heldAmount, 60);

  // 另一笔走人工豁免（合同未声明授权人时只能人工豁免）；当前窗口已占用 160，故单日与账期都需提额
  svc.addExemption({ contractId: "C1", currency: "CNY", dayKey: admitted.dayKey, periodKey: admitted.periodKey, extraDaily: 100, extraPeriod: 100, approver: "ops", reason: "节假日临时提额" });
  const manual = svc.startSession(startInput({ sessionId: "S-c", idempotencyKey: "K-c", amount: 50 }));
  assert.equal(manual.status, "in_progress");
});

test("合同暂停只阻断未开始会话，进行中会话转入风险复核而不被中止", () => {
  const svc = makeService();
  setupFixture(svc);
  svc.startSession(startInput());

  svc.setContractSuspended("C1", true, "节前审计");

  // 进行中会话仍可上报计量，不被中止
  const f = svc.addFragment("SESS-1", { fragmentId: "f1", seq: 1, observedAt: new Date().toISOString(), amount: 90, currency: "CNY" });
  assert.equal(f.heldAmount, 90);

  // 新会话被阻断
  assert.throws(
    () => svc.startSession(startInput({ sessionId: "SESS-2", idempotencyKey: "K-2" })),
    (err: any) => err.code === "contract_suspended",
  );

  const pending = svc.listPendingReviews();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, "contract_suspended");

  // 复核豁免后进行中会话正常结束
  svc.resolveReview(pending[0].reviewId, "waived", "risk-officer", "客户已确认");
  const ended = svc.endSession("SESS-1", { amount: 90, currency: "CNY" });
  assert.equal(ended.capturedAmount, 90);
});

test("担保撤回：新会话失去支撑被拒，在途会话转入风险复核", () => {
  const svc = makeService();
  setupFixture(svc, { guaranteeAmount: 150 });
  svc.startSession(startInput({ amount: 100 }));

  svc.withdrawGuarantee("G1");

  const reviews = svc.listPendingReviews();
  assert.equal(reviews[0].reason, "guarantee_withdrawn");

  assert.throws(
    () => svc.startSession(startInput({ sessionId: "SESS-2", idempotencyKey: "K-2" })),
    (err: any) => err.code === "guarantee_insufficient",
  );
});

test("站点资格变化：进行中会话转复核，取消资格后的新会话被拒", () => {
  const svc = makeService();
  setupFixture(svc);
  svc.startSession(startInput());

  svc.setSiteEligibility("S1", false, "资质过期");
  assert.equal(svc.listPendingReviews()[0].reason, "site_disqualified");

  assert.throws(
    () => svc.startSession(startInput({ sessionId: "SESS-2", idempotencyKey: "K-2" })),
    (err: any) => err.code === "site_disqualified",
  );

  // 恢复资格后新会话放行
  svc.setSiteEligibility("S1", true, "资质续期");
  const ok = svc.startSession(startInput({ sessionId: "SESS-2", idempotencyKey: "K-2" }));
  assert.equal(ok.status, "in_progress");
});

test("离线事件按发生时刻判断：过去事件适用当时版本与资格，不受后续变化影响", () => {
  const svc = makeService();
  // v1 适用 S1；v2（9 月起）仅适用 S2
  svc.createContract("C1", "P1");
  svc.publishVersion("C1", {
    partnerId: "P1", currency: "CNY", dailyLimit: 1000, periodLimit: 10_000,
    overageApprover: "boss", validFrom: "2026-01-01T00:00:00Z", sites: ["S1"],
    vehicleModels: ["*"], accounts: ["*"],
  });
  svc.publishVersion("C1", {
    partnerId: "P1", currency: "CNY", dailyLimit: 1000, periodLimit: 10_000,
    overageApprover: "boss", validFrom: "2026-09-01T00:00:00Z", sites: ["S2"],
    vehicleModels: ["*"], accounts: ["*"],
  });
  // 直接补一条 1 月已存在的担保（离线发生时刻可见）
  (svc as unknown as { db: Database.Database }).db.prepare(
    "INSERT INTO guarantees(guarantee_id, contract_id, amount, currency, status, created_at) VALUES('G1','C1',1000000,'CNY','active','2026-01-05T00:00:00Z')",
  ).run();
  // 站点 9 月才被取消资格
  svc.setSiteEligibility("S1", false, "9 月资质问题", "2026-09-10T00:00:00Z");

  // 8 月的离线事件：S1 仍在 v1 白名单且站点仍有资格 → 放行，并冻结 v1
  const past = svc.startSession(startInput({
    sessionId: "OLD-1", idempotencyKey: "K-OLD",
    startedAt: "2026-08-15T12:00:00Z",
  }));
  assert.equal(past.contractVersion, 1);
  assert.equal(past.offline, true);
  assert.equal(past.dayKey, "2026-08-15");
});

test("离线开始事件不能越过后来已签署的结算", () => {
  const svc = makeService();
  setupFixture(svc);
  // 一个已结束并签署的当月会话
  svc.startSession(startInput({ sessionId: "DONE", idempotencyKey: "K-DONE" }));
  const ended = svc.endSession("DONE", { amount: 100, currency: "CNY" });
  svc.signSettlement(ended.settlementId, "finance");

  // 补录同月、发生时刻更早的离线事件 → 被屏障拒绝
  assert.throws(
    () => svc.startSession(startInput({ sessionId: "LATE", idempotencyKey: "K-LATE", startedAt: "2026-09-01T00:00:00Z" })),
    (err: any) => err.code === "settlement_barrier",
  );

  // 被拒会话仍可追溯到拒绝原因
  const trace = svc.traceSession("LATE");
  assert.equal(trace.admitted, false);
  assert.equal(trace.admissionEvents[0].reason, "settlement_barrier");
});

test("占用到期释放：台账冲平、生成复核任务；结束时按真实金额重新入账", () => {
  const svc = makeService();
  setupFixture(svc, { dailyLimit: 1000 });
  svc.startSession(startInput({ amount: 100, holdTtlSeconds: 0 }));

  // 另一会话占用至窗口上限 1000（100 + 900），两笔随后过期释放应把额度还给窗口
  svc.startSession(startInput({ sessionId: "OTHER", idempotencyKey: "K-O", amount: 900, holdTtlSeconds: 0 }));
  const expired = svc.expireHolds(new Date(Date.now() + 1000));
  const expiredIds = expired.map((e) => e.sessionId).sort();
  assert.deepEqual(expiredIds, ["OTHER", "SESS-1"]);

  // 释放后新会话可重新使用被释放的额度
  const reuse = svc.startSession(startInput({ sessionId: "REUSE", idempotencyKey: "K-R", amount: 1000 }));
  assert.equal(reuse.status, "in_progress");

  // 过期会话结束：按真实金额 capture（台账净额=真实消费），仍生成结算
  const ended = svc.endSession("SESS-1", { amount: 80, currency: "CNY" });
  assert.equal(ended.capturedAmount, 80);
  const trace = svc.traceSession("SESS-1");
  assert.ok(trace.riskReviews.some((r: any) => r.reason === "hold_expired"));
  assert.equal(trace.settlement.status, "draft");
});

test("服务重启后继续过期释放与待复核任务", () => {
  const dir = mkdtempSync(join(tmpdir(), "charging-"));
  const dbPath = join(dir, "test.sqlite3");
  try {
    const db1 = openDatabase(dbPath);
    migrate(db1);
    const svc1 = new ClearingService(db1);
    setupFixture(svc1);
    svc1.startSession(startInput({ amount: 100, holdTtlSeconds: 0 }));
    // 模拟服务宕机期间合同被暂停（只落流水、不跑检测），重启时应被补发现
    db1.prepare(
      "INSERT INTO contract_lifecycle(contract_id, action, occurred_at, reason) VALUES('C1','suspend',?, '审计')",
    ).run(new Date().toISOString());
    db1.close();

    // 全新进程内的新连接模拟重启
    const db2 = openDatabase(dbPath);
    migrate(db2);
    const svc2 = new ClearingService(db2);
    const recovered = svc2.recoverOnStartup();
    assert.equal(recovered.expired.length, 1);
    assert.equal(recovered.reviews.length, 2); // hold_expired + contract_suspended
    const reasons = recovered.reviews.map((r) => r.reason).sort();
    assert.deepEqual(reasons, ["contract_suspended", "hold_expired"]);
    // 再次恢复不应重复产生任务
    const again = svc2.recoverOnStartup();
    assert.equal(again.expired.length, 0);
    assert.equal(again.reviews.length, 0);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("外币会话冻结汇率版本，后续汇率变化不影响计量换算", () => {
  const svc = makeService();
  setupFixture(svc); // 合同币种 CNY
  svc.publishFxRate({ baseCurrency: "EUR", quoteCurrency: "CNY", rate: 8, effectiveAt: "2026-01-01T00:00:00Z" });

  const started = svc.startSession(startInput({ amount: 10, currency: "EUR" }));
  assert.equal(started.heldAmount, 80);
  assert.equal(started.fx!.rate, 8);

  // 汇率后来变化
  svc.publishFxRate({ baseCurrency: "EUR", quoteCurrency: "CNY", rate: 9, effectiveAt: new Date().toISOString() });
  svc.addFragment("SESS-1", { fragmentId: "f1", seq: 1, observedAt: new Date().toISOString(), amount: 5, currency: "EUR" });
  const trace = svc.traceSession("SESS-1");
  assert.equal(trace.session.heldAmount, 40); // 仍按冻结的 8 换算

  // 缺少汇率版本 → 拒绝
  assert.throws(
    () => svc.startSession(startInput({ sessionId: "X", idempotencyKey: "KX", currency: "USD", amount: 10 })),
    (err: any) => err.code === "fx_rate_unavailable",
  );
});

test("进行中计量突破上限不拒绝片段，转风险复核", () => {
  const svc = makeService();
  setupFixture(svc, { dailyLimit: 100, periodLimit: 10_000 });
  svc.startSession(startInput({ amount: 90 }));
  svc.addFragment("SESS-1", { fragmentId: "f1", seq: 1, observedAt: new Date().toISOString(), amount: 120, currency: "CNY" });
  assert.equal(svc.listPendingReviews()[0].reason, "quota_exceeded");
});

test("多进程并发申请同一额度：SQLite IMMEDIATE 事务保证不透支", async () => {
  const dir = mkdtempSync(join(tmpdir(), "charging-conc-"));
  const dbPath = join(dir, "conc.sqlite3");
  const helper = fileURLToPath(new URL("./helper-start.ts", import.meta.url));
  try {
    // 用一个进程先建库并铺底数据（单日上限 100，两笔各 60，仅其一可成功）
    const setupDb = openDatabase(dbPath);
    migrate(setupDb);
    const setupSvc = new ClearingService(setupDb);
    setupSvc.createContract("C1", "P1");
    setupSvc.publishVersion("C1", {
      partnerId: "P1", currency: "CNY", dailyLimit: 100, periodLimit: 1000,
      overageApprover: undefined as unknown as string, validFrom: "2026-01-01T00:00:00Z",
      sites: ["S1"], vehicleModels: ["*"], accounts: ["*"],
    });
    setupSvc.addGuarantee("G1", "C1", 1_000_000, "CNY");
    setupDb.close();

    const payload = (sessionId: string) => JSON.stringify({
      sessionId, idempotencyKey: `K-${sessionId}`, contractId: "C1",
      siteId: "S1", amount: 60, currency: "CNY",
    });

    const outcomes = await Promise.all(["P-1", "P-2"].map((sid) =>
      new Promise<{ ok: boolean; code?: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", helper, payload(sid)], {
          cwd: process.cwd(),
          env: { ...process.env, APP_DB_PATH: dbPath },
        });
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.on("close", () => resolve(JSON.parse(out.trim().split("\n").pop()!)));
      }),
    ));

    const admitted = outcomes.filter((o) => o.ok);
    const rejected = outcomes.filter((o) => !o.ok);
    assert.equal(admitted.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].code, "quota_exceeded");

    // 库内实际占用净额不得超过上限
    const verifyDb = openDatabase(dbPath);
    const used = verifyDb.prepare(
      "SELECT COALESCE(SUM(amount),0) AS u FROM quota_ledger WHERE contract_id='C1'",
    ).get() as { u: number };
    assert.equal(used.u, 60);
    verifyDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
