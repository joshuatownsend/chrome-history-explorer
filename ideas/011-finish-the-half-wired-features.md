# 011 — Finish the three half-wired features

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> Drift check first: `git diff --stat a33971d..HEAD -- src/web/api.ts src/web/components/ src/web/lib/ src/server/routes/urls.ts src/server/routes/ai.ts src/server/lib/load.ts src/server/lib/journeys.ts`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 7/10
- **Lenses**: inside-out (Signal 1 — unfinished intent)
- **Effort (coarse)**: S
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: none

## Why this matters

Three features in this app are built on the server, typed in the client, and connected to nothing. Someone stopped one component short, three separate times.

**A. The per-URL visit timeline.** `GET /api/urls/:id/visits` exists and returns per-visit timestamps with device labels. `api.urlVisits(id)` exists with a full typed response. **No component calls it** — `grep -rn "urlVisits" src/web/ | grep -v api.ts` returns nothing. So the All-URLs table shows "visited 40 times across 3 devices" and offers no way to see *when*.

**B. Stored AI summaries are never read back.** `GET /api/ai/summary?ids=` exists to bulk-fetch summaries; `api.aiSummariesFor` exists. **No component calls it either.** `SummaryButton` starts at `"idle"` and its only network call is a *generate*. The consequence has a price: a summary generated yesterday is invisible today, and clicking ✨ again spends another provider call on a page already summarized. The README sells embedding persistence as "a one-time cost per URL" — summaries get the same durable storage and none of the payoff.

**C. An import silently invalidates Research Sessions and the Interest Map.** The maintainer's own comment records it (`src/server/lib/journeys.ts:8-9`): any new import invalidates them, with no incremental path. `finalize()` rebuilds aggregates, FTS and privacy — and does not touch `journeys` or `clusters`. The Import view says only "Reload other views to see the merged data", so a user reloads Research Sessions and sees bursts computed from the pre-import visit log, with nothing indicating they are stale.

This bites hardest on the workflow that is the product's core insight (`INSIGHTS.md:74`): local Chrome expires at ~90 days while Takeout holds a year, so the two are complementary archives and re-importing periodically is *expected*. Every one of those re-imports silently desynchronizes the two most expensive views.

**"Good" looks like:** you can see when you visited something, a summary you already paid for is just there, and the app tells you when a derived view is out of date instead of quietly lying.

## Current state

### A — the timeline endpoint, `src/server/routes/urls.ts:36-48`

```ts
/** GET /api/urls/:id/visits — visit timeline for one URL. */
urls.get("/:id/visits", (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  const rows = db
    .query(
      `SELECT v.time_ms, v.client_id, d.label AS device_label
       FROM visits v LEFT JOIN devices d ON d.client_id = v.client_id
       WHERE v.url_id = $id ORDER BY v.time_ms DESC`,
    )
    .all({ $id: id });
  return c.json({ rows });
});
```

Note: **no LIMIT.** A URL with thousands of visits returns thousands of rows. Step 2 addresses this.

### B — the summary read-back endpoint, `src/server/routes/ai.ts:65-76`

```ts
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
```

And the component that ignores it, `src/web/components/SummaryButton.tsx:8-26`:

```tsx
export function SummaryButton({ urlId, isPrivate, enabled }: { urlId: number; isPrivate: boolean; enabled: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [text, setText] = useState("");

  if (isPrivate || !enabled) return null;

  const run = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === "loading") return;
    setState("loading");
    const res = await api.summarize(urlId);
```

`useState("idle")` with no read-on-mount is the whole bug.

### The pattern to copy for B — `src/web/lib/useLazyLiveness.ts:9-23`

This project already solved "fetch extra data for the visible page of rows in one batched call":

```ts
export function useLazyLiveness(rows: UrlRow[]): Map<number, LivenessInfo> {
  const [overrides, setOverrides] = useState<Map<number, LivenessInfo>>(new Map());
  const requested = useRef<Set<number>>(new Set());
  ...
    const pending = rows
      .filter((r) => !r.is_private && r.liveness == null && !requested.current.has(r.id))
      .map((r) => r.id);
    if (!pending.length) return;
    pending.forEach((id) => requested.current.add(id));
```

**Copy this shape exactly** — a `requested` ref preventing refetch, a filter that skips private URLs, and a `Map` of overrides merged by the consumer. Summaries are simpler: no polling, one fetch.

### C — what `finalize()` does and does not do, `src/server/lib/load.ts:120-159`

It recomputes `urls` and `devices` aggregates, rebuilds the contentless FTS index, and calls `recomputePrivacy(db)`. It never mentions `journeys`, `journey_visits`, `clusters` or `cluster_members`.

Both import paths call it and stop — `src/server/routes/import.ts:54` and `src/server/ingest.ts:115`.

The rebuild endpoints already exist: `POST /api/journeys/build` and `POST /api/clusters/build`.

`src/web/components/ImportView.tsx:32-36` is the message that under-informs:

```ts
      setStatus(
        `Imported ${fmtNum(res.totalInserted)} new visits from ${res.results.length - errs.length} profile(s)` +
          (errs.length ? `; ${errs.length} failed (${errs.map((e) => e.label).join(", ")})` : "") +
          ". Reload other views to see the merged data.",
      );
```

**Design constraint for C:** do **not** auto-rebuild after import. Journey and cluster builds are expensive (clustering is ~20s and clusters need embeddings, which cost money). The README is also explicit that source selection is deliberate. The right behavior is to *tell the user*, with a button — not to decide for them.

### Repo conventions

TypeScript strict, ESM, `.ts` extensions on relative imports. Hooks live in `src/web/lib/`, components in `src/web/components/`, all fetches through `api.*`. Tailwind utility classes inline; match neighbouring components rather than adding styles. Tests are `bun:test` unit tests of server `lib/` modules; **there is no frontend test setup — do not add one.** No lint step.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes |
| dev | `bun run dev` | Vite on :5173 proxying the API on :8787 |

## Scope

**In:**
- `src/server/routes/urls.ts` — add a LIMIT to the visits endpoint.
- New: `src/web/lib/useSummaries.ts`.
- `src/web/components/SummaryButton.tsx` — accept an existing summary.
- `src/web/components/HistoryTable.tsx` and `SearchView.tsx` — wire the hook, add the timeline expander.
- New: `src/server/lib/buildstate.ts` + a small route — the staleness signal.
- `src/web/components/JourneysView.tsx`, `InterestMapView.tsx`, `ImportView.tsx` — the banner and message.
- `src/web/api.ts` — types and one new method.

**Out:**
- **Auto-rebuilding journeys or clusters after an import.** Explicitly forbidden; see the design constraint above.
- Any change to `src/server/lib/journeys.ts` or `clusters.ts` build logic.
- Any change to how summaries are *generated*.
- A frontend test framework.
- Persisting a build-state table via schema migration — use the data already available (see step 6).

## Steps

### Part A — the visit timeline

1. **Bound the endpoint.** Add `LIMIT 500` to the query in `src/server/routes/urls.ts:41-45` and return a `total` count alongside, so the UI can say "showing 500 of 2,310".

   **Verify:** `curl -s "http://127.0.0.1:8787/api/urls/1/visits" | head -c 200` → JSON with `rows` and `total`.

2. **Add a row expander in `HistoryTable.tsx`.** Clicking a row (or a small chevron) toggles a detail panel that calls `api.urlVisits(id)` once, caches the result in component state, and renders the visits grouped by device label, newest first. Show relative dates using the existing `src/web/lib/format.ts` helpers rather than new formatting.

   Keep it inside the virtualized table's existing row rendering — do not fetch for rows that are not expanded.

   **Verify:** `bun run build` → completes. Then `bun run dev`, expand a row with a high visit count, and confirm the timeline appears and that collapsing/re-expanding does **not** refetch.

### Part B — read stored summaries back

3. **Create `src/web/lib/useSummaries.ts`**, modelled directly on `useLazyLiveness`:

   ```ts
   export function useSummaries(rows: UrlRow[], enabled: boolean): Map<number, string>
   ```

   Filter to non-private rows not already requested, batch the ids (the endpoint caps at 200 — chunk if the visible set is larger), call `api.aiSummariesFor`, parse `result_json` defensively, and return a `Map<url_id, summary>`. Return an empty map immediately when `enabled` is false, so a no-key install makes no requests at all.

   **Verify:** `bunx tsc --noEmit` → exits 0.

4. **Teach `SummaryButton` to accept an existing summary.** Add an optional `existing?: string` prop. When present, render the summary text directly and do not render the ✨ button — the page has already been paid for.

   Do not add a fetch inside the component; the batched hook is the only reader. Per-row fetching is the thing `useLazyLiveness` exists to avoid.

   **Verify:** `bunx tsc --noEmit` → exits 0.

5. **Wire the hook** in `HistoryTable.tsx` and `SearchView.tsx` next to the existing `useLazyLiveness` call, passing `existing={summaries.get(row.id)}` into `SummaryButton`.

   **Verify:** `bun run dev`. Summarize a page, reload the browser, and confirm the summary is **still displayed** with no ✨ button and no provider call. **This is the check the whole of Part B exists for.**

### Part C — the staleness signal

6. **Create `src/server/lib/buildstate.ts`** exporting a function that reports whether the derived views are behind the visit log, using only data already in the database:

   ```ts
   export interface BuildState {
     latestVisitMs: number | null;   // MAX(time_ms) FROM visits
     journeysLatestMs: number | null; // MAX(end_ms) FROM journeys
     clustersBuiltAt: number | null;  // MAX(built_at) FROM clusters
     journeysStale: boolean;
     clustersStale: boolean;
   }
   ```

   `journeysStale` is `latestVisitMs > journeysLatestMs`. `clustersStale` is `latestVisitMs > clustersBuiltAt`. Both are false when the derived table is empty — an unbuilt view is not a *stale* view, and saying otherwise would nag a new user who has never built one.

   No schema change: `journeys.end_ms` and `clusters.built_at` (`src/server/schema.sql:121,152`) already carry what is needed.

   **Verify:** `bunx tsc --noEmit` → exits 0.

7. **Expose it** at `GET /api/stats/build-state` (add to the existing `src/server/routes/stats.ts` rather than creating a new router for one handler).

   **Verify:** `curl -s http://127.0.0.1:8787/api/stats/build-state` → JSON with both booleans.

8. **Add the banner.** In `JourneysView.tsx` and `InterestMapView.tsx`, when the relevant `*Stale` flag is true, render a dismissible notice above the content: what it means in plain words ("These were built before your last import"), and a button that calls the existing rebuild endpoint.

   Wording matters here — say what is out of date and what the button will do. Do not say "error"; nothing is broken.

   **Verify:** import anything, open Research Sessions → the banner appears. Click rebuild → it disappears.

9. **Fix the import message** in `ImportView.tsx:32-36`. Replace "Reload other views to see the merged data" with something that names the consequence: merged data is visible immediately, but Research Sessions and the Interest Map were built from older data and can be rebuilt from their own tabs.

   **Verify:** run an import and read the message as a first-time user would. It should leave no ambiguity about what is and is not up to date.

## Test plan

Only Part C has server-side logic worth unit-testing. Parts A and B are UI wiring over endpoints that already exist, and this repo has no frontend test setup — their verification is the manual checks in steps 2 and 5, which are in the Done criteria.

`test/buildstate.test.ts`, against a temporary database:

- **Journeys stale:** seed a visit at T+100 and a journey with `end_ms` at T; assert `journeysStale === true`.
- **Journeys fresh:** journey `end_ms` at T+100, latest visit at T+100; assert `false`. (Equal is *not* stale — an off-by-one here produces a banner that never goes away, which trains the user to ignore it.)
- **Empty tables are not stale:** no journeys rows at all → `journeysStale === false`, and `journeysLatestMs === null`. Same for clusters. This is the assertion that protects a first-run user from a nag about something they have never built.
- **Clusters use `built_at`, not visit times:** seed clusters with a `built_at` after the latest visit; assert `clustersStale === false`.
- **No visits at all:** every field null, both flags false, no throw.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including `test/buildstate.test.ts`
- [ ] `bun run build` completes
- [ ] Expanding a row shows its visit timeline; collapsing and re-expanding does not refetch
- [ ] `GET /api/urls/:id/visits` is bounded by a LIMIT and returns a total
- [ ] A previously-generated summary is visible after a browser reload, with no ✨ button and no provider call
- [ ] With no AI key configured, no summary requests are made at all (check the network tab)
- [ ] After an import, Research Sessions and the Interest Map show a rebuild banner; rebuilding clears it
- [ ] A fresh database with no journeys and no clusters shows **no** banner
- [ ] The import success message names what is and isn't up to date
- [ ] Nothing rebuilds automatically after an import

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- You are about to auto-rebuild journeys or clusters after an import.
- You are about to add a schema migration or a build-state table. The existing columns are sufficient.
- You are about to add a frontend testing framework.
- You are about to make `SummaryButton` fetch per row rather than reading from the batched hook.
- Any step's **Verify** fails twice.
- Part A, B or C proves larger than expected — they are independent; ship the ones that work and report the one that did not, rather than half-landing all three.

## Maintenance notes

**Makes easier:** `useSummaries` establishes the batched-read pattern for any future per-URL enrichment (page text from plan 001, topic labels), so the third one is copy-and-adjust. `buildstate.ts` gives any future derived view a place to declare its freshness.

**Makes harder:** two more hooks now fire on every visible row change in the two busiest tables. Both are guarded by a `requested` ref, but if a third arrives it is worth combining them into one batched enrichment fetch rather than adding a third round-trip.

**Deliberately not done:** no incremental journey rebuild (`journeys.ts:8-9` explains why there is no incremental path — that is a real design problem, not an oversight, and is out of scope); no auto-rebuild; no visit timeline in the domain tree or Interest Map, only the two table views.

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\011-finish-the-half-wired-features.md in full
before doing anything. It is a self-contained implementation plan: follow the
executor instructions at the top, run the drift check first, execute the steps in
order verifying each before moving on, and stop at any STOP condition. Scope:
three independent completions of already-built-but-unwired features — (A) render
the per-URL visit timeline from the existing GET /api/urls/:id/visits endpoint,
(B) read stored AI summaries back via the existing GET /api/ai/summary endpoint so
a summary is never paid for twice, and (C) show a "built before your last import"
banner on Research Sessions and the Interest Map. Do NOT auto-rebuild anything
after an import, and do not add a schema migration or a frontend test framework.
The three parts are independent — if one proves larger than expected, ship the
others and report. Work on a branch; when done, report against the Done criteria
checklist.
```
