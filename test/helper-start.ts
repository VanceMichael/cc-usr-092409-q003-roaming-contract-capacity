// 并发测试辅助：由主测试以子进程方式启动两个实例，各自独立打开同一 SQLite 文件，
// 真实复现多进程并发申请同一额度的场景。
// 用法：APP_DB_PATH=... node --import tsx helper-start.ts '<startPayloadJson>'
import { openDatabase, migrate } from "../src/db.ts";
import { ClearingService } from "../src/service.ts";
import type { StartSessionInput } from "../src/types.ts";

const db = openDatabase(process.env.APP_DB_PATH!);
migrate(db);
const service = new ClearingService(db);
try {
  const result = service.startSession(JSON.parse(process.argv[2]) as StartSessionInput);
  console.log(JSON.stringify({ ok: true, holdId: result.hold?.holdId, heldAmount: result.heldAmount }));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ ok: false, code: (err as { code?: string }).code ?? "unknown" }));
  process.exit(1);
}
