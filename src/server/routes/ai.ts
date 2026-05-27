import { Hono } from "hono";
import { getDb } from "../db.ts";
import { getProvider, providerInfo } from "../ai/index.ts";
import { cosine } from "../ai/provider.ts";
import { fetchReadableText } from "../lib/extract.ts";

export const ai = new Hono();

/** GET /api/ai/config — which providers are configured + enrichment counts. */
ai.get("/config", (c) => {
  const db = getDb();
  const n = (kind: string) =>
    (db.query(`SELECT COUNT(*) n FROM enrichments WHERE kind=? AND status='done'`).get(kind) as {
      n: number;
    }).n;
  return c.json({
    providers: providerInfo(),
    summaries: n("summary"),
    embeddings: n("embedding"),
  });
});

interface UrlMeta {
  id: number;
  url: string;
  title: string | null;
  is_private: number;
}

/** POST /api/ai/summarize { url_id, prefer? } — fetch page + summarize on demand. */
ai.post("/summarize", async (c) => {
  const db = getDb();
  const body = (await c.req.json().catch(() => ({}))) as { url_id?: number; prefer?: string };
  const u = db
    .query<UrlMeta, [number]>(`SELECT id, url, title, is_private FROM urls WHERE id=?`)
    .get(Number(body.url_id));
  if (!u) return c.json({ error: "url not found" }, 404);
  if (u.is_private) return c.json({ error: "private/LAN URLs are not sent to AI providers" }, 400);

  const provider = getProvider({ need: "summarize", prefer: body.prefer });
  if (!provider) return c.json({ error: "no AI provider configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)" }, 400);

  const page = await fetchReadableText(u.url);
  if (!page || page.text.length < 50) {
    return c.json({ error: "could not fetch readable content (page may be dead or JS-only)" }, 422);
  }

  let summary: string;
  try {
    summary = await provider.summarize(u.title || page.title, page.text);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  const result = { summary, provider: provider.name, generated_at: Date.now() };
  db.query(
    `INSERT INTO enrichments (url_id, kind, status, fetched_at, result_json)
     VALUES ($id, 'summary', 'done', $at, $json)
     ON CONFLICT(url_id, kind) DO UPDATE SET status='done', fetched_at=$at, result_json=$json, error=NULL`,
  ).run({ $id: u.id, $at: result.generated_at, $json: JSON.stringify(result) });

  return c.json(result);
});

/** GET /api/ai/summary?ids=1,2 — existing summaries. */
ai.get("/summary", (c) => {
  const db = getDb();
  const ids = (new URL(c.req.url).searchParams.get("ids") ?? "")
    .split(",").map(Number).filter(Number.isInteger).slice(0, 200);
  if (!ids.length) return c.json({ rows: [] });
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .query(`SELECT url_id, result_json FROM enrichments WHERE kind='summary' AND status='done' AND url_id IN (${ph})`)
    .all(...ids);
  return c.json({ rows });
});

/** POST /api/ai/embed { scope, n?, domain?, days? } — build embeddings for semantic search. */
ai.post("/embed", async (c) => {
  const db = getDb();
  const provider = getProvider({ need: "embed" });
  if (!provider) return c.json({ error: "embeddings require an OpenAI API key (OPENAI_API_KEY)" }, 400);

  const body = (await c.req.json().catch(() => ({}))) as {
    scope?: string;
    n?: number;
    domain?: string;
    days?: number;
  };

  let rows: UrlMeta[] = [];
  if (body.scope === "top") {
    rows = db
      .query<UrlMeta, [number]>(
        `SELECT id, url, title, is_private FROM urls WHERE is_private=0 ORDER BY visit_count DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(body.n ?? 1000, 1), 5000));
  } else if (body.scope === "domain" && body.domain) {
    rows = db
      .query<UrlMeta, [string]>(`SELECT id, url, title, is_private FROM urls WHERE is_private=0 AND domain=?`)
      .all(body.domain);
  } else {
    return c.json({ error: "scope must be 'top' or 'domain'" }, 400);
  }

  // Skip ones already embedded.
  const todo = rows.filter(
    (r) =>
      !db.query(`SELECT 1 FROM enrichments WHERE url_id=? AND kind='embedding' AND status='done'`).get(r.id),
  );
  if (!todo.length) return c.json({ embedded: 0, skipped: rows.length });

  const upsert = db.query(
    `INSERT INTO enrichments (url_id, kind, status, fetched_at, result_json)
     VALUES ($id, 'embedding', 'done', $at, $json)
     ON CONFLICT(url_id, kind) DO UPDATE SET status='done', fetched_at=$at, result_json=$json`,
  );

  let embedded = 0;
  // Batch in chunks to respect token/request limits.
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    const inputs = chunk.map((r) => `${r.title ?? ""} ${r.url}`.slice(0, 800));
    let vectors: number[][];
    try {
      vectors = await provider.embed(inputs);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), embedded }, 502);
    }
    const tx = db.transaction(() => {
      chunk.forEach((r, j) => {
        upsert.run({
          $id: r.id,
          $at: Date.now(),
          $json: JSON.stringify({ vector: vectors[j], model: "openai", dim: vectors[j]?.length }),
        });
        embedded++;
      });
    });
    tx();
  }

  return c.json({ embedded, skipped: rows.length - todo.length });
});

/** POST /api/ai/search { q, limit? } — semantic search over stored embeddings. */
ai.post("/search", async (c) => {
  const db = getDb();
  const body = (await c.req.json().catch(() => ({}))) as { q?: string; limit?: number };
  const q = (body.q ?? "").trim();
  if (!q) return c.json({ rows: [] });

  const provider = getProvider({ need: "embed" });
  if (!provider) return c.json({ error: "semantic search requires an OpenAI API key" }, 400);

  const stored = db
    .query<{ url_id: number; result_json: string }, []>(
      `SELECT url_id, result_json FROM enrichments WHERE kind='embedding' AND status='done'`,
    )
    .all();
  if (!stored.length) return c.json({ rows: [], note: "no embeddings yet — build them first" });

  let qvec: number[];
  try {
    qvec = (await provider.embed([q]))[0];
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  const limit = Math.min(Math.max(body.limit ?? 30, 1), 100);
  const scored = stored
    .map((s) => {
      let score = 0;
      try {
        score = cosine(qvec, JSON.parse(s.result_json).vector);
      } catch {
        /* ignore */
      }
      return { url_id: s.url_id, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Hydrate with URL data.
  const ph = scored.map(() => "?").join(",");
  const meta = db
    .query(`SELECT id, url, title, domain, is_private, visit_count, last_visited FROM urls WHERE id IN (${ph})`)
    .all(...scored.map((s) => s.url_id)) as { id: number }[];
  const byId = new Map(meta.map((m) => [m.id, m]));
  const rows = scored.map((s) => ({ ...(byId.get(s.url_id) ?? {}), score: s.score }));

  return c.json({ rows });
});
