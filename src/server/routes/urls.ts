import { Hono } from "hono";
import { getDb } from "../db.ts";
import { buildWhere, parseFilters, parsePage, parseSort } from "../lib/query.ts";

export const urls = new Hono();

/** GET /api/urls — paginated, sortable, filterable list of URL entities. */
urls.get("/", (c) => {
  const db = getDb();
  const params = new URL(c.req.url).searchParams;
  const f = parseFilters(params);
  const { sql: where, params: wp } = buildWhere(f);
  const { col, dir } = parseSort(params);
  const { limit, offset } = parsePage(params);

  const total = (
    db.query(`SELECT COUNT(*) n FROM urls u ${where}`).get(wp) as { n: number }
  ).n;

  const rows = db
    .query(
      `SELECT u.id, u.url, u.hostname, u.domain, u.title, u.is_private,
              u.visit_count, u.first_visited, u.last_visited, u.device_count,
              e.status AS liveness, e.result_json AS liveness_json
       FROM urls u
       LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness'
       ${where}
       ORDER BY ${col} ${dir} NULLS LAST
       LIMIT $limit OFFSET $offset`,
    )
    .all({ ...wp, $limit: limit, $offset: offset });

  return c.json({ total, limit, offset, rows });
});

/** GET /api/urls/:id/visits — visit timeline for one URL. */
urls.get("/:id/visits", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const rows = db
    .query(
      `SELECT v.time_ms, v.client_id, d.label AS device_label
       FROM visits v LEFT JOIN devices d ON d.client_id = v.client_id
       WHERE v.url_id = $id ORDER BY v.time_ms DESC`,
    )
    .all({ $id: id });
  return c.json({ rows });
});
