# 009 — Make Takeout importable from the Import tab

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> Drift check first: `git diff --stat a33971d..HEAD -- src/server/routes/import.ts src/web/components/ImportView.tsx src/web/api.ts src/server/lib/sources/index.ts src/server/ingest.ts`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 8/10
- **Lenses**: inside-out (Signal 5 — friction worth productizing) / outside-in (`live-research`)
- **Effort (coarse)**: S
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: none

## Why this matters

Takeout is this project's headline source. It is named in the first line of the README, it is the only source that carries saved tab sessions, and it is the one holding a full year of history where local Chrome expires at about ninety days.

It is also **the only source you cannot import from the app**. The Import tab lists every detected local browser profile with visit counts and last-visit dates, two clicks from imported. Takeout requires dropping to a terminal and running `bun run ingest /path/to/History.json`.

Every server-side piece already exists — the adapter, the loader, the session loader, `finalize()`. Only the route's body shape blocks it: `POST /api/import/run` accepts `{ labels: string[] }` and nothing else.

Why now: the repository has just gone public, and setup friction is what decides adoption in this niche specifically. The most-reacted open issue on the healthiest comparator project (Promnesia, 1,891 stars) is literally a request to make it easier to run — "Backend in docker container?", 6 reactions, its top issue. A first-run experience that starts with a terminal command loses people who would otherwise have stayed.

**"Good" looks like:** a new user opens the Import tab, sees their Takeout export already detected at `./History.json`, and clicks Import. No terminal.

## Current state

### `src/server/routes/import.ts` — the whole file is 57 lines

The run handler (lines 26–57). Note line 32–34: the body type admits only `labels`.

```ts
/**
 * POST /api/import/run { labels: string[] } — import the selected detected
 * profiles into the DB. Runs synchronously; fine for a local single-user app.
 */
importRoutes.post("/run", async (c) => {
  const db = getDb();
  const body = (await c.req.json().catch(() => ({}))) as { labels?: string[] };
  const labels = Array.isArray(body.labels) ? body.labels : [];
  if (!labels.length) return c.json({ error: "no profiles selected" }, 400);

  const detected = detectProfiles(false);
  const loader = createLoader(db);
  const results: { label: string; inserted?: number; error?: string }[] = [];

  for (const label of labels) {
    const match = detected.find((p) => p.label === label);
    if (!match) {
      results.push({ label, error: "profile not found" });
      continue;
    }
    try {
      const source = createSource(match.kind, match.path, match.label);
      results.push({ label, inserted: loader.loadVisits(source.source, source.readVisits()) });
    } catch (err) {
      results.push({ label, error: err instanceof Error ? err.message : String(err) });
    }
  }

  finalize(db); // recompute aggregates/FTS/privacy once after all imports
  const totalInserted = results.reduce((s, r) => s + (r.inserted ?? 0), 0);
  return c.json({ totalInserted, results });
});
```

**Note line 48 carefully:** the loop calls `loader.loadVisits(...)` only. It never calls `loader.loadSessions(...)`. That is invisible today because no *detected* source implements `readSessions` — but Takeout does, and sessions are the thing Takeout uniquely provides. Getting this wrong is the single most likely way to ship this feature broken: the import would appear to succeed and silently import zero tab sessions.

### `src/server/ingest.ts` — the CLI path that already works

The Takeout branch (lines 106–113), which is the behavior to mirror:

```ts
  } else {
    // Default: Takeout export.
    const path = positional[0] ?? join(process.cwd(), "History.json");
    console.log(`Reading Takeout export: ${path}`);
    const source = new TakeoutSource(path);
    inserted = loader.loadVisits(source.source, source.readVisits());
    loader.loadSessions(source.readSessions());
  }
```

Two things to copy: the default path of `./History.json` relative to `process.cwd()` (line 108), and the `loadSessions` call (line 112).

Compare the `--source` branch (lines 95–105), which guards the call:

```ts
    if (source.readSessions) loader.loadSessions(source.readSessions());
```

That guarded form is the right pattern for the route, because the route handles mixed source kinds.

### `src/server/lib/sources/index.ts` — the adapter is already registered

```ts
export type SourceKind = "takeout" | "chromium" | "firefox" | "safari";

export const SOURCE_KINDS: SourceKind[] = ["takeout", "chromium", "firefox", "safari"];

/** Build an adapter for a given source kind + file path. */
export function createSource(kind: SourceKind, filePath: string, label: string): HistorySource {
  switch (kind) {
    case "takeout":
      return new TakeoutSource(filePath);
    ...
  }
}
```

`createSource("takeout", path, label)` works today. (Note it discards `label` for Takeout — the adapter names its own source. That is existing behavior and is out of scope.)

### `src/web/components/ImportView.tsx` — profiles only, no path input

The import call (lines 25–43):

```ts
  const run = async () => {
    if (!selected.size) return;
    setRunning(true);
    setStatus(null);
    try {
      const res = await api.runImport([...selected]);
      const errs = res.results.filter((r) => r.error);
      setStatus(
        `Imported ${fmtNum(res.totalInserted)} new visits from ${res.results.length - errs.length} profile(s)` +
          (errs.length ? `; ${errs.length} failed (${errs.map((e) => e.label).join(", ")})` : "") +
          ". Reload other views to see the merged data.",
      );
```

There is no file input, no path field, and no mention of Takeout anywhere in the component.

### `src/web/api.ts` — the client method, lines 222–233

```ts
  runImport: (labels: string[]) =>
    fetch(`/api/import/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels }),
    }).then(
      (r) =>
        r.json() as Promise<{
          totalInserted: number;
          results: { label: string; inserted?: number; error?: string }[];
        }>,
    ),
```

### Security context

`src/server/index.ts:49` wraps every `/api` route in `localGuard(ALLOWED_HOSTS)` — the DNS-rebinding and CSRF guard. That protects this endpoint from a malicious website driving it, which matters because **this plan accepts a filesystem path from a request body**. The guard is the reason that is acceptable at all; the path validation in step 2 is defense in depth on top of it.

### Repo conventions

TypeScript strict, ESM, `.ts` extensions on relative imports. One Hono router per resource. React components in `src/web/components/`, Tailwind utility classes inline, `api.*` for all fetches. Tests are `bun:test` unit tests of `lib/` modules. No lint step.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes |
| run server | `bun run server` | logs `API listening on http://127.0.0.1:8787` |
| dev | `bun run dev` | Vite on :5173 proxying the API on :8787 |

## Scope

**In:**
- `src/server/routes/import.ts` — the `/detect` and `/run` handlers.
- `src/web/api.ts` — `runImport` and `detectProfiles` response types.
- `src/web/components/ImportView.tsx` — a Takeout row/field.

**Out:**
- `src/server/ingest.ts`. The CLI keeps working exactly as it does; do not refactor the two to share code in this plan.
- `src/server/lib/sources/takeout.ts` and the loader. No adapter changes.
- Browser file **upload**. A `<input type="file">` would put a 37 MB JSON blob through an HTTP body for no benefit — the server can read the file directly from disk, and the app is loopback-only and single-user by design. Use a path, not an upload.
- Multi-machine or remote paths. Local filesystem only.

## Steps

1. **Add Takeout detection to `GET /api/import/detect`.** After `detectProfiles()`, check whether `join(process.cwd(), "History.json")` exists. If it does, include a synthetic entry in the response under a separate key so the existing `profiles` array keeps its exact shape:

   ```ts
   importRoutes.get("/detect", (c) => {
     const takeoutPath = join(process.cwd(), "History.json");
     return c.json({
       profiles: detectProfiles(),
       takeout: existsSync(takeoutPath) ? { path: takeoutPath } : null,
     });
   });
   ```

   Do not probe or parse the file here — `detectProfiles` probes SQLite databases cheaply, but parsing a 37 MB JSON export just to show a count would make the tab slow to load.

   **Verify:** `curl -s http://127.0.0.1:8787/api/import/detect | head -c 300` → JSON containing both `profiles` and `takeout` keys.

2. **Accept `takeoutPath` in `POST /api/import/run`.** Widen the body type to `{ labels?: string[]; takeoutPath?: string }`. Change the empty-input guard so the request is valid when *either* a label list or a Takeout path is present.

   Validate the path before using it:
   - must be a string, non-empty, under 4096 characters;
   - must exist (`existsSync`) and be a file (`statSync(...).isFile()`);
   - reject anything that is not a regular file.

   On failure push `{ label: "takeout", error: "..." }` into `results` rather than throwing — the existing handler already reports per-source errors this way and one bad path should not abort a mixed import.

   **Verify:** `bunx tsc --noEmit` → exits 0. Then post a nonexistent path:
   `curl -s -X POST http://127.0.0.1:8787/api/import/run -H 'content-type: application/json' -d '{"takeoutPath":"/no/such/file.json"}'`
   → responds 200 with a `results` entry carrying an `error`, not a 500.

3. **Import the Takeout source — including sessions.** Inside the handler, before or after the label loop:

   ```ts
   if (takeoutPath) {
     try {
       const source = createSource("takeout", takeoutPath, "takeout");
       results.push({ label: "takeout", inserted: loader.loadVisits(source.source, source.readVisits()) });
       if (source.readSessions) loader.loadSessions(source.readSessions());
     } catch (err) {
       results.push({ label: "takeout", error: err instanceof Error ? err.message : String(err) });
     }
   }
   ```

   **The `loadSessions` call is the point of this step.** Without it the import silently drops the one thing only Takeout provides.

   **Verify:** with a real `History.json` present, note the session count first —
   `bun -e "const {Database}=require('bun:sqlite');console.log(new Database('data/history.db').query('SELECT COUNT(*) n FROM sessions').get())"`
   — then run the import via the API and re-run it. The count must be **non-zero** afterwards.

4. **Confirm `finalize()` still runs exactly once**, after both the label loop and the Takeout branch (existing line 54). It recomputes aggregates, rebuilds FTS, and re-applies privacy rules; calling it twice is wasteful and calling it zero times leaves the database inconsistent.

   **Verify:** read the handler top to bottom and confirm one `finalize(db)` on every return path that imported anything.

5. **Update the client.** In `src/web/api.ts`, change `runImport` to `runImport(labels: string[], takeoutPath?: string)`, sending `{ labels, takeoutPath }`. Add `takeout: { path: string } | null` to the `detectProfiles` response type.

   **Verify:** `bunx tsc --noEmit` → exits 0.

6. **Add the Takeout row to `ImportView.tsx`.** Above the detected-profiles table, render a section that:
   - when `takeout` is non-null, shows the detected path with a checkbox, selected by default;
   - when null, shows a text input for a path, with placeholder `History.json` and one line of copy explaining where a Takeout export comes from;
   - includes the Takeout path in the `runImport` call when selected or filled.

   Match the component's existing Tailwind idiom — reuse the classes already on the profile table rows rather than inventing new ones.

   Update the success message so it does not say "profile(s)" when the only thing imported was Takeout.

   **Verify:** `bun run build` → completes. Then `bun run dev`, open the Import tab, and confirm the Takeout section renders in both states (rename `History.json` temporarily to see the empty state).

7. **Full end-to-end run.** With a real `History.json` in the project root, import it entirely from the UI.

   **Verify:** the success message reports a non-zero insert count, the Sessions tab shows saved windows, and re-running the same import reports **0 new visits** — proving idempotency through the `uq_visits_url_time` unique index, exactly as the CLI path behaves.

## Test plan

The import route is I/O-heavy and its adapter is already covered by `test/adapters.test.ts`. Keep new tests focused on the logic this plan actually adds:

- **Path validation, in `test/import-path.test.ts`:** extract the validator into a small exported pure function and assert it rejects the empty string, a 5,000-character string, a directory path, and a nonexistent path; and accepts a real temporary file created by the test. Assert the specific rejection reason, not merely falsiness.
- **Request-shape acceptance:** assert that a body with only `takeoutPath`, a body with only `labels`, and a body with both are all treated as valid, while a body with neither returns the 400. This is the guard most likely to be broken by a careless edit.
- **Regression — sessions are loaded:** this is the assertion that matters most and it cannot be a pure unit test. Add it to the Done criteria as the observable check in step 3 rather than writing a test that mocks the loader into meaninglessness.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including the new path-validation tests
- [ ] `bun run build` completes
- [ ] `GET /api/import/detect` returns a `takeout` key (non-null when `./History.json` exists)
- [ ] Importing Takeout from the UI inserts visits **and** produces a non-zero `sessions` row count
- [ ] Re-running the same Takeout import reports 0 new visits
- [ ] A nonexistent or directory path returns a per-source error in `results`, never a 500
- [ ] `bun run ingest` and `bun run ingest /path/to/History.json` still work unchanged
- [ ] Importing local profiles alone still works exactly as before
- [ ] `finalize(db)` is called exactly once per request that imported anything

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- You are about to add a browser file-upload path or accept file contents in the request body.
- You are about to refactor `src/server/ingest.ts` to share code with the route.
- Step 3's session count is still zero after a successful Takeout import — the `loadSessions` wiring is wrong; report rather than working around it.
- Any step's **Verify** fails twice.
- You find yourself weakening or bypassing `localGuard`.

## Maintenance notes

**Makes easier:** the route now has a shape that accepts an arbitrary source path, so adding "import another export format from a path" is a `SourceKind` and a UI field rather than a new endpoint. That is the natural landing place for any future non-browser source.

**Makes harder:** the endpoint now accepts a filesystem path from a request body. That is safe today because of `localGuard` plus loopback binding — and it becomes a genuine consideration if anyone exposes the app on a LAN via `API_HOST`. Worth a sentence in `SECURITY.md` under "Exposing to a LAN": a caller who can reach the API can name any file on the host for the importer to read (it will fail to parse anything that is not a Takeout export, but the read is attempted).

**Deliberately not done:** no drag-and-drop, no upload, no automatic import of a detected export without an explicit click (the README is explicit that source selection is always deliberate), no zip-archive handling.

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\009-takeout-import-from-the-ui.md in full before
doing anything. It is a self-contained implementation plan: follow the executor
instructions at the top, run the drift check first, execute the steps in order
verifying each before moving on, and stop at any STOP condition. Scope: let a
Google Takeout History.json be imported from the app's Import tab instead of only
from the terminal — detect ./History.json, accept a takeoutPath in
POST /api/import/run, and make sure saved tab sessions are loaded too (not just
visits). Do not add a file-upload path and do not refactor the ingest CLI. Work
on a branch; when done, report against the Done criteria checklist.
```
