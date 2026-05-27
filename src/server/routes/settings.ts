import { Hono } from "hono";
import { getDb } from "../db.ts";
import { getRules, recomputePrivacy, setRules } from "../lib/rules.ts";

export const settings = new Hono();

function counts(db: ReturnType<typeof getDb>) {
  const n = (where: string) => (db.query(`SELECT COUNT(*) n FROM urls WHERE ${where}`).get() as { n: number }).n;
  return { private: n("is_private=1"), hidden: n("is_hidden=1"), total: n("1=1") };
}

/** GET /api/settings/privacy — current user rules + how many URLs they affect. */
settings.get("/privacy", (c) => {
  const db = getDb();
  return c.json({ ...getRules(db), counts: counts(db) });
});

/** PUT /api/settings/privacy — save rules and recompute flags across all URLs. */
settings.put("/privacy", async (c) => {
  const db = getDb();
  const body = (await c.req.json().catch(() => ({}))) as {
    privatePatterns?: string[];
    hiddenPatterns?: string[];
  };
  const saved = setRules(db, body);
  const result = recomputePrivacy(db, saved);
  return c.json({ ok: true, ...saved, ...result, counts: counts(db) });
});
