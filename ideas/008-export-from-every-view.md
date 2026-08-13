# 008 — Let every view export what's on screen

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> Drift check first: `git diff --stat a33971d..HEAD -- src/server/lib/query.ts src/server/routes/urls.ts src/server/routes/journeys.ts src/server/routes/clusters.ts src/server/routes/insights.ts src/web/api.ts`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 8/10
- **Lenses**: inside-out (Signal 3 — surface asymmetries) / outside-in (`live-research`)
- **Effort (coarse)**: M
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: none

## Why this matters

There are four ways to get data into this app and **zero** ways to get anything out.

Verified by grep across the whole repository: no `text/csv`, no `Content-Disposition`, no download endpoint anywhere in `src/server`; no `Blob`, no `URL.createObjectURL`, no anchor `download` attribute anywhere in `src/web`. There are no DELETE routes either — the route inventory is overwhelmingly GET, with two PUTs and a handful of side-effecting POSTs.

For a local-first tool whose landing page promises "from a flat log to something you can think with", that one-way door is the conspicuous missing half. The app spends real compute — and real provider spend — producing artifacts that exist nowhere else on earth: AI-named Research Sessions, k-means topic labels, liveness verdicts, the Graveyard. Today the only way to get any of it out is a screenshot.

The demand is moderate but consistent. Personal-knowledge-management export requests recur on the closest comparator's tracker (Promnesia #243 "Joplin integration", 5 reactions; #192 "Better integration with Logseq?", 7 comments; #464 "Connecting this to PKMs?"). None of them are large individually — this is well-evidenced catch-up rather than a differentiator, and the plan is scoped accordingly.

**"Good" looks like:** whatever list you are looking at, with whatever filters you have applied, you can get as CSV for a spreadsheet, JSON for a script, or Markdown for your notes — and the export respects exactly the same privacy rules the view does.

## Current state

### The filter layer that makes this cheap — `src/server/lib/query.ts:32-74`

```ts
export function buildWhere(f: UrlFilters): { sql: string; params: Record<string, string | number> } {
  // Hidden URLs ("ignore" rules) are excluded from every browsing view.
  const clauses: string[] = ["u.is_hidden = 0"];
  const params: Record<string, string | number> = {};

  if (f.domain) {
    clauses.push("u.domain = $domain");
    params.$domain = f.domain;
  }
  if (f.privacy === "public") clauses.push("u.is_private = 0");
  if (f.privacy === "private") clauses.push("u.is_private = 1");
  ...
```

**`u.is_hidden = 0` is hardcoded as the first clause of every filtered query.** That is the property this whole plan leans on: if export reuses `parseFilters` + `buildWhere`, it inherits the privacy posture automatically rather than re-deriving it. Any export path that hand-rolls its own SQL loses that guarantee — which is why step 2 is written the way it is.

### The list endpoint to mirror — `src/server/routes/urls.ts:7-34`

```ts
/** GET /api/urls — paginated, sortable, filterable list of URL entities. */
urls.get("/", (c) => {
  const db = getDb();
  const params = new URL(c.req.url).searchParams;
  const f = parseFilters(params);
  const { sql: where, params: wp } = buildWhere(f);
  const { col, dir } = parseSort(params);
  const { limit, offset } = parsePage(params);
  ...
  const rows = db
    .query(
      `SELECT u.id, u.url, u.hostname, u.domain, u.title, u.is_private,
              u.visit_count, u.first_visited, u.last_visited, u.device_count,
              e.status AS liveness, e.result_json AS liveness_json
       FROM urls u
       LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness'
       ${where}
       ORDER BY ${col} ${dir} NULLS LAST
       LIMIT $limit OFFSET $offset`,
    )
    .all({ ...wp, $limit: limit, $offset: offset });
```

An export is this query without the page limit and with a different serialization.

Note `parsePage` (`query.ts:96-98`) clamps `limit` to a maximum of 500. Export needs a different, much larger bound — see step 3.

### The security context

`src/server/index.ts:49` wraps every `/api` route in `localGuard(ALLOWED_HOSTS)`, the DNS-rebinding and CSRF guard. That is what makes a bulk-data endpoint acceptable on a no-auth tool: a malicious website you visit cannot drive it. **Export must stay behind that guard** — do not mount it outside `/api`.

### Repo conventions

TypeScript strict, ESM, `.ts` extensions on relative imports. One Hono router per resource with JSDoc per handler. Shared logic in `src/server/lib/`. Tests are `bun:test` unit tests of `lib/` modules — exemplar `test/clusters.test.ts`. No lint step. No CSV or serialization dependency exists and none should be added — CSV is a small, well-understood format and the escaping rules fit in twenty lines.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes |
| run server | `bun run server` | logs `API listening on http://127.0.0.1:8787` |

## Scope

**In:**
- New: `src/server/lib/serialize.ts` — CSV and Markdown serializers, pure functions.
- New: `src/server/routes/export.ts` — one router, mounted in `src/server/index.ts`.
- `src/web/api.ts` — a helper that triggers a browser download.
- `src/web/components/Filters.tsx` (or the nearest shared toolbar) — an export control.
- New: `test/serialize.test.ts`.

**Out:**
- Any change to `src/server/lib/query.ts`. Export **consumes** `parseFilters`/`buildWhere` unchanged. Modifying them risks the `is_hidden = 0` guarantee that every browsing view depends on.
- Import of exported files. Round-tripping is a different feature with different validation needs.
- Any DELETE route or data removal. Out of scope entirely.
- A serialization dependency.
- Export of raw `visits` rows. URL-level entities and derived artifacts only — a full visit-log dump is a different feature (arguably a backup, which the parked ledger covers) and would be tens of megabytes.
- PDF, XLSX, or anything binary.

## Steps

1. **Write `src/server/lib/serialize.ts`** with three pure exports:

   ```ts
   export function toCsv(rows: Record<string, unknown>[], columns: string[]): string;
   export function toJson(rows: unknown[]): string;
   export function toMarkdown(rows: Record<string, unknown>[], columns: string[]): string;
   ```

   CSV rules, all of which the tests pin:
   - Fields containing a comma, a double quote, `\r` or `\n` are wrapped in double quotes; embedded double quotes are doubled (RFC 4180).
   - `null` and `undefined` serialize to an empty field, never the string `"null"`.
   - Line terminator is `\r\n`.
   - **A field beginning with `=`, `+`, `-` or `@` is prefixed with a single quote.** This is CSV injection defence: page titles are attacker-influenced text (any website can set its own `<title>`), and a title like `=HYPERLINK(...)` becomes a live formula when the export is opened in a spreadsheet. This project's data is *unusually* likely to contain hostile titles, because it indexes the whole web.

   Markdown emits a pipe table with `|` escaped inside cells.

   **Verify:** `bunx tsc --noEmit` → exits 0.

2. **Write `test/serialize.test.ts` before the route.** These are exactly the functions where a subtle bug produces a silently corrupt file. See the test plan.

   **Verify:** `bun test` → new tests pass.

3. **Add `src/server/routes/export.ts`** with `GET /api/export/urls`, taking the **same** query parameters as `GET /api/urls` plus `format=csv|json|md`:

   ```ts
   const f = parseFilters(params);
   const { sql: where, params: wp } = buildWhere(f);
   const { col, dir } = parseSort(params);
   ```

   Reuse them verbatim — that is what inherits `is_hidden = 0`.

   Apply an export-specific cap (`const MAX_EXPORT_ROWS = 50_000;`) rather than `parsePage`'s 500. Include the count in the response headers so a truncated export is detectable, and **name the truncation** — a silently capped export is a data-integrity bug.

   Set `Content-Type` (`text/csv; charset=utf-8`, `application/json`, `text/markdown`) and `Content-Disposition: attachment; filename="chrome-history-urls-<yyyy-mm-dd>.csv"`.

   **Sanitize the filename** — it is constructed server-side from a date, so keep it that way; never interpolate user input (a domain filter, say) into the header without stripping quotes, semicolons and newlines.

   **Verify:**
   `curl -sD- "http://127.0.0.1:8787/api/export/urls?format=csv&limit=5" -o /tmp/x.csv | head -20` → headers show `text/csv` and a `Content-Disposition`; the file opens as CSV with a header row.

4. **Confirm the privacy inheritance immediately** — before adding any more endpoints.

   Add a Hide rule for a domain you have history for, then export with no filters and grep the output for that domain.

   **Verify:** the hidden domain appears **zero** times in the exported file. **If it appears, stop** — `buildWhere` is not being applied and nothing else in this plan should be built until it is.

5. **Add the derived-artifact exports**, which are the ones with real value because the data exists nowhere else:
   - `GET /api/export/journeys` — Research Sessions with label, description, time range, page count, and the ordered trail. Markdown is the interesting format here (a session becomes a heading with a link list), which is what makes it useful to a PKM tool.
   - `GET /api/export/clusters` — Interest Map topics with label, size, trend, and member URLs.
   - `GET /api/export/graveyard` — dead links with their archive URLs.

   Each must apply the same privacy filtering its own view applies. Copy the predicate from the corresponding route (`routes/journeys.ts`, `routes/clusters.ts`, `routes/insights.ts`) rather than writing a new one — those routes already gate on `is_private=0 AND is_hidden=0`.

   **Verify:** each endpoint returns a non-empty body for data that exists, and re-run step 4's hidden-domain grep against **each** exported file.

6. **Add the client download helper** in `src/web/api.ts`:

   ```ts
   exportUrl: (path: string, params: URLSearchParams) => { /* build href, trigger download */ }
   ```

   Simplest correct approach: set `window.location.href` to the API path with query parameters, letting `Content-Disposition` do the work. That avoids holding a 50k-row file in browser memory as a Blob.

   **Verify:** `bunx tsc --noEmit` → exits 0.

7. **Add the export control to the UI.** In the shared filter/toolbar area, add an "Export" control offering the three formats, passing **the current filter state** so what is exported is what is on screen. Label it so that is obvious — "Export these results", not "Export".

   **Verify:** `bun run build` → completes. Then `bun run dev`, apply a domain filter and a date range, export CSV, and confirm the file contains only rows matching those filters.

8. **Document it.** One short README subsection: which views export, which formats, that exports honor privacy and ignore rules, and that exports are capped at 50,000 rows.

   **Verify:** re-read the Privacy section and confirm it does not now under-describe what leaves the app (note: an export writes to the user's own disk — it is not network egress and should not be conflated with plan 004's audit log).

## Test plan

`test/serialize.test.ts` — pure functions, no database.

- **Quoting:** a field containing a comma is quoted; one containing `"` has it doubled *and* the field quoted; one containing `\n` is quoted. Assert exact output strings, not "contains a quote".
- **Nulls:** `null` and `undefined` produce empty fields. Assert the exact row string, so `,,` is verified rather than `,null,`.
- **Formula injection:** fields starting with `=`, `+`, `-`, `@` are prefixed with `'`. Assert all four. **This is the most important test in the file** — page titles come from arbitrary websites.
- **Header row:** columns appear in the order given, and only requested columns are emitted even when the row objects carry extra keys. This is what stops an internal field (`is_hidden`, an id) leaking into an export by accident.
- **Empty input:** zero rows produces a header row and nothing else, not an empty string or a throw.
- **Markdown escaping:** a cell containing `|` is escaped so the table is not broken.
- **Round-trip sanity:** serialize a row set to JSON, parse it back, assert deep equality with the input.

Privacy inheritance is verified by steps 4 and 5's greps rather than a unit test, because the guarantee lives in the composition of `buildWhere` with the route — the thing worth checking is the real query against real data.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including `test/serialize.test.ts`
- [ ] `bun run build` completes
- [ ] `GET /api/export/urls?format=csv` downloads a valid CSV with correct headers
- [ ] All three formats work on all four endpoints
- [ ] A hidden domain appears in **none** of the four exports
- [ ] A private URL appears only where the corresponding view would show it
- [ ] Exporting with filters applied returns only matching rows
- [ ] A capped export reports its truncation rather than silently dropping rows
- [ ] A row whose title begins with `=` is neutralized in the CSV
- [ ] `src/server/lib/query.ts` is unchanged
- [ ] No new dependency in `package.json`
- [ ] Export routes are mounted under `/api` and behind `localGuard`

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- Step 4 shows a hidden domain in the export. The privacy inheritance is broken; fix it before anything else.
- You are about to modify `src/server/lib/query.ts`.
- You are about to add a CSV or serialization dependency.
- You are about to mount an export route outside `/api`, or bypass `localGuard`.
- You are about to add a DELETE route or an import-from-export path.
- Any step's **Verify** fails twice.

## Maintenance notes

**Makes easier:** the serializers are reusable by anything that produces rows — plan 004's egress audit is an obvious second consumer, and any future report or view gets export nearly free.

**Makes harder:** every export endpoint is a place the privacy filter must be re-applied correctly, and correctness is per-endpoint rather than global. That is the real ongoing cost of this feature. The mitigation is discipline: **export endpoints must reuse their view's existing predicate rather than writing a new one.** Worth stating in a comment at the top of `routes/export.ts` so the next person adding an endpoint sees it.

**Deliberately not done:** no visit-log dump, no import of exports, no scheduled or automatic export, no PKM-specific formats beyond generic Markdown (an Obsidian- or Logseq-shaped export is a reasonable follow-up once someone actually asks for a specific shape — the requests found in research asked for "integration" generally, not a named format).

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\008-export-from-every-view.md in full before
doing anything. It is a self-contained implementation plan: follow the executor
instructions at the top, run the drift check first, execute the steps in order
verifying each before moving on, and stop at any STOP condition. Scope: add
CSV/JSON/Markdown export for the URL list, Research Sessions, Interest Map topics
and the dead-link Graveyard — reusing parseFilters/buildWhere from
src/server/lib/query.ts unchanged so exports inherit the same is_hidden=0 privacy
filtering the views already apply. Write your own CSV serializer with RFC 4180
quoting and spreadsheet-formula-injection neutralization; add no dependency. Step
4 verifies that a hidden domain appears in no export — stop if it does. Work on a
branch; when done, report against the Done criteria checklist.
```
