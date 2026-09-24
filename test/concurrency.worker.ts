import { parentPort, workerData } from "node:worker_threads";
import { openDatabase, migrate } from "../src/db.js";
import { startSession } from "../src/sessions.js";

interface Payload {
  path: string;
  workerIndex: number;
  attempts: number;
}

const data = workerData as Payload;
const db = openDatabase(data.path);
db.pragma("busy_timeout = 10000");
migrate(db);

const result = { allowed: 0, denied: 0, busy: 0, other: 0 };
for (let i = 0; i < data.attempts; i++) {
  try {
    startSession(db, {
      requestKey: `w${data.workerIndex}-${i}`,
      contractId: "c1",
      siteId: "site-1",
      estimatedAmount: 100,
      eventTime: "2026-09-15T10:00:00.000Z",
    });
    result.allowed++;
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code === "admission_denied") result.denied++;
    else if (code.includes("BUSY") || code.includes("locked")) result.busy++;
    else result.other++;
  }
}
db.close();
parentPort!.postMessage(result);
