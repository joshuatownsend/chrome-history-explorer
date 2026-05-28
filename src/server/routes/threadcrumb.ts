import { Hono } from "hono";
import { getDb } from "../db.ts";
import { sendToThreadcrumb, threadcrumbConfig } from "../lib/threadcrumb.ts";

export const threadcrumb = new Hono();

/** GET /api/threadcrumb/config — whether sending is enabled + the target base URL. */
threadcrumb.get("/config", (c) => c.json(threadcrumbConfig()));

interface UrlRow {
  id: number;
  url: string;
  title: string | null;
  is_private: number;
  is_hidden: number;
  visit_count: number;
  device_count: number;
  first_visited: number | null;
  last_visited: number | null;
}

/**
 * What a history row carries into ThreadCrumb's intent inbox. ThreadCrumb stores
 * this verbatim as captureContextJson. This is the customization seam — these are
 * the columns chrome-history already knows about each URL; trim or extend to taste.
 */
function buildCaptureContext(u: UrlRow, sources: string[]): Record<string, unknown> {
  return {
    visitCount: u.visit_count,
    deviceCount: u.device_count,
    firstVisited: u.first_visited ? new Date(u.first_visited).toISOString() : null,
    lastVisited: u.last_visited ? new Date(u.last_visited).toISOString() : null,
    historySources: sources, // e.g. ["takeout", "chrome:Default"]
    sentFrom: "chrome-history-explorer",
  };
}

/** POST /api/threadcrumb/send { url } — forward a known, public history link to ThreadCrumb. */
threadcrumb.post("/send", async (c) => {
  if (!threadcrumbConfig().configured) {
    return c.json({ error: "ThreadCrumb not configured (set THREADCRUMB_TOKEN)" }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as { url?: string };
  const url = (body.url ?? "").trim();
  if (!url) return c.json({ error: "url required" }, 400);
  if (!/^https?:\/\//i.test(url)) return c.json({ error: "only http(s) URLs can be sent" }, 400);

  const db = getDb();
  const u = db
    .query<UrlRow, [string]>(
      `SELECT id, url, title, is_private, is_hidden, visit_count, device_count, first_visited, last_visited
       FROM urls WHERE url = ?`,
    )
    .get(url);

  // Only forward links that exist in this history (not a generic relay)…
  if (!u) return c.json({ error: "URL is not in your history" }, 404);
  // …and never send anything flagged private or hidden to an external service.
  if (u.is_private || u.is_hidden) {
    return c.json({ error: "refused: private/hidden URLs are never sent to external services" }, 403);
  }

  const sources = db
    .query<{ source: string }, [number]>(`SELECT DISTINCT source FROM visits WHERE url_id = ?`)
    .all(u.id)
    .map((r: { source: string }) => r.source);

  try {
    const result = await sendToThreadcrumb({
      url: u.url,
      title: u.title,
      capturedAt: u.last_visited ? new Date(u.last_visited).toISOString() : undefined,
      captureContext: buildCaptureContext(u, sources),
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
