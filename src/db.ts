import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/** 启动时保证库表结构到最新版本；迁移记录与 DDL 在同一事务内提交。 */
export function migrate(db: Database.Database, migrationsDir = join(process.cwd(), "migrations")): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_versions").all().map((row: any) => row.version as number),
  );

  for (const file of readdirSync(migrationsDir).filter((n) => /^\d+_.*\.sql$/.test(n)).sort()) {
    const version = Number(file.slice(0, 3));
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_versions(version, applied_at) VALUES(?, ?)")
        .run(version, new Date().toISOString());
    });
    apply();
  }
}
