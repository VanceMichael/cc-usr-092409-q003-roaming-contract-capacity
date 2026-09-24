import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { fileDb, seedFixture } from "./helpers.ts";

interface WorkerResult {
  allowed: number;
  denied: number;
  busy: number;
  other: number;
}

test("跨连接并发申请不透支单日额度（SQLite IMMEDIATE 串行化）", async () => {
  const { db, path } = fileDb();
  // 日上限 500，每次申请占用 100 → 全局最多 5 个放行
  seedFixture(db, { dailyLimit: 500, periodLimit: 5000 });
  db.close();

  const WORKERS = 4;
  const ATTEMPTS = 10;
  const workers: Promise<WorkerResult>[] = [];
  for (let i = 0; i < WORKERS; i++) {
    workers.push(
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./concurrency.worker.ts", import.meta.url), {
          workerData: { path, workerIndex: i, attempts: ATTEMPTS },
          execArgv: ["--import", "tsx"],
        });
        worker.once("message", (msg: WorkerResult) => resolve(msg));
        worker.once("error", reject);
      })
    );
  }
  const results = await Promise.all(workers);
  const totals = results.reduce(
    (acc, r) => ({
      allowed: acc.allowed + r.allowed,
      denied: acc.denied + r.denied,
      busy: acc.busy + r.busy,
      other: acc.other + r.other,
    }),
    { allowed: 0, denied: 0, busy: 0, other: 0 }
  );

  assert.equal(totals.other, 0, `存在非预期错误：${JSON.stringify(results)}`);
  assert.equal(totals.allowed + totals.denied + totals.busy, WORKERS * ATTEMPTS);
  assert.equal(totals.allowed, 5, "恰好 5 笔申请获准（500/100）");
  assert.equal(totals.denied + totals.busy, 35);

  const { openDatabase } = await import("../src/db.js");
  const check = openDatabase(path);
  const held = check
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM quota_ledger WHERE bucket='held'")
    .get() as { s: number };
  assert.equal(held.s, 500, "已占用总额恰好等于单日上限，未透支");
  const sessions = check
    .prepare("SELECT COUNT(*) AS n FROM charging_sessions")
    .get() as { n: number };
  assert.equal(sessions.n, 5);
  check.close();
});
