# 006 — Render saved windows as the navigation tree they were

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> Drift check first: `git diff --stat a33971d..HEAD -- src/server/routes/sessions.ts src/server/schema.sql src/server/lib/load.ts src/server/lib/sources/takeout.ts src/web/components/SessionsView.tsx src/web/api.ts`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 9/10
- **Lenses**: inside-out (Signal 4 — the adjacent possible) / outside-in (`live-research`)
- **Effort (coarse)**: M
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: none

## Why this matters

Three columns are written into the database on every Takeout import and read back by nothing: `tab_navigations.referrer`, `session_tabs.tab_node_id`, and `tab_navigations.http_status` (typed in the client, rendered by no component).

Together they are the recorded *structure* of a browsing session — which page led to which, and which tab was spawned from which. The app currently shows a saved window as a flat list of tabs, each with a flat navigation stack, and infers rabbit-hole structure elsewhere from time-adjacency plus a count of link-type transitions. The real parent edges were there the whole time.

Demand for exactly this shape recurs in the research. One commenter, on why every browser's history view disappoints (HN 45295647):

> "Why couldn't we have full text search of the pages, or **a view that reflects tab histories as some kind of graph**, or UIs that support any kind of sorting?"

Another, describing the browser they wish existed (HN 33722664):

> "I want to build a browser that captures everything I saw on the internet, allows me to search it, run graph algorithms (like PageRank). Improves navigation (by **showing trails as tree instead of tabs**)."

The second payoff is smaller but immediate: `http_status` is stored per navigation entry, so a saved window can be shown as *already stale* — which entries 404'd — before you reopen fifty tabs.

**"Good" looks like:** opening a saved window shows an indented trail where each page sits under the page that led to it, with dead entries visibly marked.

## Honest scope caveat — read this before starting

**This feature is Takeout-only.** `sessions`, `session_tabs` and `tab_navigations` are populated exclusively from a Google Takeout export; local browser imports expose no session data at all. A user who imports only from local browsers will never see this feature.

That materially caps its reach and is the main argument against sequencing it early. It is not a reason not to build it — the data is already collected and currently wasted — but the plan must not pretend otherwise, and the UI must degrade gracefully to the existing flat view when there are no usable parent edges.

## Current state

### `src/server/schema.sql:88-98` — the columns

```sql
CREATE TABLE IF NOT EXISTS tab_navigations (
  id            INTEGER PRIMARY KEY,
  tab_pk        INTEGER NOT NULL REFERENCES session_tabs(id),
  idx           INTEGER,          -- position within the tab's navigation stack
  title         TEXT,
  virtual_url   TEXT,
  timestamp_ms  INTEGER,
  http_status   INTEGER,
  referrer      TEXT
);
CREATE INDEX IF NOT EXISTS idx_nav_tab ON tab_navigations(tab_pk);
```

And `session_tabs` (lines 74–85) carries `tab_node_id`:

```sql
CREATE TABLE IF NOT EXISTS session_tabs (
  id                  INTEGER PRIMARY KEY,
  session_id          INTEGER NOT NULL REFERENCES sessions(id),
  tab_id              INTEGER,
  tab_node_id         INTEGER,
  pinned              INTEGER NOT NULL DEFAULT 0,
  current_nav_index   INTEGER,
  browser_type        TEXT,
  last_active_ms      INTEGER,
  current_url         TEXT,       -- denormalized: virtual_url at current_nav_index
  current_title       TEXT
);
```

### `src/server/lib/load.ts:70-73` — they are written on every import

```ts
    const insNav = db.prepare(
      `INSERT INTO tab_navigations (tab_pk, idx, title, virtual_url, timestamp_ms, http_status, referrer)
       VALUES ($tabPk, $idx, $title, $url, $ts, $status, $ref)`,
    );
```

and `session_tabs` (lines 65–69), including `tab_node_id` as `$nodeId`:

```ts
    const insTab = db.prepare(
      `INSERT INTO session_tabs
         (session_id, tab_id, tab_node_id, pinned, current_nav_index, browser_type, last_active_ms, current_url, current_title)
       VALUES ($sid, $tabId, $nodeId, $pinned, $navIdx, $btype, $active, $curUrl, $curTitle) RETURNING id`,
    );
```

The source shape is defined at `src/server/lib/sources/types.ts:21-44`, whose `navigation` entries carry `httpStatus` and `referrer`.

**Also note `load.ts:75`** — `loadSessions` fully replaces session data on every call:

```ts
      db.exec("DELETE FROM tab_navigations; DELETE FROM session_tabs; DELETE FROM sessions;");
```

So sessions are a snapshot, not an accumulating log. Any derived structure must be computed at read time or rebuilt after every import; do not add a persisted derived table that this DELETE would silently orphan.

### `src/server/routes/sessions.ts:41-49` — the only reader, and what it omits

```ts
  const navs = db
    .query(
      `SELECT n.tab_pk, n.idx, n.title, n.virtual_url, n.timestamp_ms, n.http_status
       FROM tab_navigations n
       JOIN session_tabs t ON t.id = n.tab_pk
       WHERE t.session_id = $id
       ORDER BY n.tab_pk, n.idx`,
    )
    .all({ $id: id }) as { tab_pk: number }[];
```

`referrer` is not selected. `http_status` **is** selected and reaches the client (it is typed at `src/web/api.ts:54` as `http_status: number | null`) but no component renders it — grep `http_status` under `src/web/components/` for zero hits.

The tab query (lines 28–39) selects `t.id, t.tab_id, t.pinned, ...` but not `t.tab_node_id`.

The response assembly (lines 51–59) groups navigations under their tab:

```ts
  const byTab = new Map<number, unknown[]>();
  for (const n of navs) {
    const arr = byTab.get(n.tab_pk) ?? [];
    arr.push(n);
    byTab.set(n.tab_pk, arr);
  }
  const withNavs = tabs.map((t) => ({ ...t, navigation: byTab.get(t.id) ?? [] }));
```

### What the data actually supports — verify before building

Two structures are possible and they are **different**:

1. **Within a tab:** navigation entries form a chain, where `referrer` names the URL that led to the current one. This reconstructs "I went A → B → C in this tab".
2. **Across tabs:** `tab_node_id` is Chrome's tab-tree node identifier, which in principle records "this tab was opened from that tab". Whether Takeout exports enough of it to reconstruct parentage is **unknown and must be checked first** (step 1). Do not assume it works.

If (2) proves unusable, (1) alone is still worth shipping. The plan is sequenced so that discovery happens before any UI work.

### Repo conventions

TypeScript strict, ESM, `.ts` extensions on relative imports. One Hono router per resource, JSDoc above each handler. React components in `src/web/components/`, Tailwind inline. Derived-structure logic belongs in `src/server/lib/` where it can be unit-tested — **exemplar: `src/server/lib/journeys.ts` with `test/journeys.test.ts`**, which is precisely this shape of problem (build a structure from flat rows, test it against fixtures). No lint step.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes |
| run server | `bun run server` | logs `API listening on http://127.0.0.1:8787` |

## Scope

**In:**
- New: `src/server/lib/navtree.ts` — pure tree-building from flat rows.
- `src/server/routes/sessions.ts` — select the missing columns, return the tree.
- `src/web/api.ts` — response types.
- `src/web/components/SessionsView.tsx` — indented rendering plus dead-entry marking.
- New: `test/navtree.test.ts`.

**Out:**
- `src/server/lib/load.ts` and `src/server/lib/sources/takeout.ts`. The data is already written correctly; **no ingest changes**. If you believe an ingest change is needed, that is a STOP condition.
- `src/server/schema.sql`. No schema change; no persisted derived table (see the DELETE note above).
- Research Sessions (`journeys`). Applying parent edges there is tempting and is a separate idea — those come from the visit log, which has no referrer at all.
- Any graph-visualization library. An indented list is the deliverable. No dependency.

## Steps

1. **Discovery first — find out what the data actually contains.** Before writing any code, query the real database:

   ```sql
   SELECT COUNT(*) total,
          COUNT(referrer) with_ref,
          COUNT(NULLIF(referrer,'')) non_empty_ref
     FROM tab_navigations;

   SELECT COUNT(*) navs,
          SUM(CASE WHEN referrer IN (SELECT virtual_url FROM tab_navigations) THEN 1 ELSE 0 END) resolvable
     FROM tab_navigations;

   SELECT COUNT(*) tabs, COUNT(tab_node_id) with_node FROM session_tabs;
   SELECT COUNT(*) FROM tab_navigations WHERE http_status >= 400;
   ```

   **Verify:** you have four concrete numbers written down.

   **This step decides the plan.** If `non_empty_ref` is near zero, there are no parent edges and the tree cannot be built — **STOP and report**, because the premise is false for this data. If referrers exist but few resolve to another entry, ship the within-tab chain only and drop cross-tab parentage.

2. **Create `src/server/lib/navtree.ts`** exporting a pure function:

   ```ts
   export interface NavRow {
     tab_pk: number;
     idx: number | null;
     title: string | null;
     virtual_url: string | null;
     timestamp_ms: number | null;
     http_status: number | null;
     referrer: string | null;
   }
   export interface NavNode extends NavRow { children: NavNode[]; depth: number }

   /** Build a parent/child forest from one tab's flat navigation entries. */
   export function buildNavTree(rows: NavRow[]): NavNode[];
   ```

   Rules, all of which the tests pin:
   - A row whose `referrer` matches another row's `virtual_url` **in the same tab** becomes that row's child.
   - A row with no referrer, an empty referrer, or an unresolvable one is a root.
   - Ties (several rows sharing a `virtual_url`) resolve to the entry with the **greatest `idx` less than the child's `idx`** — the most recent plausible parent.
   - **Cycles must be impossible.** A row may never become its own ancestor; if attaching would create a cycle, make it a root instead. Takeout data is untrusted input and a reload loop (A → B → A) is entirely plausible.
   - Ordering within a level is by `idx` ascending.

   **Verify:** `bunx tsc --noEmit` → exits 0.

3. **Write `test/navtree.test.ts` before wiring the route.** This is pure-function logic with awkward edge cases; test it in isolation. See the test plan below.

   **Verify:** `bun test` → the new tests pass.

4. **Select the missing columns in `src/server/routes/sessions.ts`.** Add `n.referrer` to the navigation query (line 43) and `t.tab_node_id` to the tab query (line 30).

   **Verify:** `curl -s http://127.0.0.1:8787/api/sessions/1 | head -c 400` → the JSON now contains `referrer`.

5. **Return the tree alongside the flat list.** In the response assembly (lines 51–59), keep `navigation` exactly as it is and add `navigationTree: buildNavTree(rowsForThatTab)`.

   Keeping both is deliberate: the client can fall back to the flat list without a second request, and no existing consumer breaks.

   **Verify:** `bunx tsc --noEmit` → exits 0; the endpoint returns both keys.

6. **Update the client types** in `src/web/api.ts` — add `referrer` to the navigation entry type, `tab_node_id` to the tab type, and a recursive `navigationTree` node type.

   **Verify:** `bunx tsc --noEmit` → exits 0.

7. **Render the tree in `SessionsView.tsx`.** Replace the flat navigation rendering with an indented one driven by `navigationTree`, falling back to the existing flat list when the tree is a single flat level (i.e. every node has depth 0 and no children) — that is the Takeout-without-referrers case and it must look exactly like today.

   Indent by `depth`, capping visual indentation at ~6 levels so a deep chain cannot push content off-screen.

   **Verify:** `bun run build` → completes. Then `bun run dev`, open Sessions, expand a window, and confirm nesting is visible where referrers exist.

8. **Mark dead entries.** Where `http_status >= 400`, render the status inline in a muted/danger style — the first time this stored column has ever been shown.

   **Verify:** find a session containing a `>= 400` entry using the step-1 query, open that window in the UI, and confirm the marker appears.

## Test plan

`test/navtree.test.ts`, following `test/journeys.test.ts`'s fixture style — plain arrays in, structure out, no database needed.

- **Simple chain:** A (no referrer) → B (referrer A) → C (referrer B) produces one root of depth 0 with a single descendant path. Assert the depths are 0/1/2 and that the root count is exactly 1.
- **Branching:** A, then B and C both referring to A. Assert A has exactly two children, ordered by `idx`.
- **Orphan referrer:** a row whose referrer matches nothing becomes a root. Assert root count, not just "no throw".
- **Empty and null referrers:** both become roots, and are not treated as matching each other. A naive implementation that groups all empty strings together produces one giant bogus parent — this test catches that.
- **Cycle safety:** A refers to B and B refers to A. Assert the function returns, that every input row appears exactly once in the output forest, and that no node is its own ancestor. **This is the assertion that matters most** — an unguarded implementation infinite-loops here and the input is untrusted.
- **Duplicate URLs:** two rows share a `virtual_url` and a third refers to it. Assert the child attaches to the one with the greatest lesser `idx`, per the stated rule.
- **Every row is preserved:** for each fixture, assert that flattening the output forest yields exactly the input row count. A tree builder that silently drops unattachable rows loses history, which is worse than a flat list.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including `test/navtree.test.ts`
- [ ] `bun run build` completes
- [ ] Step 1's four numbers are recorded in the PR/commit description
- [ ] `GET /api/sessions/:id` returns both `navigation` and `navigationTree`
- [ ] Flattening `navigationTree` yields the same entry count as `navigation`, for every session (spot-check three)
- [ ] A session with no resolvable referrers renders exactly as it does today
- [ ] Entries with `http_status >= 400` are visibly marked
- [ ] No schema change, no ingest change, no new dependency

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- **Step 1 shows effectively no referrers in the data.** The feature's premise is false; report the numbers and stop rather than building a tree with one level.
- You are about to modify `src/server/lib/load.ts`, `src/server/lib/sources/takeout.ts`, or `src/server/schema.sql`.
- You are about to add a graph or visualization dependency.
- The cycle-safety test hangs — that is the bug this plan most expects; fix the builder, do not raise a timeout.
- Any step's **Verify** fails twice.

## Maintenance notes

**Makes easier:** `buildNavTree` is source-agnostic and pure, so if a future adapter ever supplies session data with referrers (Chromium's own session-restore files do carry them), the tree lights up with no further work. `http_status` being rendered establishes the pattern for showing per-navigation metadata.

**Makes harder:** the sessions endpoint now returns two representations of the same data, which will diverge if someone edits one and not the other. Keeping `navigationTree` derived at read time (not stored) is what prevents that from becoming a persistent inconsistency — hold that line.

**Deliberately not done:** no cross-tab parentage via `tab_node_id` unless step 1 shows it is populated and resolvable; no graph rendering; no application of parent edges to Research Sessions (a different data source with no referrer column at all); no reopen-this-subtree action — that is plan 010's direction.

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\006-navigation-tree-for-saved-windows.md in full
before doing anything. It is a self-contained implementation plan: follow the
executor instructions at the top, run the drift check first, execute the steps in
order verifying each before moving on, and stop at any STOP condition. Scope: use
the tab_navigations.referrer and http_status columns — already written at ingest
and never read — to render each saved Takeout window as an indented parent/child
navigation tree with dead entries marked, instead of a flat list. Step 1 is a
discovery query that decides whether the feature is viable at all; do it first
and stop if there are no referrers. No schema changes, no ingest changes, no new
dependencies. Work on a branch; when done, report against the Done criteria
checklist.
```
