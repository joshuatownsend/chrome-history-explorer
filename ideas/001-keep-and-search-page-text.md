# 001 — Keep the page text you already fetch, and search it

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> Drift check first: `git diff --stat a33971d..HEAD -- src/server/routes/ai.ts src/server/lib/extract.ts src/server/schema.sql src/server/db.ts src/server/routes/search.ts src/server/lib/load.ts`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 10/10
- **Lenses**: inside-out (Signal 4 — the adjacent possible) / outside-in (`live-research`)
- **Effort (coarse)**: M
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: **plan 012** for the durable backfill in step 8. Steps 1–7 can be done without it; do not attempt step 8 first.

## Why this matters

This is the largest single gap between what this app does and what people with this problem say they want — and the app is already doing nine tenths of the work.

`src/server/lib/extract.ts` fetches a page and reduces it to clean plain text. `POST /api/ai/summarize` calls it, hands the text to a provider, stores the *summary*, and throws the text away. Nothing else in the app has ever seen the contents of a page.

The consequences are everywhere:

- **Search cannot find what you remember.** The FTS5 index covers title, URL, domain and path. If you remember a phrase from the middle of an article, the app cannot find it. The browser's own history box has exactly the same limitation, which is the thing people complain about.
- **The Interest Map clusters on title strings.** Embeddings are built from `` `${r.title ?? ""} ${r.url}`.slice(0, 800) `` — so two pages titled "Docs" or "Home" land nowhere near their real topics. This is the app's most differentiated feature running on its thinnest possible input.

The demand is not inferred. From a 235-point Ask HN thread (item 30696451), the question that thread exists to ask:

> "My biggest force-multiplier is my fish shell history, going on 7 years of command line history. I want to do the same thing for my web browser. ... Is there any product out there that creates a fully searchable full-text history forever with little fuss?"

And on why the leading alternative was rejected — the same author:

> "My brain, naturally, does not know ahead of time what could be useful in the future."

Another commenter, on browsers generally (HN 45295647):

> "I've used probably 15 or 20 web browsers in my lifetime and all of them had the same barely searchable table of URLs as their only history view. Why couldn't we have full text search of the pages...?"

**"Good" looks like:** you type a phrase you half-remember from the body of a page, and the app finds it — using text it captured as a side effect of work it was already doing, stored in a file you own, with no new dependency and no new provider.

**The strategic point.** Every competitor that does this lives inside a browser extension and is bounded by extension storage quotas — one analysis of Falcon's source noted page text was never truncated inside `storage.local`; its maintainer cited the storage ceiling as the reason to decline a sync feature. A server-side SQLite file has no such ceiling. This capability is where the project's architecture is structurally advantaged, and it is currently unclaimed.

## Current state

### `src/server/lib/extract.ts` — complete, dependency-free, already working

The whole file is 53 lines. The entry point (lines 5–27):

```ts
export async function fetchReadableText(
  url: string,
): Promise<{ title: string; text: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("html") && !ct.includes("text")) return null;

    const html = await r.text();
    return { title: extractTitle(html), text: htmlToText(html) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

`htmlToText` (lines 35–43) strips script/style/noscript/svg and all tags, decodes a small entity set, and collapses whitespace. Crude, but it produces usable prose and needs no dependency.

### `src/server/routes/ai.ts` — where the text is discarded

`POST /api/ai/summarize`, lines 43–62. Note that `page.text` is used once at line 50 and never persisted:

```ts
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
```

The embedding input, line 133 — the thin input this plan replaces:

```ts
    const inputs = chunk.map((r) => `${r.title ?? ""} ${r.url}`.slice(0, 800));
```

### `src/server/schema.sql:55-62` — the FTS table to extend

```sql
-- Full-text search over the URL entity. Contentless table kept in sync by ingest.
CREATE VIRTUAL TABLE IF NOT EXISTS urls_fts USING fts5(
  title,
  url,
  domain,
  path,                          -- URL path+query, tokenized separately
  content=''                     -- external content managed manually; rowid = urls.id
);
```

**`content=''` is the critical constraint.** This is a *contentless* FTS5 table: it stores only the inverted index, not the source text. `INSIGHTS.md:142` records the consequence the maintainer already hit once:

> "Contentless FTS5 can search but can't quote. It stores only the term→rowid index, not the source text — so it answers 'which rows match?' ... but cannot produce a highlighted excerpt."

Two implications for this plan: (a) adding a `text` column to the FTS table costs index space but not a second copy of the text; (b) snippet/highlight of body text is **not** available from FTS and must come from the stored text itself. Plan accordingly — do not attempt `snippet()`.

Also note contentless tables need `INSERT INTO urls_fts(urls_fts) VALUES('delete-all')` for a full reset rather than `DELETE` (`INSIGHTS.md:155`).

### `src/server/schema.sql:101-111` — where text will live

```sql
CREATE TABLE IF NOT EXISTS enrichments (
  id          INTEGER PRIMARY KEY,
  url_id      INTEGER NOT NULL REFERENCES urls(id),
  kind        TEXT NOT NULL,      -- 'liveness' | 'summary' | 'embedding'
  status      TEXT NOT NULL DEFAULT 'pending',
  fetched_at  INTEGER,
  result_json TEXT,               -- kind-specific payload
  error       TEXT,
  UNIQUE(url_id, kind)
);
```

`UNIQUE(url_id, kind)` gives one text row per URL for free.

### Migration convention

`INSIGHTS.md:94` records the trap and the rule:

> "`CREATE TABLE IF NOT EXISTS` silently does nothing on an existing table, so a new column added inside it never appears — but a sibling `CREATE INDEX` on that column runs anyway and crashes. The fix is to separate 'create for fresh DBs' (in `schema.sql`) from 'alter for existing DBs' (in `db.ts migrate()`)."

**Follow this exactly.** Any change to an existing table or virtual table goes in *both* `schema.sql` (fresh databases) and `db.ts`'s `migrate()` (existing databases).

### Repo conventions

TypeScript strict, ESM, `.ts` extensions on relative imports. One Hono router per resource. Shared logic in `src/server/lib/`. Tests are fixture-based `bun:test` unit tests of `lib/` modules — **exemplar: `test/clusters.test.ts`**. There is no lint step.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes |
| run server | `bun run server` | logs `API listening on http://127.0.0.1:8787` |

## Scope

**In:**
- `src/server/schema.sql` — the `urls_fts` definition only.
- `src/server/db.ts` — `migrate()` only.
- `src/server/lib/extract.ts` — may gain a text-capping helper.
- `src/server/routes/ai.ts` — the summarize handler and the embedding input line.
- `src/server/routes/search.ts` — to search the new column.
- `src/server/lib/load.ts` — only the FTS re-index inside `finalize()`, and only if it must preserve stored text.
- New: `test/pagetext.test.ts`.

**Out:**
- The web UI. Search results will improve without component changes; a "matched in page text" indicator is a follow-up.
- `src/server/lib/liveness.ts`. Capturing text during liveness checks is tempting and explicitly deferred — liveness uses `HEAD` and a 1–2 byte range-GET (`liveness.ts:62`), so it has no body to keep. Changing that would make every liveness check a full page download. **Do not.**
- Any new dependency. No Readability port, no HTML parser, no vector database.
- `src/server/lib/clusters.ts` — clustering consumes embeddings and needs no change.

## Steps

1. **Add a text cap helper in `src/server/lib/extract.ts`.** Export `const MAX_TEXT_CHARS = 40_000;` and a `capText(text: string): string` returning `text.slice(0, MAX_TEXT_CHARS)`. 40k characters is roughly 10KB–40KB per page; at 30,000 pages the worst case is a few hundred megabytes, which SQLite handles comfortably. Making it a named constant is what lets it be tuned later without hunting.

   **Verify:** `bunx tsc --noEmit` → exits 0.

2. **Persist the text in the summarize handler.** In `src/server/routes/ai.ts`, immediately after the `fetchReadableText` guard (after line 46) and *before* the provider call, upsert an `enrichments` row:

   ```ts
   db.query(
     `INSERT INTO enrichments (url_id, kind, status, fetched_at, result_json)
      VALUES ($id, 'text', 'done', $at, $json)
      ON CONFLICT(url_id, kind) DO UPDATE SET status='done', fetched_at=$at, result_json=$json, error=NULL`,
   ).run({ $id: u.id, $at: Date.now(), $json: JSON.stringify({ text: capText(page.text), title: page.title }) });
   ```

   Placing it before the provider call matters: the text is worth keeping even if summarization then fails.

   **Verify:** `bunx tsc --noEmit` → exits 0. Then with a provider key set, summarize one public URL from the app and run
   `sqlite3 data/history.db "SELECT COUNT(*) FROM enrichments WHERE kind='text'"` → returns `1`.
   (If `sqlite3` is unavailable, use `bun -e "const {Database}=require('bun:sqlite');console.log(new Database('data/history.db').query(\"SELECT COUNT(*) n FROM enrichments WHERE kind='text'\").get())"`.)

3. **Add the `text` column to `urls_fts` in `schema.sql`.** Insert it after `path`:

   ```sql
   CREATE VIRTUAL TABLE IF NOT EXISTS urls_fts USING fts5(
     title,
     url,
     domain,
     path,
     text,                          -- page body, when captured (see enrichments kind='text')
     content=''
   );
   ```

   **Verify:** delete nothing yet. `bunx tsc --noEmit` → exits 0.

4. **Migrate existing databases in `db.ts` `migrate()`.** An FTS5 virtual table's column set cannot be altered — the table must be dropped and recreated, then repopulated. Add a guarded migration that: checks whether `urls_fts` already has a `text` column (query `pragma_table_info('urls_fts')`), and if not, `DROP TABLE urls_fts`, recreate it with the new definition, and re-index every row from `urls`.

   This is the riskiest step in the plan. It must be idempotent and must not lose the `urls` table.

   **Verify:** back up first — `cp data/history.db data/history.db.bak`. Then `bun run server` and confirm it starts without error. Then confirm search still works:
   `curl -s "http://127.0.0.1:8787/api/search?q=github" | head -c 200` → returns rows.
   Then re-run the server a second time to prove idempotency → starts cleanly, no error.

5. **Feed captured text into the FTS index.** Wherever the FTS row for a URL is written (find it with `grep -rn "urls_fts" src/server/`), include the text column, sourced from the `kind='text'` enrichment when one exists and empty string otherwise.

   In the summarize handler, after step 2's upsert, also refresh that URL's FTS row so newly captured text is searchable immediately rather than only after the next ingest.

   **Verify:** summarize a page containing a distinctive phrase that appears in its body but NOT in its title or URL. Then
   `curl -s "http://127.0.0.1:8787/api/search?q=<that+phrase>"` → the page is returned.
   **This single check is the whole point of the plan.** If it fails, do not proceed.

6. **Embed text instead of titles.** In `src/server/routes/ai.ts`, replace line 133's input construction so that, for each row, the input is the stored page text when available and the current `title + url` fallback otherwise. Keep the 800-character slice as the fallback path's behavior, but allow a larger slice (2,000 characters) when real text is present — richer input is the entire reason for the change.

   Build the text lookup as **one query into a Map** before the loop, matching the existing pattern at lines 114–119 (`one query into a Set instead of a probe per row`). Do not query per row.

   **Verify:** `bunx tsc --noEmit` → exits 0, `bun test` → passes.

7. **Confirm the no-key path is untouched.** With `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` both unset, start the server and use search normally.

   **Verify:** `curl -s "http://127.0.0.1:8787/api/search?q=github"` → returns rows, no error. The AI-is-optional invariant is load-bearing for this project; text capture happens only on the summarize path, which already requires a key.

8. **(Requires plan 012.)** Add `"text"` as a `JobKind` in `src/server/lib/jobs.ts` with `run` = `fetchReadableText` + capText, `politeHostGap: true`, and `isFresh` = `status === "done"`. Add a scoped backfill endpoint mirroring `POST /api/enrich/batch` so a user can capture text for the top N pages as a background job.

   **Do not attempt this step if plan 012 has not landed** — a synchronous backfill over 30k pages reproduces exactly the timeout problem plan 012 exists to remove.

   **Verify:** `POST` the backfill for `scope: "top", n: 20` → returns a `queued` count in under a second; polling the status endpoint shows the count draining to zero.

## Test plan

`test/pagetext.test.ts`, following `test/clusters.test.ts`'s structure with a temporary database:

- **Text is stored and retrievable:** insert a `urls` row, write a `kind='text'` enrichment, assert the round-tripped text matches and that `UNIQUE(url_id, kind)` yields exactly one row after two writes.
- **Capping is enforced:** `capText` on a string longer than `MAX_TEXT_CHARS` returns exactly `MAX_TEXT_CHARS` characters. Assert the length, not merely that it is shorter.
- **Body-only search works:** index a row whose distinctive term appears only in the `text` column, then assert an FTS query for that term returns that rowid — and that a query for a term in *no* column returns nothing. Both halves matter; the negative case is what proves the index isn't matching everything.
- **Private and hidden URLs never get text captured:** assert that the summarize path's existing `is_private` guard (`routes/ai.ts:38`) still rejects before any text row is written. Seed an `is_private=1` URL and assert zero `kind='text'` rows exist for it. **This is the most important assertion in the file** — page text is the most sensitive data the app would ever hold.
- **Migration idempotency:** run the `migrate()` FTS rebuild twice against the same database and assert the `urls` row count is unchanged and `urls_fts` returns the same result for a known query both times.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including `test/pagetext.test.ts`
- [ ] `bun run build` completes
- [ ] Searching a phrase that appears only in a captured page's **body** returns that page (step 5's check)
- [ ] Searching still works with no AI key configured
- [ ] Starting the server twice in a row against an existing database succeeds both times (migration is idempotent)
- [ ] `SELECT COUNT(*) FROM urls` is identical before and after the migration
- [ ] No new entry appears in `package.json` dependencies
- [ ] No `kind='text'` row exists for any URL with `is_private=1`

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- Step 4's migration loses rows from `urls`, or the second server start errors. Restore from `data/history.db.bak` and report.
- Step 5's body-phrase search does not return the page. Everything downstream depends on it; stop rather than proceeding to embeddings.
- You are about to add a dependency to `package.json`.
- You are about to modify `src/server/lib/liveness.ts` to capture bodies.
- Any step's **Verify** fails twice.
- You reach step 8 and plan 012 has not landed.

## Maintenance notes

**Makes easier:** semantic search and the Interest Map both improve with no further work once embeddings use real text. "Search the contents of pages I've read" becomes answerable. A future snippet/preview feature has real text to quote from — which the contentless FTS table can never provide on its own.

**Makes harder:** database size grows materially and unpredictably (it depends on which pages the user summarizes). `MAX_TEXT_CHARS` is the single tuning knob; consider surfacing total text bytes in the Settings view so the cost is visible rather than surprising. The FTS migration in step 4 sets a precedent — any future FTS column change requires the same drop-and-rebuild.

**Deliberately not done:** no capture during liveness checks (would turn cheap HEAD requests into full downloads); no automatic capture on ingest (the app has no network access to pages at ingest time, and doing so would fetch tens of thousands of pages unprompted); no snippet highlighting; no re-capture TTL — text is captured once and kept.

**A privacy note worth carrying forward:** this feature makes the database qualitatively more sensitive. It currently holds URLs and titles; afterwards it holds the readable content of pages the user chose to summarize. That is a good argument for shipping plan 004 (the egress audit log) alongside it, and for saying plainly in the README what is stored and where.

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\001-keep-and-search-page-text.md in full before
doing anything. It is a self-contained implementation plan: follow the executor
instructions at the top, run the drift check first, execute the steps in order
verifying each before moving on, and stop at any STOP condition. Scope: persist
the readable page text that src/server/lib/extract.ts already produces, add it
to the FTS5 index so body-text search works, and use it as the embedding input
instead of title+URL. Do not add any dependency, and do not capture text during
liveness checks. Skip step 8 unless plan 012 has already landed. Work on a
branch; when done, report against the Done criteria checklist.
```
