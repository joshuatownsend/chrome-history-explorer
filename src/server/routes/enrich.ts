import { Hono } from "hono";
import { getDb } from "../db.ts";
import { enqueueUrlIds, getLivenessStatus } from "../lib/jobs.ts";

export const enrich = new Hono();

/** POST /api/enrich/liveness/ensure { url_ids:[] } — lazy on-view checking. */
enrich.post("/liveness/ensure", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url_ids?: unknown };
  const ids = Array.isArray(body.url_ids)
    ? body.url_ids.map(Number).filter((n) => Number.isInteger(n))
    : [];
  const queued = enqueueUrlIds(ids.slice(0, 500));
  return c.json({ queued });
});

/**
 * POST /api/enrich/liveness/batch { scope, n?, domain?, days? }
 * Scoped batch — explicit, no "check everything". Scopes: top | domain | recent.
 */
enrich.post("/liveness/batch", async (c) => {
  const db = getDb();
  const body = (await c.req.json().catch(() => ({}))) as {
    scope?: string;
    n?: number;
    domain?: string;
    days?: number;
  };

  let ids: number[] = [];
  if (body.scope === "top") {
    const n = Math.min(Math.max(body.n ?? 500, 1), 5000);
    ids = db
      .query<{ id: number }, [number]>(
        `SELECT id FROM urls WHERE is_private=0 ORDER BY visit_count DESC LIMIT ?`,
      )
      .all(n)
      .map((r) => r.id);
  } else if (body.scope === "domain" && body.domain) {
    ids = db
      .query<{ id: number }, [string]>(`SELECT id FROM urls WHERE is_private=0 AND domain=?`)
      .all(body.domain)
      .map((r) => r.id);
  } else if (body.scope === "recent") {
    const days = Math.min(Math.max(body.days ?? 30, 1), 365);
    const since = Date.now() - days * 86_400_000;
    ids = db
      .query<{ id: number }, [number]>(
        `SELECT id FROM urls WHERE is_private=0 AND last_visited >= ? ORDER BY last_visited DESC`,
      )
      .all(since)
      .map((r) => r.id);
  } else {
    return c.json({ error: "scope must be one of: top, domain, recent" }, 400);
  }

  const queued = enqueueUrlIds(ids);
  return c.json({ scope: body.scope, candidates: ids.length, queued });
});

/** GET /api/enrich/liveness/status — queue + classification progress. */
enrich.get("/liveness/status", (c) => c.json(getLivenessStatus()));

/** GET /api/enrich/liveness?ids=1,2,3 — current liveness for specific URLs (UI merge). */
enrich.get("/liveness", (c) => {
  const db = getDb();
  const ids = (new URL(c.req.url).searchParams.get("ids") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .slice(0, 500);
  if (!ids.length) return c.json({ rows: [] });
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT url_id, status, result_json
       FROM enrichments WHERE kind='liveness' AND url_id IN (${placeholders})`,
    )
    .all(...ids);
  return c.json({ rows });
});
