import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";

async function withServer(fn: (base: string) => Promise<void>) {
  const app = createApp({ runSweeperTimer: false });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    (app as unknown as { stopSweeper: () => void }).stopSweeper?.();
  }
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test("HTTP 端到端：发布合同→担保→启动→片段→结束→签署→追溯", async () => {
  await withServer(async (base) => {
    assert.equal((await (await fetch(base + "/health")).json()).status, "ok");

    assert.equal((await post(base, "/admin/contracts", { contractId: "C1", partnerId: "P1" })).status, 201);
    assert.equal((await post(base, "/admin/contracts/C1/versions", {
      partnerId: "P1", currency: "CNY", dailyLimit: 1000, periodLimit: 10000,
      overageApprover: "boss", validFrom: "2026-01-01T00:00:00Z",
      sites: ["S1"], vehicleModels: ["M1"], accounts: ["A1"],
    })).status, 201);
    assert.equal((await post(base, "/admin/guarantees", {
      guaranteeId: "G1", contractId: "C1", amount: 100000, currency: "CNY",
    })).status, 201);

    const start = await post(base, "/sessions/start", {
      sessionId: "W1", idempotencyKey: "KW1", contractId: "C1", siteId: "S1",
      accountId: "A1", vehicleModel: "M1", amount: 100, currency: "CNY",
    });
    assert.equal(start.status, 201);
    assert.equal(start.json.heldAmount, 100);

    // 幂等重放
    const replay = await post(base, "/sessions/start", {
      sessionId: "W1", idempotencyKey: "KW1", contractId: "C1", siteId: "S1",
      accountId: "A1", vehicleModel: "M1", amount: 100, currency: "CNY",
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.json.hold.holdId, start.json.hold.holdId);

    // 同键异文冲突
    const conflict = await post(base, "/sessions/start", {
      sessionId: "W1", idempotencyKey: "KW1", contractId: "C1", siteId: "S1",
      accountId: "A1", vehicleModel: "M1", amount: 200, currency: "CNY",
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, "idempotency_conflict");

    assert.equal((await post(base, "/sessions/W1/fragments", {
      fragmentId: "f1", seq: 1, observedAt: new Date().toISOString(), amount: 70, currency: "CNY",
    })).status, 201);

    const end = await post(base, "/sessions/W1/end", { amount: 65, currency: "CNY" });
    assert.equal(end.status, 200);
    assert.equal(end.json.capturedAmount, 65);

    assert.equal((await post(base, `/settlements/${end.json.settlementId}/sign`, { signedBy: "fin" })).status, 200);

    const trace = await (await fetch(base + "/sessions/W1/trace")).json();
    assert.equal(trace.frozenContract.currency, "CNY");
    assert.equal(trace.settlement.status, "signed");
    assert.deepEqual(trace.admissionEvents.map((e: { decision: string }) => e.decision), ["admit", "replay", "conflict"]);
  });
});

test("HTTP 端到端：拒绝可追溯；暂停后新会话 422、在途进入复核队列", async () => {
  await withServer(async (base) => {
    await post(base, "/admin/contracts", { contractId: "C2", partnerId: "P2" });
    await post(base, "/admin/contracts/C2/versions", {
      partnerId: "P2", currency: "CNY", dailyLimit: 100, periodLimit: 100,
      validFrom: "2026-01-01T00:00:00Z", sites: ["S1"], vehicleModels: ["*"], accounts: ["*"],
    });
    await post(base, "/admin/guarantees", { guaranteeId: "G2", contractId: "C2", amount: 100000, currency: "CNY" });

    const first = await post(base, "/sessions/start", {
      sessionId: "A", idempotencyKey: "KA", contractId: "C2", siteId: "S1", amount: 100, currency: "CNY",
    });
    assert.equal(first.status, 201);

    // 超额且无授权 → 422，拒绝事件可追溯
    const denied = await post(base, "/sessions/start", {
      sessionId: "B", idempotencyKey: "KB", contractId: "C2", siteId: "S1", amount: 10, currency: "CNY",
    });
    assert.equal(denied.status, 422);
    assert.equal(denied.json.error.code, "quota_exceeded");
    const traceB = await (await fetch(base + "/sessions/B/trace")).json();
    assert.equal(traceB.admitted, false);
    assert.equal(traceB.admissionEvents[0].reason, "quota_exceeded");

    // 暂停：进行中 A 入复核，新会话被拒
    await post(base, "/admin/contracts/C2/suspension", { suspend: true, reason: "审计" });
    const reviews = await (await fetch(base + "/admin/reviews")).json();
    assert.ok(reviews.reviews.some((r: { sessionId: string; reason: string }) => r.sessionId === "A" && r.reason === "contract_suspended"));
    const blocked = await post(base, "/sessions/start", {
      sessionId: "C", idempotencyKey: "KC", contractId: "C2", siteId: "S1", amount: 1, currency: "CNY",
    });
    assert.equal(blocked.status, 422);
    assert.equal(blocked.json.error.code, "contract_suspended");
  });
});
