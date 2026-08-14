# 012 — Generalize the enrichment queue past liveness

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> Drift check first: `git diff --stat a33971d..HEAD -- src/server/lib/jobs.ts src/server/routes/ai.ts src/server/routes/enrich.ts src/server/index.ts`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 6/10
- **Lenses**: inside-out (Signal 4 — the adjacent possible)
- **Effort (coarse)**: M
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: none. **Unblocks**: plan 001.

## Why this matters

The app has a durable, crash-recoverable job queue. The `enrichments` table *is* the queue: rows carry a `status`, orphaned `running` rows are reset to `pending` at boot, and a bounded worker pool drains them with per-host politeness spacing. It works well — and it is wired to exactly one job kind.

Meanwhile the two other enrichment kinds the schema declares (`summary`, `embedding`) bypass it entirely and run synchronously inside HTTP request handlers. For summaries that is fine: one page, one call, on demand. For embeddings it is not. `POST /api/ai/embed` with `scope: "all"` selects *every* public URL and awaits the provider in chunks of 100, sequentially, inside a single request — against a 60-second server idle timeout. On a database of ~30,000 URLs that is roughly 300 sequential provider round-trips on one connection. It also writes `status: 'done'` directly, so there is no `pending` row to resume from: a failure at chunk 250 loses the fact that 249 chunks succeeded from the queue's point of view (the embeddings themselves persist, but there is no progress state, no resumption, and no way for the UI to report either).

"Good" here means: after this change, a full-history embed is a background job with a progress endpoint, survives a server restart, and cannot time out an HTTP request — using the machinery that already exists rather than new machinery.

This is infrastructure, not a user-visible feature. It earns its place by removing a real data-loss risk that exists today and by unblocking plan 001, which needs a durable backfill path.

## Current state

### `src/server/lib/jobs.ts` — the queue, currently liveness-only

The file header states the design intent (lines 1–4):

```ts
/**
 * Liveness job runner. The `enrichments` table IS the queue (survives restarts).
 * A bounded worker pool claims pending rows, checks them politely, writes results.
 */
```

Five functions are exported or internal; **four of them hardcode `kind='liveness'`**.

`resetStuckJobs` (lines 24–27):

```ts
/** Crash recovery: any row left 'running' from a previous process goes back to 'pending'. */
export function resetStuckJobs(db: Database = getDb()): void {
  db.query(`UPDATE enrichments SET status='pending' WHERE kind='liveness' AND status='running'`).run();
}
```

`enqueueUrlIds` (lines 46–80) — note the `LEFT JOIN ... AND e.kind = 'liveness'` at line 55 and the literal `'liveness'` in the upsert at line 59:

```ts
export function enqueueUrlIds(ids: number[], db: Database = getDb()): number {
  if (!ids.length) return 0;
  const getUrl = db.query<
    { is_private: number; status: string | null; fetched_at: number | null; result_json: string | null },
    [number]
  >(
    `SELECT u.is_private,
            e.status, e.fetched_at, e.result_json
     FROM urls u
     LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness'
     WHERE u.id = ?`,
  );
  const upsert = db.query(
    `INSERT INTO enrichments (url_id, kind, status) VALUES ($id, 'liveness', $status)
     ON CONFLICT(url_id, kind) DO UPDATE SET status = $status, error = NULL`,
  );
```

`claimOne` (lines 82–97), with the predicate at line 88:

```ts
function claimOne(db: Database): ClaimRow | null {
  const tx = db.transaction(() => {
    const row = db
      .query<ClaimRow, []>(
        `SELECT e.id, e.url_id, u.url
         FROM enrichments e JOIN urls u ON u.id = e.url_id
         WHERE e.kind = 'liveness' AND e.status = 'pending'
         LIMIT 1`,
      )
      .get();
    if (!row) return null;
    db.query(`UPDATE enrichments SET status='running' WHERE id=$id`).run({ $id: row.id });
    return row;
  });
  return tx();
}
```

`processOne` (lines 99–129) calls `checkLiveness(row.url)` directly at line 114 — the handler is hardcoded, not dispatched.

`getLivenessStatus` (lines 151–174) filters `kind='liveness'` at lines 155 and 164.

Also relevant — the freshness/TTL logic at lines 11–12 and 29–40 is liveness-specific (it parses `state` out of `result_json` to pick a TTL). Embeddings have no meaningful TTL; once a page is embedded it stays embedded.

### `src/server/routes/ai.ts` — the bypass

`POST /api/ai/embed`, the scope selector (lines 91–112) and the synchronous loop (lines 129–151):

```ts
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
```

Note the upsert at lines 123–127 writes `'done'` on insert — never `'pending'`:

```ts
  const upsert = db.query(
    `INSERT INTO enrichments (url_id, kind, status, fetched_at, result_json)
     VALUES ($id, 'embedding', 'done', $at, $json)
     ON CONFLICT(url_id, kind) DO UPDATE SET status='done', fetched_at=$at, result_json=$json`,
  );
```

### `src/server/index.ts` — the timeout and the boot hook

Line 44:

```ts
resetStuckJobs(db); // recover any liveness jobs interrupted by a previous shutdown
```

Line 79:

```ts
export default { port: PORT, hostname: HOST, fetch: app.fetch, idleTimeout: 60 };
```

### `src/server/schema.sql:101-111` — the table already anticipates this

```sql
CREATE TABLE IF NOT EXISTS enrichments (
  id          INTEGER PRIMARY KEY,
  url_id      INTEGER NOT NULL REFERENCES urls(id),
  kind        TEXT NOT NULL,      -- 'liveness' | 'summary' | 'embedding'
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|skipped
  fetched_at  INTEGER,            -- epoch ms
  result_json TEXT,               -- kind-specific payload
  error       TEXT,
  UNIQUE(url_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_enrich_kind_status ON enrichments(kind, status);
```

The index is already `(kind, status)` — the multi-kind query pattern is pre-indexed.

### Repo conventions

- TypeScript strict, ESM, `.ts` extensions in relative imports (see any file in `src/server/`).
- One Hono router per resource in `src/server/routes/`, exported as a named const.
- Shared logic lives in `src/server/lib/`.
- Tests are fixture-based unit tests of `lib/` modules using `bun:test`. **Exemplar to match: `test/clusters.test.ts`** — it builds an in-memory or temp database, exercises a `lib/` function, and asserts on rows.
- There is **no lint step**. Do not add one, and do not reference one.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes, writes `dist/web` |
| run server | `bun run server` | logs `API listening on http://127.0.0.1:8787` |

## Scope

**In:**
- `src/server/lib/jobs.ts` — the whole file.
- `src/server/routes/ai.ts` — the `POST /api/ai/embed` handler only.
- `src/server/routes/enrich.ts` — only the call sites of `enqueueUrlIds` / status, if their signatures change.
- `src/server/index.ts` — line 44 only, if `resetStuckJobs` gains a parameter.
- A new test file `test/jobs.test.ts`.

**Out:**
- `src/server/lib/liveness.ts` — the liveness checker itself does not change. Tempting to refactor while nearby; do not.
- Summaries (`POST /api/ai/summarize`). On-demand single-page summarization is correct as-is and must keep working synchronously.
- The web UI. No component changes in this plan; a progress bar is a follow-up.
- `src/server/schema.sql` — no schema change is needed. If you believe one is, that is a STOP condition.
- The clustering and journeys build routes.

## Steps

1. **Introduce a job-kind registry in `src/server/lib/jobs.ts`.** Above `resetStuckJobs`, add a type and a table describing each queued kind:

   ```ts
   export type JobKind = "liveness" | "embedding";

   interface KindSpec {
     /** Runs one job. Returns the payload to store in result_json. */
     run(url: string): Promise<unknown>;
     /** Per-host politeness spacing applies (network fetch to arbitrary hosts). */
     politeHostGap: boolean;
     /** Given a stored row, is it still fresh enough to skip re-queueing? */
     isFresh(status: string, fetchedAt: number | null, resultJson: string | null): boolean;
   }
   ```

   Move the existing `isFresh` function to be the `liveness` spec's `isFresh`. The `embedding` spec's `isFresh` returns `status === "done"` — once embedded, always fresh (there is no TTL for an embedding).

   Leave `summary` out of `JobKind` deliberately: it is on-demand and stays synchronous.

   **Verify:** `bunx tsc --noEmit` → exits 0.

2. **Parameterize `resetStuckJobs`.** Change the signature to `resetStuckJobs(db: Database = getDb()): void` but drop the `kind` predicate entirely so it recovers *all* kinds:

   ```ts
   db.query(`UPDATE enrichments SET status='pending' WHERE status='running'`).run();
   ```

   This is safe because only queued kinds ever hold `running`, and summaries never write that status (`routes/ai.ts:56-60` writes `'done'` directly).

   **Verify:** `bunx tsc --noEmit` → exits 0, and `src/server/index.ts:44` still compiles unchanged.

3. **Parameterize `enqueueUrlIds` with a `kind` argument**, defaulting to `"liveness"` so existing callers are untouched:

   ```ts
   export function enqueueUrlIds(ids: number[], kind: JobKind = "liveness", db: Database = getDb()): number
   ```

   Replace the two hardcoded `'liveness'` literals (lines 55 and 59) with the parameter, binding it rather than interpolating it. Keep the private-host skip behavior exactly as it is — `is_private` rows become `'skipped'` and are never fetched, for every kind.

   **Note the argument order**: `db` moves to third. Update the one call site in `src/server/routes/enrich.ts` if it passes a db explicitly.

   **Verify:** `bunx tsc --noEmit` → exits 0. Then `bun test` → passes.

4. **Parameterize `claimOne` and dispatch in `processOne`.** `claimOne` takes a `kind` and binds it in the `WHERE` clause; the returned `ClaimRow` gains a `kind` field so `processOne` knows which spec to run. `processOne` replaces the direct `checkLiveness(row.url)` call with `SPECS[row.kind].run(row.url)`, and applies the per-host gap only when `politeHostGap` is true.

   The `embedding` spec's `run` calls `getProvider({ need: "embed" })` and embeds a single URL's text. Import it from `../ai/index.ts`.

   **Verify:** `bunx tsc --noEmit` → exits 0.

5. **Make `pump` drain every kind.** Change the loop to try each kind in turn rather than assuming one. Simplest correct form: iterate the registry keys, claiming from each until saturated or all empty.

   **Verify:** `bunx tsc --noEmit` → exits 0.

6. **Generalize the status reporter.** Rename `getLivenessStatus` to `getJobStatus(kind: JobKind, db?)` and parameterize both `kind='liveness'` predicates (lines 155, 164). Keep a thin `getLivenessStatus(db?)` wrapper delegating to `getJobStatus("liveness", db)` so `src/server/routes/enrich.ts` needs no change.

   The `states` breakdown (which parses `$.state` from `result_json`) is liveness-specific and will simply be empty for embeddings — that is acceptable; do not invent an embedding equivalent.

   **Verify:** `bunx tsc --noEmit` → exits 0 and `bun test` → passes.

7. **Route `POST /api/ai/embed` through the queue.** Replace the synchronous chunk loop (`routes/ai.ts:129-151`) with: resolve the scope to `ids` exactly as it does today (lines 91–112 are unchanged), then call `enqueueUrlIds(ids, "embedding")` and return immediately:

   ```ts
   const queued = enqueueUrlIds(todo.map((r) => r.id), "embedding");
   return c.json({ queued, skipped: rows.length - todo.length });
   ```

   Delete the now-unused `upsert` prepared statement (lines 123–127) and the `embedded` counter. The response shape changes from `{ embedded, skipped }` to `{ queued, skipped }`.

   **Verify:** `bunx tsc --noEmit` → exits 0. Then grep the client for the old field: `grep -rn "embedded" src/web/` — if any component reads `.embedded` from this response, update it to `.queued` (this is in scope as a one-line consequence, despite the general "no UI" boundary).

8. **Add `GET /api/ai/embed/status`** returning `getJobStatus("embedding")`, mirroring how liveness status is exposed in `src/server/routes/enrich.ts`. This is what makes the background job observable.

   **Verify:** start the server (`bun run server`), then
   `curl -s http://127.0.0.1:8787/api/ai/embed/status` → JSON containing `active`, `counts`, `total_public`.

9. **Add `test/jobs.test.ts`.** Follow the structure of `test/clusters.test.ts`.

   **Verify:** `bun test` → all tests pass, including the new ones.

10. **End-to-end check with no API key set.** Ensure `OPENAI_API_KEY` is unset, start the server, and `curl -X POST http://127.0.0.1:8787/api/ai/embed -H 'content-type: application/json' -d '{"scope":"top","n":5}'`.

    **Verify:** responds `400` with the existing message `embeddings require an OpenAI API key (OPENAI_API_KEY)` — proving the no-key path is unchanged and the AI-is-optional invariant holds.

## Test plan

`test/jobs.test.ts`, against a temporary database seeded with a handful of `urls` rows:

- **Kind isolation:** enqueue three ids as `"embedding"`, then assert `claimOne`-equivalent selection for `"liveness"` returns nothing. Must assert the *count* of rows per kind, not merely that a call succeeded.
- **Private hosts are never queued, for every kind:** seed one `is_private=1` row, enqueue it as `"embedding"`, assert its `enrichments` row has `status='skipped'` and that no provider call could have occurred. This guards the privacy invariant across the generalization — the single most important assertion in this file.
- **Freshness differs by kind:** a `done` liveness row older than the 7-day TTL re-queues to `pending`; a `done` embedding row of any age does not.
- **Crash recovery covers all kinds:** insert one `running` liveness row and one `running` embedding row, call `resetStuckJobs`, assert *both* are `pending`.
- **`UNIQUE(url_id, kind)` is respected:** enqueueing the same id twice for the same kind produces exactly one row.

Each assertion must check actual row contents from the database. A test that only asserts a function returned without throwing is a review failure.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including the new `test/jobs.test.ts`
- [ ] `bun run build` completes
- [ ] `grep -n "'liveness'" src/server/lib/jobs.ts` returns **no** hardcoded predicate inside a query string (the word may still appear in the `JobKind` type and the registry key)
- [ ] `POST /api/ai/embed {"scope":"all"}` returns in under one second with a `queued` count, rather than blocking
- [ ] `GET /api/ai/embed/status` reports non-zero `counts.pending` immediately after that call
- [ ] Restarting the server mid-run leaves no rows stuck in `running` (check: `SELECT status, COUNT(*) FROM enrichments GROUP BY status`)
- [ ] With no API key set, the embed endpoint still returns its original 400 message

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- You conclude a schema change is required. It is not; if the design seems to need one, the design has drifted — stop and report.
- Any step's **Verify** fails twice.
- `bun test` shows a *pre-existing* failure before you start. Record it and stop; do not fix unrelated tests inside this plan.
- You find yourself changing `src/server/lib/liveness.ts`, any web component beyond the one-line field rename in step 7, or the summarize endpoint.
- The per-host politeness gap or the private-host skip would be weakened for any kind. Both are load-bearing safety behavior — stop rather than relax them.

## Maintenance notes

**Makes easier:** plan 001 (persisting page text) needs a durable backfill over ~30k URLs and becomes a third `JobKind` with a spec entry rather than another bespoke loop. A progress UI for any long enrichment becomes one status endpoint away. Re-embedding after a model change becomes a queue drain rather than a request that times out.

**Makes harder:** `pump` now round-robins across kinds, so a large embedding backlog and a liveness sweep compete for the same 12 worker slots. If that becomes a problem, per-kind concurrency limits are the natural next step — deliberately left out here to keep the change reviewable.

**Deliberately not done:** no progress bar in the UI; no per-kind concurrency; no priority ordering between kinds; summaries remain synchronous and unqueued.

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\012-generalize-enrichment-queue.md in full
before doing anything. It is a self-contained implementation plan: follow the
executor instructions at the top, run the drift check first, execute the steps
in order verifying each before moving on, and stop at any STOP condition. Scope:
parameterize the enrichment job queue in src/server/lib/jobs.ts by job kind and
route the embedding endpoint through it, so full-history embedding becomes a
durable background job instead of a synchronous request that can time out. Work
on a branch; when done, report against the Done criteria checklist.
```
