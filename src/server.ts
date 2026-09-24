import Koa from "koa";
import type Database from "better-sqlite3";
import { migrate, openDatabase } from "./db.js";
import { errorHandler, createRouter } from "./routes.js";
import { ClearingService } from "./service.js";

export interface CreateAppOptions {
  /** 覆盖数据库路径；默认取 APP_DB_PATH，未设置时用内存库（便于测试）。 */
  dbPath?: string;
  /** 直接注入已构造的服务（测试用）。 */
  service?: ClearingService;
  /** 启动周期性清扫（过期释放/待复核发现），默认开启；测试可关闭。 */
  runSweeperTimer?: boolean;
  sweeperIntervalMs?: number;
}

export function createService(db: Database.Database): ClearingService {
  migrate(db);
  return new ClearingService(db);
}

export function createApp(options: CreateAppOptions = {}) {
  const dbPath = options.dbPath ?? process.env.APP_DB_PATH ?? ":memory:";
  const db = options.service ? null : openDatabase(dbPath);
  const service = options.service ?? createService(db!);

  // 重启恢复：补做过期释放与在途风险复核，保证服务重启后任务不丢
  service.recoverOnStartup();

  const app = new Koa();
  app.use(errorHandler());
  app.use(createRouter(service).routes());
  app.use(createRouter(service).allowedMethods());

  let timer: NodeJS.Timeout | undefined;
  if (options.runSweeperTimer ?? true) {
    timer = setInterval(() => {
      try {
        service.runSweepers();
      } catch (err) {
        app.emit("error", err);
      }
    }, options.sweeperIntervalMs ?? 60_000);
    timer.unref?.();
  }

  (app as unknown as { service: ClearingService }).service = service;
  (app as unknown as { stopSweeper: () => void }).stopSweeper = () => {
    if (timer) clearInterval(timer);
  };
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? "8080");
  // 进程入口默认落盘（保留 data/charging.sqlite3 约定）；未显式传 dbPath 的测试用内存库
  createApp({ dbPath: process.env.APP_DB_PATH ?? "data/charging.sqlite3" })
    .listen(port, "0.0.0.0", () => {
      console.log(`charging-clearing listening on :${port}`);
    });
}
