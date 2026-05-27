import { Hono } from "hono";
import { getDb } from "../db.ts";

export const sessions = new Hono();

/** GET /api/sessions — saved windows, newest first, with a title preview. */
sessions.get("/", (c) => {
  const db = getDb();
  const rows = db
    .query(
      `SELECT s.id, s.session_tag, s.window_id, s.last_active_ms, s.tab_count,
              (SELECT group_concat(current_title, ' • ')
                 FROM (SELECT current_title FROM session_tabs t
                       WHERE t.session_id = s.id AND current_title IS NOT NULL
                       ORDER BY t.id LIMIT 5)) AS preview
       FROM sessions s
       ORDER BY s.last_active_ms DESC NULLS LAST`,
    )
    .all();
  return c.json({ rows });
});

/** GET /api/sessions/:id — tabs in a window + each tab's navigation stack. */
sessions.get("/:id", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));

  const tabs = db
    .query(
      `SELECT t.id, t.tab_id, t.pinned, t.current_nav_index, t.browser_type,
              t.last_active_ms, t.current_url, t.current_title,
              e.status AS liveness, e.result_json AS liveness_json
       FROM session_tabs t
       LEFT JOIN urls u ON u.url = t.current_url
       LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness'
       WHERE t.session_id = $id
       ORDER BY t.pinned DESC, t.id`,
    )
    .all({ $id: id }) as { id: number }[];

  const navs = db
    .query(
      `SELECT n.tab_pk, n.idx, n.title, n.virtual_url, n.timestamp_ms, n.http_status
       FROM tab_navigations n
       JOIN session_tabs t ON t.id = n.tab_pk
       WHERE t.session_id = $id
       ORDER BY n.tab_pk, n.idx`,
    )
    .all({ $id: id }) as { tab_pk: number }[];

  const byTab = new Map<number, unknown[]>();
  for (const n of navs) {
    const arr = byTab.get(n.tab_pk) ?? [];
    arr.push(n);
    byTab.set(n.tab_pk, arr);
  }
  const withNavs = tabs.map((t) => ({ ...t, navigation: byTab.get(t.id) ?? [] }));

  return c.json({ id, tabs: withNavs });
});
