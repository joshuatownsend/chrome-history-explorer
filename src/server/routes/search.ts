import { Hono } from "hono";
import { getDb } from "../db.ts";
import { buildWhere, parseFilters, parsePage } from "../lib/query.ts";

export const search = new Hono();

/**
 * Turn raw user text into a safe FTS5 MATCH expression: each whitespace term is
 * double-quoted (so punctuation can't break the parser) and prefix-matched (*).
 * Returns null for empty input.
 */
function toMatchQuery(raw: string): string | null {
  const terms = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return terms.length ? terms.join(" ") : null;
}

/** GET /api/search?q=... — FTS5 search with snippet highlighting + facets. */
search.get("/", (c) => {
  const db = getDb();
  const params = new URL(c.req.url).searchParams;
  const raw = params.get("q") ?? "";
  const match = toMatchQuery(raw);
  if (!match) return c.json({ total: 0, limit: 0, offset: 0, rows: [], query: raw });

  // Reuse the viewer's facet filters, but the free-text `q` is the MATCH itself.
  const f = parseFilters(params);
  delete f.q;
  const { sql: whereW, params: wp } = buildWhere(f);
  const facetAnd = whereW.replace(/^WHERE/, "AND");
  const { limit, offset } = parsePage(params);

  const base = `
    FROM urls_fts
    JOIN urls u ON u.id = urls_fts.rowid
    LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness'
    WHERE urls_fts MATCH $match ${facetAnd}`;

  const total = (
    db.query(`SELECT COUNT(*) n ${base}`).get({ ...wp, $match: match }) as { n: number }
  ).n;

  const rows = db
    .query(
      `SELECT u.id, u.url, u.hostname, u.domain, u.title, u.is_private,
              u.visit_count, u.first_visited, u.last_visited, u.device_count,
              e.status AS liveness, e.result_json AS liveness_json,
              bm25(urls_fts) AS rank
       ${base}
       ORDER BY rank
       LIMIT $limit OFFSET $offset`,
    )
    .all({ ...wp, $match: match, $limit: limit, $offset: offset });

  return c.json({ total, limit, offset, rows, query: raw });
});
