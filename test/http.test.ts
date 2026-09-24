import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/server.ts";
import { memoryDb, seedFixture } from "./helpers.ts";

async function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

test("HTTP 全链路：管理面建目录 -> 放行 -> 计量 -> 结束 -> trace", async () => {
  const db = memoryDb();
  seedFixture(db, { dailyLimit: 1000, periodLimit: 10000 });
  const server = createApp(db).listen(0);
  try {
    // 放行
    const start = await request(server, "POST", "/sessions/start", {
      requestKey: "http-1",
      contractId: "c1",
      siteId: "site-1",
      estimatedAmount: 200,
      eventTime: "2026-09-15T10:00:00.000Z",
    });
    assert.equal(start.status, 201);
    assert.equal(start.json.session.held_amount, 200);

    // 幂等重放
    const replay = await request(server, "POST", "/sessions/start", {
      requestKey: "http-1",
      contractId: "c1",
      siteId: "site-1",
      estimatedAmount: 200,
      eventTime: "2026-09-15T10:00:00.000Z",
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.json.session.session_id, "http-1");

    // 同键异文冲突
    const conflict = await request(server, "POST", "/sessions/start", {
      requestKey: "http-1",
      contractId: "c1",
      siteId: "site-1",
      estimatedAmount: 999,
      eventTime: "2026-09-15T10:00:00.000Z",
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error, "request_conflict");

    // 超 cap 拒绝
    const denied = await request(server, "POST", "/sessions/start", {
      requestKey: "http-2",
      contractId: "c1",
      siteId: "site-1",
      estimatedAmount: 900, // 200 已占用
      eventTime: "2026-09-15T10:05:00.000Z",
    });
    assert.equal(denied.status, 403);
    assert.ok(denied.json.details.reasons.includes("daily_cap_exceeded"));

    // 计量调整
    const meter = await request(server, "POST", "/sessions/http-1/meter", {
      segmentNo: 1,
      cumulativeAmount: 150,
      eventTime: "2026-09-15T11:00:00.000Z",
    });
    assert.equal(meter.status, 200);
    assert.equal(meter.json.session.held_amount, 150);

    // 结束结转
    const end = await request(server, "POST", "/sessions/http-1/end", {
      eventTime: "2026-09-15T12:00:00.000Z",
    });
    assert.equal(end.status, 200);
    assert.equal(end.json.session.settled_amount, 150);

    // trace 可追到条款、额度变化、结算
    const trace = await request(server, "GET", "/trace/http-1");
    assert.equal(trace.status, 200);
    assert.equal(trace.json.frozenContractVersion.version_tag, "v1");
    const types = trace.json.quotaChanges.map((c: { change_type: string }) => c.change_type);
    assert.deepEqual(types, ["hold", "adjust", "release", "settle"]);
    assert.equal(trace.json.settlement.amount, 150);
  } finally {
    server.close();
    db.close();
  }
});

test("HTTP：暂停合同阻断新会话，并把在途会话推入复核队列", async () => {
  const db = memoryDb();
  seedFixture(db);
  const server = createApp(db).listen(0);
  try {
    await request(server, "POST", "/sessions/start", {
      requestKey: "http-pause",
      contractId: "c1",
      siteId: "site-1",
      estimatedAmount: 50,
      eventTime: "2026-09-15T10:00:00.000Z",
    });
    const paused = await request(server, "POST", "/admin/contracts/c1/status", {
      status: "paused",
      reason: "节假日合同待续签",
      occurredAt: "2026-09-15T10:30:00.000Z",
    });
    assert.equal(paused.status, 200);

    const reviews = await request(server, "GET", "/admin/reviews");
    assert.ok(reviews.json.reviews.some((r: { session_id: string }) => r.session_id === "http-pause"));

    const blocked = await request(server, "POST", "/sessions/start", {
      requestKey: "http-blocked",
      contractId: "c1",
      siteId: "site-1",
      estimatedAmount: 10,
      eventTime: "2026-09-15T10:31:00.000Z",
    });
    assert.equal(blocked.status, 403);
    assert.ok(blocked.json.details.reasons.includes("contract_paused"));

    // 在途会话仍可查，状态为 risk_review 而非被中止
    const view = await request(server, "GET", "/sessions/http-pause");
    assert.equal(view.json.status, "risk_review");
    assert.equal(view.json.held_amount, 50);
  } finally {
    server.close();
    db.close();
  }
});

test("HTTP：参数缺失返回 400 机器可读错误", async () => {
  const db = memoryDb();
  const server = createApp(db).listen(0);
  try {
    const res = await request(server, "POST", "/sessions/start", { requestKey: "x" });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "field_required");
  } finally {
    server.close();
    db.close();
  }
});
