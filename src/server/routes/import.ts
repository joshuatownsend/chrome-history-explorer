import { Hono } from "hono";
import { getDb } from "../db.ts";
import { createLoader, finalize } from "../lib/load.ts";
import { createSource } from "../lib/sources/index.ts";
import { detectProfiles } from "../lib/sources/detect.ts";

export const importRoutes = new Hono();
export const sourcesRoute = new Hono();

/** GET /api/sources — provenance breakdown of loaded visits. */
sourcesRoute.get("/", (c) => {
  const db = getDb();
  const rows = db
    .query(
      `SELECT source, COUNT(*) visits, COUNT(DISTINCT url_id) urls,
              MIN(time_ms) first_visit, MAX(time_ms) last_visit
       FROM visits GROUP BY source ORDER BY visits DESC`,
    )
    .all();
  return c.json({ rows });
});

/** GET /api/import/detect — local browser profiles available to import. */
importRoutes.get("/detect", (c) => c.json({ profiles: detectProfiles() }));

/**
 * POST /api/import/run { labels: string[] } — import the selected detected
 * profiles into the DB. Runs synchronously; fine for a local single-user app.
 */
importRoutes.post("/run", async (c) => {
  const db = getDb();
  const body = (await c.req.json().catch(() => ({}))) as { labels?: string[] };
  const labels = Array.isArray(body.labels) ? body.labels : [];
  if (!labels.length) return c.json({ error: "no profiles selected" }, 400);

  const detected = detectProfiles(false);
  const loader = createLoader(db);
  const results: { label: string; inserted?: number; error?: string }[] = [];

  for (const label of labels) {
    const match = detected.find((p) => p.label === label);
    if (!match) {
      results.push({ label, error: "profile not found" });
      continue;
    }
    try {
      const source = createSource(match.kind, match.path, match.label);
      results.push({ label, inserted: loader.loadVisits(source.source, source.readVisits()) });
    } catch (err) {
      results.push({ label, error: err instanceof Error ? err.message : String(err) });
    }
  }

  finalize(db); // recompute aggregates/FTS/privacy once after all imports
  const totalInserted = results.reduce((s, r) => s + (r.inserted ?? 0), 0);
  return c.json({ totalInserted, results });
});
