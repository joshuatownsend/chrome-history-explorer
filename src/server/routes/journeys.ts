import { Hono } from "hono";
import { getDb } from "../db.ts";
import { buildJourneys } from "../lib/journeys.ts";
import { getProvider } from "../ai/index.ts";

export const journeys = new Hono();

/** POST /api/journeys/build { gapMinutes?, minPages?, days? } — recompute all journeys. */
journeys.post("/build", async (c) => {
  const db = getDb();
  const body = (await c.req.json().catch(() => ({}))) as {
    gapMinutes?: number;
    minPages?: number;
    days?: number;
  };
  const created = buildJourneys(db, {
    gapMinutes: body.gapMinutes,
    minPages: body.minPages,
    days: body.days,
  });
  return c.json({ journeys: created });
});

/** GET /api/journeys?from&to&device&limit&offset — newest-first list with a title preview. */
journeys.get("/", (c) => {
  const db = getDb();
  const sp = new URL(c.req.url).searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 50), 1), 200);
  const offset = Math.max(Number(sp.get("offset") ?? 0), 0);

  const clauses: string[] = [];
  const params: Record<string, string | number> = {};
  const from = Number(sp.get("from"));
  const to = Number(sp.get("to"));
  const device = sp.get("device");
  if (Number.isFinite(from) && sp.get("from")) (clauses.push("j.end_ms >= $from"), (params.$from = from));
  if (Number.isFinite(to) && sp.get("to")) (clauses.push("j.start_ms <= $to"), (params.$to = to));
  if (device) (clauses.push("j.client_id = $device"), (params.$device = device));
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // "hops" surfaces the deepest rabbit holes; default is newest-first.
  const orderBy = sp.get("sort") === "hops" ? "j.link_hops DESC, j.url_count DESC" : "j.start_ms DESC";

  const total = (
    db.query(`SELECT COUNT(*) n FROM journeys j ${where}`).get(params) as { n: number }
  ).n;

  const rows = db
    .query(
      `SELECT j.id, j.client_id, j.start_ms, j.end_ms, j.visit_count, j.url_count,
              j.domain_count, j.link_hops, j.label, j.description, j.label_source,
              d.label AS device_label,
              eu.title AS entry_title, eu.domain AS entry_domain,
              xu.title AS exit_title, xu.domain AS exit_domain,
              (SELECT group_concat(t, ' • ') FROM (
                 SELECT u2.title AS t FROM journey_visits jv
                 JOIN urls u2 ON u2.id = jv.url_id
                 WHERE jv.journey_id = j.id AND u2.title IS NOT NULL
                 ORDER BY jv.ord LIMIT 6)) AS preview
         FROM journeys j
         LEFT JOIN devices d ON d.client_id = j.client_id
         LEFT JOIN urls eu ON eu.id = j.entry_url_id
         LEFT JOIN urls xu ON xu.id = j.exit_url_id
         ${where}
        ORDER BY ${orderBy}
        LIMIT $limit OFFSET $offset`,
    )
    .all({ ...params, $limit: limit, $offset: offset });

  return c.json({ total, limit, offset, rows });
});

/** GET /api/journeys/:id — the ordered page trail, with liveness joined. */
journeys.get("/:id", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const journey = db
    .query(
      `SELECT j.*, d.label AS device_label
         FROM journeys j LEFT JOIN devices d ON d.client_id = j.client_id
        WHERE j.id = ?`,
    )
    .get(id);
  if (!journey) return c.json({ error: "journey not found" }, 404);

  const visits = db
    .query(
      `SELECT jv.ord, jv.time_ms, jv.transition,
              u.id AS url_id, u.url, u.title, u.domain, u.is_private,
              e.status AS liveness, e.result_json AS liveness_json
         FROM journey_visits jv
         JOIN urls u ON u.id = jv.url_id
         LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness'
        WHERE jv.journey_id = $id
        ORDER BY jv.ord`,
    )
    .all({ $id: id });

  return c.json({ journey, visits });
});

/** Title-case a label only when the model SHOUTED it back in all caps. */
function tidyLabel(s: string): string {
  const label = s.trim().replace(/^["']|["']$/g, "");
  if (label && label === label.toUpperCase() && /[A-Z]/.test(label)) {
    return label.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
  }
  return label;
}

/** Parse the LLM reply into a short title + one-line description. */
function parseLabel(raw: string): { label: string; description: string } {
  const text = raw.trim();
  const clean = (d: string) => d.trim().replace(/\s+/g, " ");
  const dash = text.match(/^(.{2,90}?)\s[—–-]\s(.+)$/s);
  if (dash) return { label: tidyLabel(dash[1]), description: clean(dash[2]) };
  const nl = text.indexOf("\n");
  if (nl > 1) return { label: tidyLabel(text.slice(0, nl)), description: clean(text.slice(nl + 1)) };
  return { label: tidyLabel(text.slice(0, 80)), description: clean(text) };
}

/** POST /api/journeys/:id/label { prefer? } — name a journey with one LLM call. */
journeys.post("/:id/label", async (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { prefer?: string };

  const journey = db.query(`SELECT id, label, description FROM journeys WHERE id = ?`).get(id) as
    | { id: number; label: string | null; description: string | null }
    | null;
  if (!journey) return c.json({ error: "journey not found" }, 404);

  const provider = getProvider({ need: "summarize", prefer: body.prefer });
  // No AI configured → keep the heuristic label the build already stored.
  if (!provider) {
    return c.json({ label: journey.label, description: journey.description, label_source: "heuristic" });
  }

  // Only non-private, non-hidden pages are ever sent to an AI provider (mirrors
  // ai.ts). is_hidden is checked here too: ignore rules added AFTER a build are
  // not reflected in journey_visits, so filtering at label time prevents a
  // now-ignored URL from being disclosed to the provider.
  const pages = db
    .query<{ title: string | null; domain: string | null }, [number]>(
      `SELECT u.title, u.domain
         FROM journey_visits jv JOIN urls u ON u.id = jv.url_id
        WHERE jv.journey_id = ? AND u.is_private = 0 AND u.is_hidden = 0
        ORDER BY jv.ord`,
    )
    .all(id);

  // Dedupe titles, cap to bound tokens.
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const p of pages) {
    const t = (p.title || p.domain || "").trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      titles.push(t);
      if (titles.length >= 40) break;
    }
  }
  if (!titles.length) {
    return c.json({ label: journey.label, description: journey.description, label_source: "heuristic" });
  }

  const system =
    "You name a browsing session for someone reviewing their own history. " +
    "Given the page titles a person visited back-to-back in one sitting, infer the single " +
    "task or topic they were working on. Reply in the form `TITLE — SUMMARY`: a specific " +
    "3-7 word TITLE naming what they were doing, an em dash, then one factual sentence. " +
    "No preamble, no quotes, do not mention 'browsing session'.";
  const userMsg = "Page titles, in order:\n" + titles.map((t) => `- ${t}`).join("\n");

  let raw: string;
  try {
    raw = await provider.complete(system, userMsg);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  const { label, description } = parseLabel(raw);
  db.query(
    `UPDATE journeys SET label = $label, description = $desc, label_source = 'llm' WHERE id = $id`,
  ).run({ $label: label, $desc: description, $id: id });

  return c.json({ label, description, label_source: "llm", provider: provider.name });
});
