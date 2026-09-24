import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type DB = Database.Database;

export function openDatabase(path: string = process.env.APP_DB_PATH ?? "data/charging.sqlite3"): DB {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  return database;
}

function migrationsDir(): string {
  const candidates = [
    join(process.cwd(), "migrations"),
    join(dirname(new URL(import.meta.url).pathname), "..", "migrations"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** 按文件名顺序应用尚未记录的迁移，并写入 schema_versions。 */
export function migrate(database: DB): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const applied = new Set(
    (database.prepare("SELECT version FROM schema_versions").all() as { version: number }[]).map((r) => r.version)
  );
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const stamp = database.prepare("INSERT INTO schema_versions(version, applied_at) VALUES(?, ?)");
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const apply = database.transaction(() => {
      database.exec(sql);
      stamp.run(version, new Date().toISOString());
    });
    apply();
  }
}

export function openMigratedDatabase(path?: string): DB {
  const database = openDatabase(path);
  migrate(database);
  return database;
}
