import { Hono } from "hono";
import { getDb } from "../db.ts";

export const stats = new Hono();

/** GET /api/stats — aggregate insights for the dashboard. */
stats.get("/", (c) => {
  const db = getDb();
  const all = <T>(sql: string, ...p: unknown[]) => db.query(sql).all(...(p as [])) as T[];
  const one = (sql: string) => (db.query(sql).get() as { n: number }).n;

  const totals = {
    visits: one("SELECT COUNT(*) n FROM visits"),
    urls: one("SELECT COUNT(*) n FROM urls"),
    domains: one("SELECT COUNT(DISTINCT domain) n FROM urls"),
    devices: one("SELECT COUNT(*) n FROM devices"),
    public_urls: one("SELECT COUNT(*) n FROM urls WHERE is_private=0"),
    private_urls: one("SELECT COUNT(*) n FROM urls WHERE is_private=1"),
    first_visit: (db.query("SELECT MIN(time_ms) n FROM visits").get() as { n: number }).n,
    last_visit: (db.query("SELECT MAX(time_ms) n FROM visits").get() as { n: number }).n,
  };

  // Local-time buckets — server TZ == user TZ in a local-first app.
  const byDay = all<{ d: string; n: number }>(
    `SELECT date(time_ms/1000,'unixepoch','localtime') d, COUNT(*) n
     FROM visits GROUP BY d ORDER BY d`,
  );
  const byHour = all<{ h: number; n: number }>(
    `SELECT CAST(strftime('%H', time_ms/1000,'unixepoch','localtime') AS INTEGER) h, COUNT(*) n
     FROM visits GROUP BY h ORDER BY h`,
  );
  const byDow = all<{ w: number; n: number }>(
    `SELECT CAST(strftime('%w', time_ms/1000,'unixepoch','localtime') AS INTEGER) w, COUNT(*) n
     FROM visits GROUP BY w ORDER BY w`,
  );

  const topDomains = all(
    `SELECT domain, MAX(is_private) is_private, COUNT(*) url_count, SUM(visit_count) visits
     FROM urls WHERE is_hidden=0 GROUP BY domain ORDER BY visits DESC LIMIT 15`,
  );
  const topUrls = all(
    `SELECT id, url, title, domain, is_private, visit_count, last_visited
     FROM urls WHERE is_hidden=0 ORDER BY visit_count DESC LIMIT 15`,
  );
  const busiestDays = all(
    `SELECT date(time_ms/1000,'unixepoch','localtime') d, COUNT(*) n
     FROM visits GROUP BY d ORDER BY n DESC LIMIT 10`,
  );
  const devices = all(
    `SELECT client_id, label, visit_count, first_seen, last_seen FROM devices ORDER BY visit_count DESC`,
  );

  // Liveness rollup (only meaningful once some checks have run).
  const liveness: Record<string, number> = {};
  for (const r of all<{ state: string; n: number }>(
    `SELECT json_extract(result_json,'$.state') state, COUNT(*) n
     FROM enrichments WHERE kind='liveness' AND status='done' GROUP BY state`,
  ))
    if (r.state) liveness[r.state] = r.n;
  const liveness_checked = Object.values(liveness).reduce((a, b) => a + b, 0);

  return c.json({
    totals,
    byDay,
    byHour,
    byDow,
    topDomains,
    topUrls,
    busiestDays,
    devices,
    liveness,
    liveness_checked,
  });
});
