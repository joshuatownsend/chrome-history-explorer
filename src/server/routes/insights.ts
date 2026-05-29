import { Hono } from "hono";
import { getDb } from "../db.ts";

export const insights = new Hono();

const DAY = 86_400_000;

/**
 * GET /api/insights/on-this-day — pages visited on today's calendar day in
 * previous years/months, grouped (client-side) by year. Pure time_ms SQL.
 */
insights.get("/on-this-day", (c) => {
  const db = getDb();
  const rows = db
    .query(
      `SELECT u.id, u.url, u.title, u.domain, u.is_private,
              CAST(strftime('%Y', v.time_ms/1000,'unixepoch','localtime') AS INTEGER) AS yr,
              COUNT(*) AS day_visits, MAX(v.time_ms) AS t
         FROM visits v JOIN urls u ON u.id = v.url_id
        WHERE u.is_hidden = 0
          AND strftime('%m-%d', v.time_ms/1000,'unixepoch','localtime')
              = strftime('%m-%d','now','localtime')
          AND date(v.time_ms/1000,'unixepoch','localtime') < date('now','localtime')
        GROUP BY u.id, yr
        ORDER BY yr DESC, day_visits DESC
        LIMIT 80`,
    )
    .all();
  return c.json({ rows });
});

/**
 * GET /api/insights/rediscovery?days=90&limit=24 — "forgotten gems": pages you
 * visited a lot but haven't returned to in a while.
 */
insights.get("/rediscovery", (c) => {
  const db = getDb();
  const sp = new URL(c.req.url).searchParams;
  const days = Math.min(Math.max(Number(sp.get("days") ?? 90), 7), 3650);
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 24), 1), 100);
  const cutoff = Date.now() - days * DAY;
  const rows = db
    .query(
      `SELECT id, url, title, domain, is_private, visit_count, first_visited, last_visited
         FROM urls
        WHERE is_hidden = 0 AND is_private = 0
          AND last_visited < $cutoff AND visit_count >= 3
        ORDER BY visit_count DESC
        LIMIT $limit`,
    )
    .all({ $cutoff: cutoff, $limit: limit });
  return c.json({ rows, days });
});

/**
 * GET /api/insights/rhythm — when you browse (night-owl share, peak hour) plus a
 * rabbit-hole rollup from the journeys table (if built).
 */
insights.get("/rhythm", (c) => {
  const db = getDb();
  const byHour = db
    .query<{ h: number; n: number }, []>(
      `SELECT CAST(strftime('%H', time_ms/1000,'unixepoch','localtime') AS INTEGER) h, COUNT(*) n
         FROM visits GROUP BY h`,
    )
    .all();
  const total = byHour.reduce((a, b) => a + b.n, 0) || 1;
  const inRange = (lo: number, hi: number) =>
    byHour.filter((x) => x.h >= lo && x.h < hi).reduce((a, b) => a + b.n, 0);
  const peak = byHour.slice().sort((a, b) => b.n - a.n)[0]?.h ?? null;

  const j = db
    .query(
      `SELECT COUNT(*) AS count, COALESCE(MAX(link_hops),0) AS deepest_hops,
              COALESCE(MAX(end_ms - start_ms),0) AS longest_ms,
              COALESCE(ROUND(AVG(url_count),1),0) AS avg_pages
         FROM journeys`,
    )
    .get() as { count: number; deepest_hops: number; longest_ms: number; avg_pages: number };

  return c.json({
    peak_hour: peak,
    night_owl_share: inRange(22, 24) + inRange(0, 5), // 10pm–5am
    morning_share: inRange(5, 12),
    work_share: inRange(9, 18),
    total_visits: total,
    journeys: j,
  });
});

/**
 * GET /api/insights/recurring?limit=24 — domains you return to on a cadence
 * (daily/weekly/monthly), still active recently. Heuristic from visit-day spread.
 */
insights.get("/recurring", (c) => {
  const db = getDb();
  const limit = Math.min(Math.max(Number(new URL(c.req.url).searchParams.get("limit") ?? 24), 1), 100);
  const rows = db
    .query<
      { domain: string; days: number; first: number; last: number; visits: number },
      []
    >(
      `SELECT u.domain,
              COUNT(DISTINCT date(v.time_ms/1000,'unixepoch','localtime')) AS days,
              MIN(v.time_ms) AS first, MAX(v.time_ms) AS last, COUNT(*) AS visits
         FROM visits v JOIN urls u ON u.id = v.url_id
        WHERE u.is_hidden = 0 AND u.is_private = 0 AND u.domain IS NOT NULL
        GROUP BY u.domain
        HAVING days >= 8`,
    )
    .all();

  const now = Date.now();
  const out = rows
    .map((r) => {
      const spanDays = (r.last - r.first) / DAY;
      const gap = r.days > 1 ? spanDays / (r.days - 1) : Infinity; // avg days between active days
      const cadence = gap <= 2 ? "daily" : gap <= 10 ? "weekly" : gap <= 45 ? "monthly" : "occasional";
      const activeRecently = r.last > now - 21 * DAY;
      // Regularity score favors many active days, recent activity, tight cadence.
      const score = r.days * (activeRecently ? 1 : 0.3) * (cadence === "occasional" ? 0.5 : 1);
      return { domain: r.domain, days: r.days, visits: r.visits, last: r.last, cadence, activeRecently, score };
    })
    .filter((r) => r.cadence !== "occasional")
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return c.json({ rows: out });
});

/**
 * GET /api/insights/open-loops?days=14&limit=24 — substantial research sessions
 * (journeys) that stalled a while ago and are worth picking back up.
 */
insights.get("/open-loops", (c) => {
  const db = getDb();
  const sp = new URL(c.req.url).searchParams;
  const days = Math.min(Math.max(Number(sp.get("days") ?? 14), 1), 3650);
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 24), 1), 100);
  const cutoff = Date.now() - days * DAY;
  const rows = db
    .query(
      `SELECT j.id, j.label, j.description, j.url_count, j.link_hops, j.start_ms, j.end_ms,
              eu.url AS entry_url, eu.title AS entry_title, eu.is_private AS entry_private
         FROM journeys j
         LEFT JOIN urls eu ON eu.id = j.entry_url_id
        WHERE j.url_count >= 5 AND j.end_ms < $cutoff
        ORDER BY j.url_count DESC, j.link_hops DESC
        LIMIT $limit`,
    )
    .all({ $cutoff: cutoff, $limit: limit });
  return c.json({ rows, days });
});

/**
 * GET /api/insights/graveyard?limit=30 — high-value pages that are now dead
 * (from the liveness enrichment), with an archive link when available.
 */
insights.get("/graveyard", (c) => {
  const db = getDb();
  const limit = Math.min(Math.max(Number(new URL(c.req.url).searchParams.get("limit") ?? 30), 1), 100);
  const rows = db
    .query(
      `SELECT u.id, u.url, u.title, u.domain, u.visit_count, u.last_visited,
              e.result_json
         FROM enrichments e JOIN urls u ON u.id = e.url_id
        WHERE e.kind = 'liveness' AND e.status = 'done'
          AND json_extract(e.result_json,'$.state') = 'dead'
          AND u.is_hidden = 0 AND u.is_private = 0
        ORDER BY u.visit_count DESC
        LIMIT $limit`,
    )
    .all({ $limit: limit });
  return c.json({ rows });
});
