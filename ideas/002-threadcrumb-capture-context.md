# 002 — Put liveness and transition into the ThreadCrumb capture

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> Drift check first: `git diff --stat a33971d..HEAD -- src/server/routes/threadcrumb.ts src/server/lib/threadcrumb.ts src/server/schema.sql`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 10/10
- **Lenses**: inside-out (Signal 2 — stated-but-undelivered) / outside-in (`interview`)
- **Effort (coarse)**: S
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: none

## Why this matters

Asked what feature only he would think of, the maintainer answered: **"Better integration with ThreadCrumb."** That is the whole demand signal, and it is the strongest kind — the primary user naming his own priority.

It is also under-specified, and this plan is honest about that. What it delivers is the concrete, already-identified first step; what it *also* delivers is a short list of the next design decisions, so "better integration" stops being a wish and becomes a sequence.

The concrete step was identified by the maintainer himself, in `INSIGHTS.md:68`:

> "**`captureContext` is the one real design lever** (in `routes/threadcrumb.ts:buildCaptureContext`). It ships a sensible default, but it's deliberately the spot to shape what a history link *becomes* in your inbox — e.g. promote liveness status or transition type into the context so ThreadCrumb's AI can triage dead links differently. Worth a look once you see how the captures land."

Today the capture carries six fields, none of which is liveness or transition. So an intent inbox receiving a history link cannot distinguish "an article I meant to read" from "a page that 404s now" — even though this app has *already computed that verdict* and displays it as a badge two pixels from the send button.

**"Good" looks like:** a link arriving in ThreadCrumb carrying enough context that triage on the receiving end is possible without re-fetching anything. The leverage is a cross-source join the inbox could never perform for itself.

## Current state

### `src/server/routes/threadcrumb.ts` — the whole surface

The context builder, lines 22–36. Note the doc comment already frames it as the customization seam:

```ts
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
```

The row query, lines 50–55 — it fetches only `urls` columns, no join to `enrichments`:

```ts
  const u = db
    .query<UrlRow, [string]>(
      `SELECT id, url, title, is_private, is_hidden, visit_count, device_count, first_visited, last_visited
       FROM urls WHERE url = ?`,
    )
    .get(url);
```

The privacy gate, lines 57–62 — **this must not change**:

```ts
  // Only forward links that exist in this history (not a generic relay)…
  if (!u) return c.json({ error: "URL is not in your history" }, 404);
  // …and never send anything flagged private or hidden to an external service.
  if (u.is_private || u.is_hidden) {
    return c.json({ error: "refused: private/hidden URLs are never sent to external services" }, 403);
  }
```

The existing sources lookup, lines 64–67, shows the established pattern for a second query per send:

```ts
  const sources = db
    .query<{ source: string }, [number]>(`SELECT DISTINCT source FROM visits WHERE url_id = ?`)
    .all(u.id)
    .map((r: { source: string }) => r.source);
```

### `src/server/lib/threadcrumb.ts` — the transport, unchanged by this plan

`sendToThreadcrumb` (lines 30–53) posts to `/api/discovery-events` with a Bearer token read from `process.env.THREADCRUMB_TOKEN`. `captureContext` is passed through verbatim (line 44). **The token is never logged and must never be.**

### Where the two new fields come from

**Liveness** — `enrichments` with `kind='liveness'`, `status='done'`, the verdict inside `result_json`. The shape is defined in `src/server/lib/liveness.ts:10-18`:

```ts
export interface LivenessResult {
  state: LivenessState;
  status_code: number | null;
  final_url: string | null; // after redirects
  fetched_at: number; // epoch ms
  archived_url?: string;
  archived_timestamp?: string;
  error?: string;
}
```

`state` is one of `live | dead | blocked | rate-limited | error` (lines 3–8). `archived_url` is present only for dead links (lines 97–103) — which makes it exactly the field an inbox wants for a dead capture.

Six other routes already join liveness this way; `src/server/routes/sessions.ts:32-35` is a clean exemplar to copy:

```sql
       LEFT JOIN urls u ON u.url = t.current_url
       LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness'
```

**Transition** — `visits.transition`, normalized to `link|typed|reload|form|bookmark|redirect|generated|other` (`src/server/schema.sql:44`). It is per-visit, so a per-URL summary is needed: the *dominant* transition (most frequent) is the useful signal. `typed` and `bookmark` indicate deliberate navigation; `link` indicates drift.

Note: Takeout exports carry no transition types (README "Notes & limitations"), so this field is `null` for Takeout-only URLs. That is correct and must be represented as `null`, not invented.

### Repo conventions

TypeScript strict, ESM, `.ts` extensions on relative imports. One Hono router per resource. Tests are `bun:test` unit tests of `lib/` modules — exemplar `test/clusters.test.ts`. No lint step.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes |
| run server | `bun run server` | logs `API listening on http://127.0.0.1:8787` |

## Scope

**In:**
- `src/server/routes/threadcrumb.ts` — the row query and `buildCaptureContext`.
- New: `test/threadcrumb.test.ts`.

**Out:**
- `src/server/lib/threadcrumb.ts` — the transport and the ThreadCrumb request shape do not change. Only the opaque `captureContext` payload does.
- The privacy gate at lines 57–62. Do not touch, do not "optimize", do not merge into the main query in a way that changes its behavior.
- The web UI. `ThreadcrumbButton.tsx` sends a URL and needs no change.
- Any bidirectional or pull-from-ThreadCrumb work. See "Design questions" — that is deliberately not in this plan.

## Steps

1. **Extend the row query with the liveness join.** In `src/server/routes/threadcrumb.ts`, change the query at lines 50–55 to `LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness' AND e.status = 'done'`, selecting `e.result_json AS liveness_json`. Add `liveness_json: string | null` to the `UrlRow` interface.

   Use a `LEFT JOIN` — a URL that has never been liveness-checked must still send successfully.

   **Verify:** `bunx tsc --noEmit` → exits 0.

2. **Add a dominant-transition lookup**, following the existing `sources` pattern at lines 64–67 (a separate small query, not a join into the main row query):

   ```ts
   const dominantTransition = (db
     .query<{ transition: string | null; n: number }, [number]>(
       `SELECT transition, COUNT(*) n FROM visits
        WHERE url_id = ? AND transition IS NOT NULL
        GROUP BY transition ORDER BY n DESC LIMIT 1`,
     )
     .get(u.id) ?? {}).transition ?? null;
   ```

   **Verify:** `bunx tsc --noEmit` → exits 0.

3. **Extend `buildCaptureContext`** to take the two new inputs and emit them. Parse `liveness_json` defensively — it is user-data-shaped JSON from the database and a parse failure must not break a send:

   ```ts
   function buildCaptureContext(
     u: UrlRow,
     sources: string[],
     transition: string | null,
   ): Record<string, unknown> {
     let liveness: { state?: string; statusCode?: number | null; checkedAt?: string | null; archivedUrl?: string } | null = null;
     try {
       if (u.liveness_json) {
         const l = JSON.parse(u.liveness_json);
         liveness = {
           state: l.state,
           statusCode: l.status_code ?? null,
           checkedAt: l.fetched_at ? new Date(l.fetched_at).toISOString() : null,
           ...(l.archived_url ? { archivedUrl: l.archived_url } : {}),
         };
       }
     } catch {
       liveness = null;
     }

     return {
       visitCount: u.visit_count,
       deviceCount: u.device_count,
       firstVisited: u.first_visited ? new Date(u.first_visited).toISOString() : null,
       lastVisited: u.last_visited ? new Date(u.last_visited).toISOString() : null,
       historySources: sources,
       liveness,                 // null when never checked
       dominantTransition: transition, // null for Takeout-only URLs
       sentFrom: "chrome-history-explorer",
     };
   }
   ```

   Keep field naming camelCase to match the six existing fields. Emit `null` rather than omitting a key — a consumer can then distinguish "not checked" from "field not supported by this sender version".

   **Verify:** `bunx tsc --noEmit` → exits 0, `bun test` → passes.

4. **Manual end-to-end check.** With `THREADCRUMB_TOKEN` set, send a URL that has a known liveness verdict. Confirm the capture arrives and the context contains both new keys.

   **Verify:** the ThreadCrumb response is 2xx and the stored `captureContextJson` shows `liveness.state` and `dominantTransition`. If you cannot inspect the receiving side, log the payload locally *once* during development and remove the log before finishing — and **never log the Authorization header or the token**.

5. **Confirm the unconfigured path is unchanged.** With `THREADCRUMB_TOKEN` unset:

   **Verify:** `curl -s -X POST http://127.0.0.1:8787/api/threadcrumb/send -H 'content-type: application/json' -d '{"url":"https://example.com"}'` → returns 400 with `ThreadCrumb not configured (set THREADCRUMB_TOKEN)`.

## Test plan

`test/threadcrumb.test.ts`. Export `buildCaptureContext` (or extract it to `src/server/lib/threadcrumb.ts`) so it is unit-testable without a network call. Do not test against the live ThreadCrumb API.

- **Liveness present:** given a row with a `done` liveness enrichment whose `result_json` has `state: "dead"` and an `archived_url`, assert the built context has `liveness.state === "dead"` and `liveness.archivedUrl` set.
- **Liveness absent:** given no enrichment row, assert `liveness === null` and that the function does not throw.
- **Malformed liveness JSON:** given `result_json` of `"{not json"`, assert `liveness === null` and no throw. This is the guard that matters — a corrupt row must never break a send.
- **Dominant transition:** seed five visits — three `link`, two `typed` — and assert `dominantTransition === "link"`. Then seed a URL with all-`null` transitions (the Takeout case) and assert `dominantTransition === null`.
- **Existing fields are unchanged:** assert all six original keys are still present with their original names and value shapes. This is a contract test; ThreadCrumb stores the context verbatim and a silent rename would break the receiving side.
- **Privacy gate holds:** assert that a `is_private=1` or `is_hidden=1` URL is rejected before any context is built. Seed both cases.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including `test/threadcrumb.test.ts`
- [ ] `bun run build` completes
- [ ] A send for a never-liveness-checked URL still succeeds, with `liveness: null`
- [ ] A send for a Takeout-only URL still succeeds, with `dominantTransition: null`
- [ ] A private or hidden URL is still refused with 403 and the original message
- [ ] With no token set, the endpoint still returns its original 400
- [ ] No token, header, or secret value appears in any log line or test fixture
- [ ] The six pre-existing context fields are byte-identical in name and shape

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- You find yourself modifying the privacy gate at `routes/threadcrumb.ts:57-62`.
- You are about to change the request body in `src/server/lib/threadcrumb.ts:37-45` (the `sourceType`/`captureChannel` contract). That is a ThreadCrumb-side coordination, not a local change.
- Any step's **Verify** fails twice.
- You are tempted to start on bidirectional sync. Out of scope — record it as a design question instead.

## Design questions — the rest of "better integration"

Not in scope for this plan; recorded so the next step is a decision rather than a fresh start. Answer these against how the captures actually land in the inbox.

1. **Should sending be bulk?** Today it is one URL, one click. The natural bulk unit already exists: a Research Session's trail, or a "Pick Back Up" card. Is "send this whole rabbit hole as one intent" useful, or noise?
2. **Should the app know what it already sent?** There is no record of sends anywhere — no table, no column. Re-sending is safe (ThreadCrumb dedupes by URL) but the UI cannot show "already sent", and the app cannot answer "what did I forward last week". A `kind='threadcrumb'` enrichment row would fix this cheaply and reuse the existing table.
3. **Should the topic label ride along?** The Interest Map assigns most public URLs to a named cluster. Sending `topic: "Tax filing and investment accounts"` would let an inbox group captures by subject without any AI call of its own — arguably a stronger triage signal than liveness.
4. **Should dead links be sent at all, or sent as their archive?** For a `dead` capture the app holds a Wayback URL. Forwarding `archived_url` as the primary link (with the original preserved) may be more useful than forwarding a URL that 404s.
5. **Is there a pull direction?** Everything today is push. Whether the inbox has anything worth reflecting back into history is a ThreadCrumb-side question this repository cannot answer alone.

## Maintenance notes

**Makes easier:** the capture context becomes an obvious place to add anything else the app computes per URL — topic label, summary, first-seen device — each a one-line addition once the join pattern is established.

**Makes harder:** the context payload is now a de facto contract with the receiving side. Renaming a field silently changes behavior for an already-populated inbox. Treat additions as safe and renames as breaking.

**Deliberately not done:** no send history, no bulk send, no topic label, no archive substitution, no pull direction. All five are recorded above as design questions.

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\002-threadcrumb-capture-context.md in full
before doing anything. It is a self-contained implementation plan: follow the
executor instructions at the top, run the drift check first, execute the steps
in order verifying each before moving on, and stop at any STOP condition. Scope:
add liveness verdict and dominant transition type to the ThreadCrumb capture
context in src/server/routes/threadcrumb.ts, so a forwarded history link carries
enough context for triage on the receiving end. Do not change the privacy gate,
the transport, or the ThreadCrumb request contract, and never log the token.
Work on a branch; when done, report against the Done criteria checklist.
```
