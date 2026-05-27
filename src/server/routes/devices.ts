import { Hono } from "hono";
import { getDb } from "../db.ts";

export const devices = new Hono();

/** GET /api/devices — device list (for the device filter + labeling UI). */
devices.get("/", (c) => {
  const db = getDb();
  const rows = db
    .query(
      `SELECT client_id, label, visit_count, first_seen, last_seen
       FROM devices ORDER BY visit_count DESC`,
    )
    .all();
  return c.json({ rows });
});

/** PUT /api/devices/:clientId — set a human label for a device. */
devices.put("/:clientId", async (c) => {
  const db = getDb();
  const clientId = c.req.param("clientId");
  const body = (await c.req.json().catch(() => ({}))) as { label?: string };
  db.query(`UPDATE devices SET label = $label WHERE client_id = $id`).run({
    $label: body.label ?? null,
    $id: clientId,
  });
  return c.json({ ok: true });
});
