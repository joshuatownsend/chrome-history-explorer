/**
 * Liveness job runner. The `enrichments` table IS the queue (survives restarts).
 * A bounded worker pool claims pending rows, checks them politely, writes results.
 */
import type { Database } from "bun:sqlite";
import { getDb } from "../db.ts";
import { checkLiveness } from "./liveness.ts";

const MAX_CONCURRENCY = 12;
const HOST_GAP_MS = 600; // min spacing between hits to the same host
const TTL_LIVE_MS = 7 * 86_400_000; // re-check live links weekly
const TTL_OTHER_MS = 86_400_000; // re-check dead/blocked/error daily

let active = 0;
const lastHostHit = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ClaimRow {
  id: number;
  url_id: number;
  url: string;
}

/** Crash recovery: any row left 'running' from a previous process goes back to 'pending'. */
export function resetStuckJobs(db: Database = getDb()): void {
  db.query(`UPDATE enrichments SET status='pending' WHERE kind='liveness' AND status='running'`).run();
}

function isFresh(status: string, fetchedAt: number | null, resultJson: string | null): boolean {
  if (status === "pending" || status === "running" || status === "skipped") return true;
  if (status !== "done" || !fetchedAt) return false;
  let state = "live";
  try {
    if (resultJson) state = JSON.parse(resultJson).state ?? "live";
  } catch {
    /* ignore */
  }
  const ttl = state === "live" ? TTL_LIVE_MS : TTL_OTHER_MS;
  return Date.now() - fetchedAt < ttl;
}

/**
 * Enqueue specific URL ids. Private hosts are recorded as 'skipped' (never fetched).
 * Public URLs with stale/missing liveness become 'pending'. Returns count queued.
 */
export function enqueueUrlIds(ids: number[], db: Database = getDb()): number {
  if (!ids.length) return 0;
  const getUrl = db.query<
    { is_private: number; status: string | null; fetched_at: number | null; result_json: string | null },
    [number]
  >(
    `SELECT u.is_private,
            e.status, e.fetched_at, e.result_json
     FROM urls u
     LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness'
     WHERE u.id = ?`,
  );
  const upsert = db.query(
    `INSERT INTO enrichments (url_id, kind, status) VALUES ($id, 'liveness', $status)
     ON CONFLICT(url_id, kind) DO UPDATE SET status = $status, error = NULL`,
  );

  let queued = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const row = getUrl.get(id);
      if (!row) continue;
      if (row.is_private) {
        if (row.status !== "skipped") upsert.run({ $id: id, $status: "skipped" });
        continue;
      }
      if (row.status && isFresh(row.status, row.fetched_at, row.result_json)) continue;
      upsert.run({ $id: id, $status: "pending" });
      queued++;
    }
  });
  tx();
  pump(db);
  return queued;
}

function claimOne(db: Database): ClaimRow | null {
  const tx = db.transaction(() => {
    const row = db
      .query<ClaimRow, []>(
        `SELECT e.id, e.url_id, u.url
         FROM enrichments e JOIN urls u ON u.id = e.url_id
         WHERE e.kind = 'liveness' AND e.status = 'pending'
         LIMIT 1`,
      )
      .get();
    if (!row) return null;
    db.query(`UPDATE enrichments SET status='running' WHERE id=$id`).run({ $id: row.id });
    return row;
  });
  return tx();
}

async function processOne(db: Database, row: ClaimRow): Promise<void> {
  // Per-host politeness gap.
  let host = "";
  try {
    host = new URL(row.url).hostname;
  } catch {
    /* ignore */
  }
  if (host) {
    const since = Date.now() - (lastHostHit.get(host) ?? 0);
    if (since < HOST_GAP_MS) await sleep(HOST_GAP_MS - since);
    lastHostHit.set(host, Date.now());
  }

  try {
    const result = await checkLiveness(row.url);
    db.query(
      `UPDATE enrichments SET status='done', fetched_at=$at, result_json=$json, error=$err WHERE id=$id`,
    ).run({
      $id: row.id,
      $at: result.fetched_at,
      $json: JSON.stringify(result),
      $err: result.error ?? null,
    });
  } catch (err) {
    db.query(`UPDATE enrichments SET status='failed', error=$err WHERE id=$id`).run({
      $id: row.id,
      $err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Fill the worker pool from the pending queue until empty or saturated. */
export function pump(db: Database = getDb()): void {
  while (active < MAX_CONCURRENCY) {
    const row = claimOne(db);
    if (!row) break;
    active++;
    void processOne(db, row).finally(() => {
      active--;
      pump(db);
    });
  }
}

export interface LivenessStatus {
  active: number;
  counts: Record<string, number>; // by enrichment status
  states: Record<string, number>; // by liveness state (for done rows)
  total_public: number;
}

export function getLivenessStatus(db: Database = getDb()): LivenessStatus {
  const counts: Record<string, number> = {};
  for (const r of db
    .query<{ status: string; n: number }, []>(
      `SELECT status, COUNT(*) n FROM enrichments WHERE kind='liveness' GROUP BY status`,
    )
    .all())
    counts[r.status] = r.n;

  const states: Record<string, number> = {};
  for (const r of db
    .query<{ state: string; n: number }, []>(
      `SELECT json_extract(result_json,'$.state') state, COUNT(*) n
       FROM enrichments WHERE kind='liveness' AND status='done' GROUP BY state`,
    )
    .all())
    if (r.state) states[r.state] = r.n;

  const total_public = (
    db.query(`SELECT COUNT(*) n FROM urls WHERE is_private=0`).get() as { n: number }
  ).n;

  return { active, counts, states, total_public };
}
