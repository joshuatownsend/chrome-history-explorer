import { Hono } from "hono";
import { getDb } from "../db.ts";
import { buildWhere, parseFilters, parsePage } from "../lib/query.ts";

export const domains = new Hono();

const DOMAIN_SORT: Record<string, string> = {
  visits: "visits",
  urls: "url_count",
  last_visited: "last_visited",
  domain: "u.domain",
};

/** GET /api/domains — aggregates grouped by eTLD+1 (the group-by-domain view). */
domains.get("/", (c) => {
  const db = getDb();
  const params = new URL(c.req.url).searchParams;
  const f = parseFilters(params);
  const { sql: where, params: wp } = buildWhere(f);
  const { limit, offset } = parsePage(params);
  const sortCol = DOMAIN_SORT[params.get("sort") ?? ""] ?? "visits";
  const dir = (params.get("dir") ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  const total = (
    db
      .query(`SELECT COUNT(DISTINCT u.domain) n FROM urls u ${where}`)
      .get(wp) as { n: number }
  ).n;

  const rows = db
    .query(
      `SELECT u.domain,
              MAX(u.is_private) AS is_private,
              COUNT(*)          AS url_count,
              SUM(u.visit_count) AS visits,
              MIN(u.first_visited) AS first_visited,
              MAX(u.last_visited)  AS last_visited
       FROM urls u
       ${where}
       GROUP BY u.domain
       ORDER BY ${sortCol} ${dir} NULLS LAST
       LIMIT $limit OFFSET $offset`,
    )
    .all({ ...wp, $limit: limit, $offset: offset });

  return c.json({ total, limit, offset, rows });
});
