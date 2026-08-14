# 005 — Import bookmarks as a first-class source

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> Drift check first: `git diff --stat a33971d..HEAD -- src/server/lib/sources/ src/server/lib/load.ts src/server/schema.sql src/server/db.ts src/server/routes/import.ts`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 9/10
- **Lenses**: inside-out (Signal 3 — surface asymmetries) / outside-in (`live-research`)
- **Effort (coarse)**: M
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: none

## Why this matters

Bookmarks are the highest-reacted open feature request on the closest feature-matched comparator in this space — Falcon issue #29, "Feature Request! Bookmarks", 8 reactions, 5 comments, still open on a project with 1,832 stars that has not shipped since August 2024 (verified against the GitHub API on 2026-08-12).

The most-quoted comment there describes a problem this project is already three-quarters of the way to solving:

> "I have bookmarks going back to 2009 in Chrome (and 2004 in Firefox). Sadly, many of the links are now dead. I wish 'bookmarking' had saved copies of these pages that I could read and search now, even if they were text only."

Another, in the same thread:

> "I often bookmark a lot of interesting and technical articles... Is there any way to have falcon index all my 500 bookmarks so they become searchable without me having to visit each one. I also clear my history frequently."

Corroborated on a second tracker: `browser-history` #51 "[FEATURE REQ] Fetching Bookmarks", 9 comments.

**The unique leverage is the join with what already exists.** This project has a dead-link Graveyard with Wayback fallbacks. Bookmarks crossed with liveness answers exactly the first comment — "this thing you deliberately kept is gone, here is the archive" — and no comparator can say it. A bookmark is also the strongest available signal of *deliberate intent*: unlike a visit, someone chose it.

There is a second, quieter reason. The README currently frames the gap as Google's fault:

> "**Takeout** exports don't preserve page-transition types and contain no bookmarks or downloads."

That is true but misleading. The local adapters open the very databases that hold bookmarks and read only visit tables. Nothing in the README or the Import view tells a user that a local import also skips them.

**"Good" looks like:** the app knows which pages you bookmarked and when, they are searchable and liveness-checkable like anything else, and a "dead bookmarks" view exists.

## Current state

### The two adapters read visits and nothing else

`src/server/lib/sources/firefox.ts:20-27` — the entire read, against a database that also contains `moz_bookmarks`:

```ts
  *readVisits(): Iterable<NormalizedVisit> {
    const { db, cleanup } = openSqliteCopy(this.placesPath);
    try {
      const stmt = db.query<Row, [number, number]>(
        `SELECT p.url, p.title, h.visit_date, h.visit_type
         FROM moz_historyvisits h JOIN moz_places p ON p.id = h.place_id
         WHERE p.url IS NOT NULL ORDER BY h.id LIMIT ? OFFSET ?`,
      );
```

`src/server/lib/sources/chromium.ts:22-29`:

```ts
  *readVisits(): Iterable<NormalizedVisit> {
    const { db, cleanup } = openSqliteCopy(this.historyPath);
    try {
      const stmt = db.query<Row, [number, number]>(
        `SELECT u.url, u.title, v.visit_time, v.transition
         FROM visits v JOIN urls u ON u.id = v.url
         WHERE u.url <> '' ORDER BY v.id LIMIT ? OFFSET ?`,
      );
```

### The critical asymmetry between browser families — read this before estimating

- **Firefox** keeps bookmarks in `moz_bookmarks` inside `places.sqlite` — *the same file the adapter already opens and copies*. Joining `moz_bookmarks` to `moz_places` gives URL, title, `dateAdded` (microseconds), and parent folder. Effort: small.
- **Chromium** keeps bookmarks in a **separate JSON file** named `Bookmarks`, a sibling of the `History` database inside the profile directory. It is not SQLite and the adapter has never opened it. Effort: a new file reader and a new path.

The plan sequences Firefox first for exactly this reason. Do not assume symmetry.

### The interface is already extensible in the right shape

`src/server/lib/sources/types.ts:46-52`:

```ts
/** A source produces visits (and optionally sessions) for one profile/export. */
export interface HistorySource {
  /** Stable provenance label stored on each visit, e.g. "chrome-local:Default". */
  source: string;
  readVisits(): Iterable<NormalizedVisit>;
  readSessions?(): SessionData[];
}
```

`readSessions?()` is the precedent: an **optional** method a source implements only if it has that data. `readBookmarks?()` follows it exactly.

### The vocabulary already exists, but not the entity

`src/server/lib/sources/types.ts:11-19` includes `"bookmark"` as a transition type, and both transition mappers emit it — `chromiumTransition` at line 60 (`case 2: return "bookmark";`) and `firefoxTransition` at line 76 (`case 3: return "bookmark";`).

**This is a trap worth naming.** `transition: "bookmark"` means "this visit was *reached by clicking* a bookmark". It does not mean "this URL is bookmarked". They are different facts and the plan must not conflate them: a bookmark you never clicked has no visit at all, which is precisely the case the Falcon commenters describe.

### Where a new entity would live

`src/server/schema.sql` currently has `urls`, `visits`, `devices`, `sessions`/`session_tabs`/`tab_navigations`, `enrichments`, `journeys`, `clusters`, `settings`. Bookmarks are a new table referencing `urls(id)`, following the `journey_visits` pattern of a light join table.

### Migration convention — non-negotiable

`INSIGHTS.md:94` records the rule the hard way:

> "`CREATE TABLE IF NOT EXISTS` silently does nothing on an existing table, so a new column added inside it never appears — but a sibling `CREATE INDEX` on that column runs anyway and crashes. The fix is to separate 'create for fresh DBs' (in `schema.sql`) from 'alter for existing DBs' (in `db.ts migrate()`)."

A wholly **new** table is safe in `schema.sql` alone (`CREATE TABLE IF NOT EXISTS` does create it). Any change to an existing table needs both. This plan adds only a new table, so `schema.sql` suffices — but `db.ts migrate()` must be checked to confirm the new table is created on an existing database too. Verify this rather than assuming it.

### The loader pattern to follow

`src/server/lib/load.ts:7-57`. `loadVisits` upserts into `urls` first (getting an id back via `RETURNING id`), caches ids in a `Map`, and inserts children inside one transaction. `loadBookmarks` follows the same shape.

Note `finalize()` (lines 120–159) recomputes aggregates, rebuilds the FTS index, and calls `recomputePrivacy(db)`. A bookmarked URL that is private or hidden must be subject to the same rules as any other — which it will be automatically, because bookmarks reference `urls` rows.

### Repo conventions

TypeScript strict, ESM, `.ts` extensions on relative imports. Adapters are classes implementing `HistorySource`, one file per source family, using generator methods and `openSqliteCopy` for locked databases. Tests are fixture-based `bun:test` — **exemplar: `test/adapters.test.ts`**, which builds a fixture database and asserts on epoch/transition conversion. No lint step.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes |
| ingest | `bun run ingest --list` | prints detected profiles |

## Scope

**In:**
- `src/server/schema.sql` — one new table plus indexes.
- `src/server/db.ts` — confirm/extend `migrate()` so existing databases get the table.
- `src/server/lib/sources/types.ts` — a `NormalizedBookmark` type and the optional interface method.
- `src/server/lib/sources/firefox.ts` — implement `readBookmarks`.
- `src/server/lib/load.ts` — a `loadBookmarks` function.
- `src/server/routes/import.ts` and `src/server/ingest.ts` — call it where sessions are called.
- New: `src/server/routes/bookmarks.ts` and its mount in `src/server/index.ts`.
- New: `test/bookmarks.test.ts`.
- `README.md` — correct the per-source attribution of the limitation.

**Out:**
- **Chromium bookmarks in this plan.** Phase two, after Firefox proves the shape. Deliberate.
- Safari bookmarks. The Safari adapter is already unverified against a live profile; do not extend it.
- Any web UI. A route is enough to prove the data; a Bookmarks view is a follow-up.
- Bookmark folders as a hierarchy. Store the parent folder *name* as a flat string; a folder tree is scope creep.
- Writing bookmarks back to any browser. This app is read-only with respect to browser data — a hard boundary.

## Steps

1. **Add the type in `src/server/lib/sources/types.ts`:**

   ```ts
   export interface NormalizedBookmark {
     url: string;
     title: string | null;
     addedMs: number | null;  // epoch ms; null when the source doesn't record it
     folder: string | null;   // flat parent-folder name, not a path
   }
   ```

   Extend the interface, mirroring `readSessions?()`:

   ```ts
   readBookmarks?(): Iterable<NormalizedBookmark>;
   ```

   **Verify:** `bunx tsc --noEmit` → exits 0. Every existing adapter still compiles unchanged (that is the point of the optional method).

2. **Add the table to `src/server/schema.sql`:**

   ```sql
   -- Bookmarks: URLs the user deliberately kept, distinct from URLs they visited.
   -- A bookmark may have zero visits (kept but never revisited) — that is the
   -- interesting case, so this is NOT derived from `visits`.
   CREATE TABLE IF NOT EXISTS bookmarks (
     id       INTEGER PRIMARY KEY,
     url_id   INTEGER NOT NULL REFERENCES urls(id),
     source   TEXT NOT NULL,          -- provenance label, e.g. "firefox:xyz.default"
     title    TEXT,                   -- bookmark title, which may differ from page title
     added_ms INTEGER,                -- epoch ms
     folder   TEXT,
     UNIQUE(url_id, source)
   );
   CREATE INDEX IF NOT EXISTS idx_bookmarks_added ON bookmarks(added_ms DESC);
   ```

   `UNIQUE(url_id, source)` makes re-import idempotent per source, matching the `uq_visits_url_time` philosophy.

   **Verify:** delete nothing. Start the server against the existing database (`bun run server`) → starts cleanly. Then confirm the table exists on the *existing* database:
   `bun -e "const {Database}=require('bun:sqlite');console.log(new Database('data/history.db').query(\"SELECT name FROM sqlite_master WHERE name='bookmarks'\").all())"`
   → returns one row. **If it returns nothing, `migrate()` needs to run `schema.sql` against existing databases — fix that before continuing.**

3. **Implement `readBookmarks` on `FirefoxSource`.** Add a generator alongside `readVisits`, opening the same `places.sqlite` copy:

   ```sql
   SELECT p.url, b.title AS bm_title, p.title AS page_title, b.dateAdded, f.title AS folder
     FROM moz_bookmarks b
     JOIN moz_places p ON p.id = b.fk
     LEFT JOIN moz_bookmarks f ON f.id = b.parent
    WHERE b.type = 1 AND p.url IS NOT NULL
   ```

   `b.type = 1` selects bookmarks; type 2 is a folder and type 3 a separator — including those would produce junk rows. `dateAdded` is **microseconds** since the Unix epoch, like `visit_date`; divide by 1000, exactly as `firefox.ts:36` already does.

   Filter out non-web schemes (`place:`, `about:`, `javascript:`) — Firefox stores smart-folder queries as `place:` URLs and they are not pages.

   **Verify:** `bunx tsc --noEmit` → exits 0.

4. **Add `loadBookmarks` to `src/server/lib/load.ts`**, following `loadVisits`'s structure: upsert the URL (reusing `upsertUrl` and `urlIdCache`), then `INSERT ... ON CONFLICT(url_id, source) DO UPDATE` the bookmark row, all inside one transaction. Return the inserted count.

   **Do not** call `recomputePrivacy` here — `finalize()` already does, and a bookmarked URL must go through exactly the same privacy pipeline as any other URL.

   **Verify:** `bunx tsc --noEmit` → exits 0.

5. **Call it from both import paths.** In `src/server/routes/import.ts`, inside the label loop after `loadVisits`, mirror the guarded pattern `src/server/ingest.ts:105` uses for sessions:

   ```ts
   if (source.readBookmarks) loader.loadBookmarks(source.source, source.readBookmarks());
   ```

   Add the same line to the `--profile` and `--source` branches of `src/server/ingest.ts`. Keep `finalize(db)` called exactly once at the end.

   **Verify:** `bun run ingest --profile firefox:<your-profile>` (find the label with `bun run ingest --list`) → completes, then
   `bun -e "const {Database}=require('bun:sqlite');console.log(new Database('data/history.db').query('SELECT COUNT(*) n FROM bookmarks').get())"`
   → a non-zero count matching roughly what that Firefox profile holds.

6. **Add `src/server/routes/bookmarks.ts`** with two handlers, following the style of `src/server/routes/sessions.ts`:
   - `GET /api/bookmarks` — bookmarks joined to `urls`, newest `added_ms` first, **filtered `is_hidden=0`**, with `visit_count` and `last_visited` so "bookmarked but never visited" is visible.
   - `GET /api/bookmarks/dead` — the payoff: bookmarks joined to their liveness enrichment where `json_extract(result_json,'$.state') = 'dead'`, including `archived_url`. Copy the join shape from `src/server/routes/sessions.ts:32-35`.

   Mount it in `src/server/index.ts` alongside the others.

   **Verify:** `curl -s "http://127.0.0.1:8787/api/bookmarks" | head -c 300` → rows. Then `curl -s "http://127.0.0.1:8787/api/bookmarks/dead" | head -c 300` → valid JSON (an empty array is fine if no liveness checks have run).

7. **Correct the README.** In "Notes & limitations", replace the Takeout-only framing with per-source attribution: Takeout has no bookmarks or downloads; local Chromium imports read history only and do not yet read the separate `Bookmarks` file; Firefox imports include bookmarks.

   **Verify:** re-read the section and confirm no sentence attributes to Takeout a limitation that also applies to local sources.

## Test plan

`test/bookmarks.test.ts`, following `test/adapters.test.ts`'s fixture approach — build a temporary `places.sqlite`-shaped database with `moz_bookmarks` / `moz_places` and point `FirefoxSource` at it.

- **Type filtering:** the fixture contains one bookmark (`type=1`), one folder (`type=2`), and one separator (`type=3`). Assert `readBookmarks` yields **exactly one** record. Asserting the count is what catches the folder-rows bug.
- **Epoch conversion:** a known `dateAdded` in microseconds converts to the expected epoch-ms value. Assert the exact number, mirroring how `test/adapters.test.ts` pins visit epochs.
- **Non-web schemes excluded:** a `place:` URL row in the fixture is not yielded.
- **Bookmark with no visits still lands:** load a bookmark whose URL has zero `visits` rows, then assert a `urls` row exists for it and a `bookmarks` row references it. **This is the core capability** — a URL that was kept but never revisited must be representable, and nothing else in the schema can express that today.
- **Idempotency:** run `loadBookmarks` twice with the same input and assert exactly one `bookmarks` row (the `UNIQUE(url_id, source)` guard).
- **Privacy applies:** after `finalize()`, a bookmarked LAN URL (e.g. `http://192.168.1.10/`) has `is_private=1` on its `urls` row, and the `GET /api/bookmarks` query excludes hidden rows. Bookmarks must not become a privacy bypass — assert this explicitly.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including `test/bookmarks.test.ts`
- [ ] `bun run build` completes
- [ ] The `bookmarks` table exists on a **pre-existing** database after a server start
- [ ] A Firefox profile import produces a non-zero bookmark count
- [ ] Re-running the same import does not duplicate bookmark rows
- [ ] A bookmark whose URL has zero visits is present in `GET /api/bookmarks`
- [ ] `GET /api/bookmarks/dead` returns valid JSON
- [ ] Chromium, Takeout and Safari imports are byte-for-byte unaffected (run one and confirm counts are unchanged)
- [ ] The README no longer attributes the bookmarks gap to Takeout alone
- [ ] No new dependency in `package.json`

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- You are about to implement Chromium bookmark parsing. Out of scope — it is a separate JSON file and belongs in phase two.
- You are about to write to any browser's own database or bookmark file. Absolute boundary: this app only ever reads a copy.
- Step 2's verification shows the table is missing on an existing database and you cannot make `migrate()` create it without altering an existing table.
- You find yourself deriving bookmarks from `visits.transition = 'bookmark'`. That is a different fact (see Current state) and produces wrong data.
- Any step's **Verify** fails twice.

## Maintenance notes

**Makes easier:** Chromium bookmarks become "implement `readBookmarks` on `ChromiumSource`, reading the sibling `Bookmarks` JSON" with no schema, loader, or route change. A Bookmarks view in the UI is then purely frontend. Liveness, FTS and privacy all apply for free because bookmarks reference `urls`.

**Makes harder:** a second entity now references `urls`, so anything that deletes or rewrites URL rows must consider bookmarks. There are no DELETE routes today, so nothing breaks now — but this is the second reason (after `journey_visits`) that URL deletion would be non-trivial.

**Deliberately not done:** no Chromium, no Safari, no folder hierarchy, no bookmark UI, no snapshot-the-page-at-bookmark-time (that is plan 001's territory — and if both land, "search the text of pages I bookmarked in 2009 and never opened again" becomes possible, which is precisely what the Falcon commenter asked for).

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\005-bookmarks-as-a-source.md in full before
doing anything. It is a self-contained implementation plan: follow the executor
instructions at the top, run the drift check first, execute the steps in order
verifying each before moving on, and stop at any STOP condition. Scope: add
bookmarks as a first-class entity — a new `bookmarks` table, an optional
readBookmarks() method on the HistorySource interface, a Firefox implementation
reading moz_bookmarks from the places.sqlite copy the adapter already opens, a
loader, and read-only routes including a dead-bookmarks view. Firefox only;
Chromium bookmarks live in a separate JSON file and are explicitly out of scope
for this plan. Never write to any browser's own data. Work on a branch; when
done, report against the Done criteria checklist.
```
