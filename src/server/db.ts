import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DB_PATH = process.env.HISTORY_DB ?? join(process.cwd(), "data", "history.db");
const SCHEMA_PATH = join(import.meta.dir, "schema.sql");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  migrate(db);
  _db = db;
  return db;
}

/** Idempotent column adds for databases created before a column existed. */
function migrate(db: Database): void {
  const cols = db.query("PRAGMA table_info(urls)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "is_hidden")) {
    db.exec("ALTER TABLE urls ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_urls_hidden ON urls(is_hidden)");
}

export const dbPath = DB_PATH;
