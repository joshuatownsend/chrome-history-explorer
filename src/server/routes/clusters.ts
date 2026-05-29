import { Hono } from "hono";
import { getDb } from "../db.ts";
import { buildClusters } from "../lib/clusters.ts";
import { getProvider } from "../ai/index.ts";
import { completeLabel } from "../lib/labels.ts";
import { parsePage } from "../lib/query.ts";

export const clusters = new Hono();

const DAY = 86_400_000;

/**
 * POST /api/clusters/build { k?, max?, prefer? } — rebuild the Interest Map.
 * Clusters are k-means topic groups over embeddings; each non-empty cluster is
 * then named with one LLM call (heuristic top-domain label if no provider).
 */
clusters.post("/build", async (c) => {
  const db = getDb();
  const body = (await c.req.json().catch(() => ({}))) as { k?: number; max?: number; prefer?: string };

  const result = buildClusters(db, { k: body.k, max: body.max });
  if (!result.clusters) {
    return c.json({ ...result, labeled: 0, note: "no embeddings — run POST /api/ai/embed { scope: 'all' } first" });
  }

  const provider = getProvider({ need: "summarize", prefer: body.prefer });
  let labeled = 0;
  if (provider) {
    const system =
      "You name a topic cluster from a person's browsing history. Given page titles " +
      "that were grouped together by meaning, infer the single theme. Reply in the form " +
      "`TITLE — SUMMARY`: a specific 2-5 word TITLE for the theme, an em dash, then one " +
      "factual sentence. No preamble, no quotes.";
    const update = db.query(
      `UPDATE clusters SET label = $label, description = $desc, label_source = 'llm' WHERE id = $id`,
    );
    // Label clusters concurrently — K is small (<=24) and each is one short call,
    // so this keeps the synchronous build fast instead of serializing K round-trips.
    const labels = await Promise.all(
      result.summaries.map(async (s) => {
        if (!s.repTitles.length) return null;
        const r = await completeLabel(provider, system, "Page titles:\n" + s.repTitles.map((t) => `- ${t}`).join("\n"));
        return r ? { id: s.id, ...r } : null; // null leaves the heuristic label
      }),
    );
    const tx = db.transaction(() => {
      for (const l of labels) if (l) (update.run({ $label: l.label, $desc: l.description, $id: l.id }), labeled++);
    });
    tx();
  }

  return c.json({
    clusters: result.clusters,
    members: result.members,
    embedded: result.embedded,
    trained_on: result.trained_on,
    labeled,
  });
});

/** GET /api/clusters — the map: clusters by size, with sample domains. */
clusters.get("/", (c) => {
  const db = getDb();
  const rows = db
    .query(
      `SELECT cl.id, cl.label, cl.description, cl.size, cl.label_source,
              (SELECT group_concat(d, ', ') FROM (
                 SELECT u.domain AS d, COUNT(*) n FROM cluster_members cm
                 JOIN urls u ON u.id = cm.url_id
                 WHERE cm.cluster_id = cl.id AND u.domain IS NOT NULL
                   AND u.is_hidden = 0 AND u.is_private = 0
                 GROUP BY u.domain ORDER BY n DESC LIMIT 3)) AS top_domains
         FROM clusters cl
        ORDER BY cl.size DESC`,
    )
    .all();
  return c.json({ rows });
});

/**
 * GET /api/clusters/trends — per-cluster momentum: visits in the last 90 days
 * vs the prior 90, as a percent change. Rising/declining interests.
 * Registered before /:id so the static path isn't captured as an id.
 */
clusters.get("/trends", (c) => {
  const db = getDb();
  const now = Date.now();
  const recentFrom = now - 90 * DAY;
  const priorFrom = now - 180 * DAY;

  const rows = db
    .query<{ cluster_id: number; recent: number; prior: number }, { $recent: number; $prior: number }>(
      // Join urls and re-check flags: privacy/ignore rules may have changed since
      // the map was built, and cluster_members is not recomputed until rebuild.
      `SELECT cm.cluster_id,
              SUM(CASE WHEN v.time_ms >= $recent THEN 1 ELSE 0 END) AS recent,
              SUM(CASE WHEN v.time_ms >= $prior AND v.time_ms < $recent THEN 1 ELSE 0 END) AS prior
         FROM cluster_members cm
         JOIN urls u ON u.id = cm.url_id
         JOIN visits v ON v.url_id = cm.url_id
        WHERE u.is_hidden = 0 AND u.is_private = 0
        GROUP BY cm.cluster_id`,
    )
    .all({ $recent: recentFrom, $prior: priorFrom });

  const labels = new Map(
    (db.query(`SELECT id, label FROM clusters`).all() as { id: number; label: string | null }[]).map((r) => [
      r.id,
      r.label,
    ]),
  );

  const out = rows
    .map((r) => ({
      cluster_id: r.cluster_id,
      label: labels.get(r.cluster_id) ?? null,
      recent: r.recent,
      prior: r.prior,
      // null pct = "new" (no prior-window activity); guards divide-by-zero.
      pct: r.prior > 0 ? Math.round(((r.recent - r.prior) / r.prior) * 100) : r.recent > 0 ? null : 0,
    }))
    .filter((r) => r.recent + r.prior > 0)
    .sort((a, b) => {
      const av = a.pct == null ? Infinity : a.pct;
      const bv = b.pct == null ? Infinity : b.pct;
      return Math.abs(bv) - Math.abs(av);
    });

  return c.json({ rows: out, recent_days: 90 });
});

/** GET /api/clusters/:id?limit&offset — member pages, most representative first. */
clusters.get("/:id", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const { limit, offset } = parsePage(new URL(c.req.url).searchParams);

  const cluster = db.query(`SELECT id, label, description, size, label_source FROM clusters WHERE id = ?`).get(id);
  if (!cluster) return c.json({ error: "cluster not found" }, 404);

  const members = db
    .query(
      `SELECT u.id AS url_id, u.url, u.title, u.domain, u.is_private,
              u.visit_count, u.last_visited, cm.distance,
              e.status AS liveness, e.result_json AS liveness_json
         FROM cluster_members cm
         JOIN urls u ON u.id = cm.url_id
         LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness'
        WHERE cm.cluster_id = $id AND u.is_hidden = 0 AND u.is_private = 0
        ORDER BY cm.distance ASC
        LIMIT $limit OFFSET $offset`,
    )
    .all({ $id: id, $limit: limit, $offset: offset });

  return c.json({ cluster, members });
});
