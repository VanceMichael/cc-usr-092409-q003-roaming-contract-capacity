import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const path = process.env.APP_DB_PATH ?? "data/charging.sqlite3";
mkdirSync(dirname(path), { recursive: true });
const database = new Database(path);
database.exec(readFileSync("migrations/001_schema_versions.sql", "utf8"));
database.prepare("INSERT OR IGNORE INTO schema_versions(version, applied_at) VALUES(1, ?)").run(new Date().toISOString());
database.close();
