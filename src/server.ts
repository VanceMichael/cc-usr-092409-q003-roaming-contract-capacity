import type { DB } from "./db.js";
import { openMigratedDatabase } from "./db.js";
import { buildApp } from "./http.js";
import { sweepExpiredHolds, sweepRiskChanges } from "./sessions.js";

/** 测试可注入独立 DB；缺省使用内存库（生产入口自行打开 APP_DB_PATH 文件库）。 */
export function createApp(database?: DB) {
  const db = database ?? openMigratedDatabase(":memory:");
  return buildApp({ db });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openMigratedDatabase();

  // 服务重启后继续过期释放与待复核任务
  const recover = () => {
    sweepExpiredHolds(db);
    sweepRiskChanges(db);
  };
  recover();
  const intervalMs = Number(process.env.APP_SWEEP_INTERVAL_MS ?? "60000");
  setInterval(recover, intervalMs).unref();

  const port = Number(process.env.PORT ?? "8080");
  buildApp({ db }).listen(port, "0.0.0.0");
}
