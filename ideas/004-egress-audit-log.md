# 004 — Show what left the machine: an egress audit log

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> Drift check first: `git diff --stat a33971d..HEAD -- src/server/schema.sql src/server/lib/jobs.ts src/server/routes/ai.ts src/server/routes/threadcrumb.ts src/server/routes/settings.ts src/web/components/SettingsView.tsx`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 9/10
- **Lenses**: inside-out (Signal 4 — the adjacent possible) / outside-in (`live-research`)
- **Effort (coarse)**: M
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: none. **Pairs with plan 007**, which fixes an egress gap this view would have made visible.

## Why this matters

This project's pitch is that your data stays on your machine. That is very nearly true — it binds to loopback, has no cloud component, and never phones home. But it has **three optional outbound paths**, and today there is no way to see what has gone through them.

For the audience this project is courting, that visibility is not a nice-to-have. The first question asked of every tool in this space, before any feature discussion (HN 43930899):

> "How and where is the full text of every page I visit getting stored & for how long?"

And on why people choose tools like this at all — from the thread where Memex confirmed it was no longer open source (#1229, 5 reactions):

> "...hope that they do not move away from being FOSS. That was the main reason I chose to use Memex."

The privacy-rules feature already states *intent*: these hosts are private, these are hidden. What is missing is *outcome*: here is what actually left. Plan 007 exists precisely because those two can diverge silently — hidden hosts have been reachable by liveness checks the whole time, and nothing in the app would have shown you.

**The leverage is that the record already exists.** Every liveness check, summary and embedding writes an `enrichments` row with a `fetched_at` timestamp. The app has been keeping an egress log since day one and has never shown it to anyone.

**"Good" looks like:** a Settings panel that answers, without hedging — which hosts has this app contacted, by which path, when, and what was deliberately skipped.

## Current state

### The three egress paths

**1. Liveness** — `src/server/lib/jobs.ts:99-129`. `processOne` calls `checkLiveness(row.url)` and writes the result:

```ts
  try {
    const result = await checkLiveness(row.url);
    db.query(
      `UPDATE enrichments SET status='done', fetched_at=$at, result_json=$json, error=$err WHERE id=$id`,
    ).run({
      $id: row.id,
      $at: result.fetched_at,
      $json: JSON.stringify(result),
      $err: result.error ?? null,
    });
```

Note it reaches two external parties: the URL's own host, and — for dead links only — `archive.org` via `queryWayback` (`src/server/lib/liveness.ts:108-128`). The Wayback call is a genuine third-party contact that no one would infer from "liveness check".

**2. AI** — `src/server/routes/ai.ts`. Summaries fetch the page (`fetchReadableText`, line 43) *and then* send its text to a provider (line 50). Embeddings send `title + url` to OpenAI (lines 133–136). Both write `enrichments` rows with `fetched_at`.

**3. ThreadCrumb** — `src/server/routes/threadcrumb.ts:69-76` posts to `threadcrumb.io` (or a self-hosted base URL). **This path writes nothing at all** — there is no record anywhere that a send happened. It is the one gap in the existing data.

### What the existing rows already give you

`src/server/schema.sql:101-111`:

```sql
CREATE TABLE IF NOT EXISTS enrichments (
  id          INTEGER PRIMARY KEY,
  url_id      INTEGER NOT NULL REFERENCES urls(id),
  kind        TEXT NOT NULL,      -- 'liveness' | 'summary' | 'embedding'
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|skipped
  fetched_at  INTEGER,            -- epoch ms
  result_json TEXT,
  error       TEXT,
  UNIQUE(url_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_enrich_kind_status ON enrichments(kind, status);
```

Joined to `urls`, that is: which URL, which kind of egress, when, and whether it succeeded. `status='skipped'` additionally records what was **deliberately not sent** — the privacy gate working, which is exactly what a user wants to see.

**The important limitation, stated honestly:** `UNIQUE(url_id, kind)` means one row per URL per kind. This is a *current-state* record, not an append-only history. It answers "has this URL ever been sent, and when most recently" — not "how many times". Building the panel on this data is cheap and truthful as long as it is labelled as current state. **Do not present it as a complete historical log**, and do not add an append-only table in this plan (see Maintenance notes).

### Where it would live

`src/server/routes/settings.ts` and `src/web/components/SettingsView.tsx` already own the privacy-rules UI — the natural home, because intent and outcome belong side by side.

### Repo conventions

TypeScript strict, ESM, `.ts` extensions on relative imports. One Hono router per resource with JSDoc per handler. React components in `src/web/components/`, Tailwind inline, all fetches through `api.*` in `src/web/api.ts`. Tests are `bun:test` unit tests of `lib/` modules — exemplar `test/security.test.ts` for privacy-shaped guarantees. No lint step.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes |
| run server | `bun run server` | logs `API listening on http://127.0.0.1:8787` |

## Scope

**In:**
- New: `src/server/lib/egress.ts` — the aggregation query, unit-testable.
- New: `src/server/routes/egress.ts` — a read-only route, mounted in `src/server/index.ts`.
- `src/server/routes/threadcrumb.ts` — record a row on successful send.
- `src/web/api.ts` — client method and types.
- `src/web/components/SettingsView.tsx` — the panel.
- New: `test/egress.test.ts`.
- `README.md` — a short "what leaves your machine" section.

**Out:**
- An append-only egress history table. Deliberately deferred; see Maintenance notes.
- Any change to `src/server/lib/jobs.ts`, `src/server/lib/liveness.ts`, or the AI routes. They already write what is needed. **Do not add logging calls to them.**
- Blocking, throttling, or a kill switch for egress. This plan is read-only observability. Enforcement is the privacy rules' job (and plan 007's).
- Deleting or purging enrichment rows.

## Steps

1. **Create `src/server/lib/egress.ts`** with one exported function returning the whole picture:

   ```ts
   export interface EgressDestination {
     host: string;            // the external party contacted
     via: "liveness" | "summary" | "embedding" | "threadcrumb" | "wayback";
     urlCount: number;        // distinct URLs involved
     firstAt: number | null;  // epoch ms
     lastAt: number | null;
     failed: number;
   }
   export interface EgressSummary {
     destinations: EgressDestination[];
     skipped: { private: number; hidden: number };
     providers: { summaries: number; embeddings: number };
     generatedAt: number;
   }
   export function getEgressSummary(db: Database): EgressSummary;
   ```

   Build it from `enrichments` joined to `urls`, grouped by `urls.hostname` for `liveness` (the app contacted the page's own host) and by a **fixed provider host** for `summary` / `embedding` — because those did not contact the page's host, they contacted `api.openai.com` or `api.anthropic.com`.

   **This distinction is the entire point of the panel.** A summary means two different external parties were contacted: the page's host (fetched) *and* the provider (sent the text). Represent both, or the panel lies by omission.

   Derive the provider host from the stored `result_json.provider` field that `routes/ai.ts:55` already writes; fall back to `"(unknown provider)"` rather than guessing.

   **Verify:** `bunx tsc --noEmit` → exits 0.

2. **Count the skipped rows.** `status='skipped'` is written by the privacy gate. Count them split by the URL's current flags:

   ```sql
   SELECT SUM(u.is_private) private, SUM(u.is_hidden) hidden
     FROM enrichments e JOIN urls u ON u.id = e.url_id
    WHERE e.status = 'skipped'
   ```

   Surfacing this is what turns the panel from a worry-generator into a reassurance: it shows the gate working.

   **Verify:** `bunx tsc --noEmit` → exits 0.

3. **Include Wayback as a destination.** For `kind='liveness'` rows whose `result_json` contains an `archived_url`, `archive.org` was contacted. Count those separately with `via: "wayback"`.

   **Verify:** if any dead links exist in the database, the summary includes an `archive.org` destination.

4. **Record ThreadCrumb sends.** In `src/server/routes/threadcrumb.ts`, after a successful `sendToThreadcrumb` (inside the `try`, after the await at line 70), upsert an enrichment row:

   ```ts
   db.query(
     `INSERT INTO enrichments (url_id, kind, status, fetched_at, result_json)
      VALUES ($id, 'threadcrumb', 'done', $at, $json)
      ON CONFLICT(url_id, kind) DO UPDATE SET status='done', fetched_at=$at, result_json=$json, error=NULL`,
   ).run({ $id: u.id, $at: Date.now(), $json: JSON.stringify({ baseUrl: threadcrumbConfig().baseUrl }) });
   ```

   Store the base URL only. **Never store the token, and never store the capture context** — the context can contain the page title, and this row exists to record that a send happened, not to duplicate its payload.

   Do this *after* the send succeeds, so a failed send is not recorded as egress that did not occur.

   **Verify:** with a token configured, send one URL, then
   `bun -e "const {Database}=require('bun:sqlite');console.log(new Database('data/history.db').query(\"SELECT COUNT(*) n FROM enrichments WHERE kind='threadcrumb'\").get())"`
   → returns 1. Then grep the row's `result_json` and confirm no token substring appears.

5. **Add the read-only route** `src/server/routes/egress.ts` — `GET /api/egress` returning `getEgressSummary(getDb())`. Mount it in `src/server/index.ts` beside the others.

   **Verify:** `curl -s http://127.0.0.1:8787/api/egress | head -c 500` → JSON with `destinations`, `skipped`, `providers`.

6. **Add the client method and types** to `src/web/api.ts`, following the shape of the existing `getJson` helpers.

   **Verify:** `bunx tsc --noEmit` → exits 0.

7. **Add the panel to `SettingsView.tsx`**, below the privacy rules. It must show, without softening:
   - a table of destinations: host, via, URL count, last contacted;
   - the skipped counts, phrased as what was protected;
   - a plain-language line stating the three paths that can cause egress and that all are optional;
   - an explicit note that this is **current state, not a complete history** — one row per URL per kind, so a URL checked twice appears once with its most recent timestamp.

   Reuse the component's existing Tailwind idiom rather than introducing new styles.

   **Verify:** `bun run build` → completes; `bun run dev` and open Settings → the panel renders with real rows.

8. **Document it.** Add a short "What leaves your machine" section to `README.md` near the Privacy section, listing the three paths, naming `archive.org` as a fourth party contacted for dead links, and pointing at the Settings panel.

   **Verify:** re-read the Privacy and Security sections and confirm nothing there now under-describes egress.

## Test plan

`test/egress.test.ts`, against a temporary database seeded with a known mix of enrichment rows.

- **Liveness attributes to the page host:** a `done` liveness row for `https://example.com/x` produces a destination with host `example.com`, `via: "liveness"`. Assert the host string exactly.
- **Summary attributes to BOTH parties:** a `done` summary row produces two destinations — the page's host (fetched) and the provider host (sent). Assert **two** entries. This is the assertion most likely to be got wrong, and getting it wrong makes the panel misleading.
- **Wayback appears only when archived:** seed one liveness row with `archived_url` and one without; assert exactly one `archive.org` destination.
- **Skipped counts are correct and split:** seed one `skipped` row on a private URL and one on a hidden URL; assert `skipped.private === 1` and `skipped.hidden === 1`. This is the reassurance half of the panel and must be exact.
- **Nothing is reported for URLs never contacted:** seed a `urls` row with no enrichment at all and assert it contributes no destination. A summary that over-reports egress is worse than none.
- **No secret ever appears in the output:** set a fake `THREADCRUMB_TOKEN` in the test environment, build a summary containing a threadcrumb row, and assert the serialized JSON does not contain the token string. **This is a hard requirement, not a nicety.**
- **Malformed `result_json` is survivable:** a row with `"{not json"` does not throw and does not produce a bogus destination.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including `test/egress.test.ts`
- [ ] `bun run build` completes
- [ ] `GET /api/egress` returns destinations, skipped counts and provider counts
- [ ] A summarized URL produces **two** destinations (page host and provider host)
- [ ] Dead links with archives produce an `archive.org` destination
- [ ] A ThreadCrumb send records a `kind='threadcrumb'` row containing no token
- [ ] `grep -rn "THREADCRUMB_TOKEN\|API_KEY" src/server/routes/egress.ts src/server/lib/egress.ts` returns nothing
- [ ] The panel states plainly that it is current state, not a full history
- [ ] `src/server/lib/jobs.ts`, `liveness.ts` and the AI routes are unchanged
- [ ] README describes what leaves the machine, including `archive.org`

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- You are about to add logging calls into `jobs.ts`, `liveness.ts` or the AI routes. The data is already there; if it seems not to be, report what is missing rather than instrumenting.
- You are about to store a token, an API key, an Authorization header, or a capture-context payload in any row or response.
- You are about to add an append-only egress table or a schema migration. Out of scope.
- You are about to add blocking or throttling behavior. This plan is read-only.
- Any step's **Verify** fails twice.

## Maintenance notes

**The append-only question, deliberately deferred.** `UNIQUE(url_id, kind)` caps this at one row per URL per kind, so re-checks overwrite. A true audit log would be a separate append-only table written at each egress point — more honest, but it grows unboundedly, needs retention policy, and requires touching all three egress paths. **Build the cheap truthful version first**, see whether the panel gets used, and only then decide. Labelling it accurately (step 7) is what makes deferring this honest rather than sloppy.

**Makes easier:** any future outbound feature has an obvious place to register itself, and a reviewer has a single screen to check the privacy claim against. Pairs naturally with a "purge enrichments for hidden hosts" action, which plan 007's maintenance notes raise as an open question.

**Makes harder:** the panel becomes a claim the project must keep true. If a future feature contacts a third party without writing an enrichment row, the panel will quietly under-report — which is worse than not having it. Add a line to `SECURITY.md` stating that every outbound path must be representable here.

**Deliberately not done:** no per-request log, no retention policy, no export of the audit data (plan 008 could cover that), no blocking, no notification when egress occurs.

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\004-egress-audit-log.md in full before doing
anything. It is a self-contained implementation plan: follow the executor
instructions at the top, run the drift check first, execute the steps in order
verifying each before moving on, and stop at any STOP condition. Scope: build a
read-only "what left my machine" panel in Settings from the enrichments rows the
app already writes — showing which external hosts were contacted via which path
(liveness, summary, embedding, threadcrumb, wayback), when, and what the privacy
gate skipped. Record ThreadCrumb sends, which currently leave no trace. Never
store or emit any token or API key. Do not add an append-only table, and do not
add logging into jobs.ts, liveness.ts or the AI routes — the data is already
there. Work on a branch; when done, report against the Done criteria checklist.
```
