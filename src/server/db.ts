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
  const urlCols = db.query("PRAGMA table_info(urls)").all() as { name: string }[];
  if (!urlCols.some((c) => c.name === "is_hidden")) {
    db.exec("ALTER TABLE urls ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_urls_hidden ON urls(is_hidden)");

  // Multi-source: visits gain provenance (source) + real transition type, and the
  // dedup key drops client_id so the same moment from two sources collapses.
  const visitCols = db.query("PRAGMA table_info(visits)").all() as { name: string }[];
  if (visitCols.length && !visitCols.some((c) => c.name === "source")) {
    db.exec("ALTER TABLE visits ADD COLUMN source TEXT NOT NULL DEFAULT 'takeout'");
  }
  if (visitCols.length && !visitCols.some((c) => c.name === "transition")) {
    db.exec("ALTER TABLE visits ADD COLUMN transition TEXT");
  }
  // Replace the old (url_id,time_ms,client_id) uniqueness with (url_id,time_ms).
  const idx = db.query("PRAGMA index_list(visits)").all() as { name: string }[];
  if (idx.some((i) => i.name === "uq_visits_url_time_client")) {
    db.exec(
      "DELETE FROM visits WHERE id NOT IN (SELECT MIN(id) FROM visits GROUP BY url_id, time_ms)",
    );
    db.exec("DROP INDEX uq_visits_url_time_client");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_visits_url_time ON visits(url_id, time_ms)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_visits_source ON visits(source)");
}

export const dbPath = DB_PATH;
