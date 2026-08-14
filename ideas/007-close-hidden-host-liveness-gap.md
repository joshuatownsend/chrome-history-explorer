# 007 — Close the hidden-host liveness gap

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> **This plan begins with a decision that is the maintainer's to make (step 0). Do not skip it.**
> Drift check first: `git diff --stat a33971d..HEAD -- src/server/routes/enrich.ts src/server/lib/jobs.ts src/server/lib/rules.ts README.md SECURITY.md`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 8/10
- **Lenses**: inside-out (Signal 2 — stated-but-undelivered) / outside-in (`live-research`)
- **Effort (coarse)**: S
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: none

## Why this matters

The README makes a promise about hidden hosts that the liveness path does not keep.

`README.md:222-223`:

> "Provider/ThreadCrumb keys stay server-side; **private/hidden hosts are never sent to liveness, AI, or ThreadCrumb.**"

But a host matched only by a Hide rule is marked `is_hidden=1, is_private=0`, and every liveness batch scope filters on `is_private` alone. The consequence: clicking "Check top 500" issues outbound HTTP requests to hosts the user explicitly asked the app to hide.

The Settings view's own placeholder text shows what a user is likely to put there — `webmail.example.com`, `*.bank.com` (`src/web/components/SettingsView.tsx:78`). Someone who types their bank's domain into the Hide box reasonably believes nothing leaves the machine for that host.

Every other outbound path gates correctly. AI, clustering, ThreadCrumb, insights, stats and the domain tree all check `is_hidden`. Liveness is the lone exception, which is what makes this look like an oversight rather than a decision.

**Why now:** this repository has just gone public and is courting its first outside users. For local-first tools, an auditable privacy claim *is* the product — the first question evaluators ask (HN 43930899) is:

> "How and where is the full text of every page I visit getting stored & for how long?"

A README promise the code does not keep is expensive precisely at this moment.

**This is explicitly not the accepted SSRF trade-off.** `SECURITY.md` accepts *outbound fetches to private addresses* as intentional ("re-checking your own `homeassistant.local` is the point"). That is about destination address ranges. This is about hosts the user named in a rule — a different thing entirely.

## Step 0 — the decision (do this first)

**The project's two documents disagree with each other, and only one matches the code.**

`README.md:222-223` — hidden hosts are never sent to liveness, AI, or ThreadCrumb.

`SECURITY.md:21-23`:

> "Private/LAN hosts (`localhost`, RFC1918 ranges, `*.local`, and your own rules) are never sent to liveness checks, AI providers, or ThreadCrumb. **Hidden hosts are excluded from every view.**"

SECURITY.md claims only view exclusion for hidden. The code matches SECURITY.md. So there are two valid resolutions:

- **Option A — tighten the code** (recommended, and what steps 1–5 implement). "Hidden" comes to mean *hidden from views AND never contacted*. Simplest to explain, matches what a user typing `*.bank.com` expects, and makes README and SECURITY.md agree without weakening either.
- **Option B — narrow the README.** "Hidden" means view exclusion only; users who also want no outbound contact must add the host to the *private* list as well. Cheaper, but leaves a foot-gun: two lists that must both be edited to get the obvious behavior.

**Confirm which option is wanted before writing code.** If Option B is chosen, this plan reduces to step 6 (documentation) alone — and step 6 must then also state plainly, in both documents, that hiding a host does not stop liveness checks from contacting it.

The steps below implement **Option A**.

## Current state

### `src/server/lib/rules.ts:89-101` — the flags are independent

```ts
  const tx = db.transaction(() => {
    for (const r of rows) {
      const builtIn = parseUrl(r.url).isPrivate;
      const isPriv = builtIn || hostMatches(r.hostname, rules.privatePatterns) ? 1 : 0;
      const isHid = hostMatches(r.hostname, rules.hiddenPatterns) ? 1 : 0;
      if (isPriv) privateCount++;
      if (isHid) hiddenCount++;
      if (isPriv !== r.is_private || isHid !== r.is_hidden) {
        upd.run({ $p: isPriv, $h: isHid, $id: r.id });
        changed++;
      }
    }
  });
```

`isHid` does not feed `isPriv`. A host in the hidden list only is `is_hidden=1, is_private=0`.

### `src/server/routes/enrich.ts:30-55` — all three scopes gate on private only

```ts
  let ids: number[] = [];
  if (body.scope === "top") {
    const n = Math.min(Math.max(body.n ?? 500, 1), 5000);
    ids = db
      .query<{ id: number }, [number]>(
        `SELECT id FROM urls WHERE is_private=0 ORDER BY visit_count DESC LIMIT ?`,
      )
      .all(n)
      .map((r) => r.id);
  } else if (body.scope === "domain" && body.domain) {
    ids = db
      .query<{ id: number }, [string]>(`SELECT id FROM urls WHERE is_private=0 AND domain=?`)
      .all(body.domain)
      .map((r) => r.id);
  } else if (body.scope === "recent") {
    const days = Math.min(Math.max(body.days ?? 30, 1), 365);
    const since = Date.now() - days * 86_400_000;
    ids = db
      .query<{ id: number }, [number]>(
        `SELECT id FROM urls WHERE is_private=0 AND last_visited >= ? ORDER BY last_visited DESC`,
      )
      .all(since)
      .map((r) => r.id);
  }
```

No `is_hidden` predicate in any of the three.

### `src/server/lib/jobs.ts:46-75` — the enqueue gate, the real backstop

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
  ...
      if (row.is_private) {
        if (row.status !== "skipped") upsert.run({ $id: id, $status: "skipped" });
        continue;
      }
```

It selects `u.is_private` and skips only on private. **This is the function that must be fixed** — the three scope queries are the front door, but `enqueueUrlIds` is also reachable from `POST /api/enrich/liveness/ensure` (`enrich.ts:8-15`), which takes arbitrary URL ids from the client as the table scrolls. Fixing only the scopes would leave the lazy path open.

### `src/server/routes/ai.ts:103` — the correct pattern to copy

```ts
        `SELECT id, url, title, is_private FROM urls WHERE is_private=0 AND is_hidden=0 ORDER BY visit_count DESC`,
```

That is what "gating correctly" looks like in this codebase.

### Repo conventions

TypeScript strict, ESM, `.ts` extensions on relative imports. Tests are `bun:test` unit tests of `lib/` modules — **exemplar: `test/security.test.ts`**, which is the existing test file for exactly this class of guarantee. Add to it or mirror it. No lint step.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes |
| run server | `bun run server` | logs `API listening on http://127.0.0.1:8787` |

## Scope

**In:**
- `src/server/lib/jobs.ts` — the `enqueueUrlIds` gate.
- `src/server/routes/enrich.ts` — the three scope queries.
- `README.md` and `SECURITY.md` — reconcile the wording.
- New tests in `test/security.test.ts` (or a sibling `test/privacy-gate.test.ts`).

**Out:**
- `src/server/lib/rules.ts`. Do **not** make hidden imply private in the flag computation — that would change what the Settings view reports and would make hidden hosts invisible in views *and* marked with a lock, conflating two user-facing concepts. Gate at the point of egress, not in the flags.
- The AI, clustering, ThreadCrumb, insights, stats and tree routes. All already correct; leave them.
- The `enrichments` row for an already-checked hidden host. Existing stored results are not deleted by this plan (see Maintenance notes).
- Any UI change.

## Steps

1. **Confirm the behavior today, before changing anything.** Add a temporary hidden rule for a domain you have real history for (Settings → "Hide entirely"), then:

   ```
   bun -e "const {Database}=require('bun:sqlite');const db=new Database('data/history.db');console.log(db.query('SELECT COUNT(*) n FROM urls WHERE is_hidden=1 AND is_private=0').get())"
   ```

   **Verify:** a non-zero count — these are the URLs currently reachable by liveness despite being hidden. Record the number; step 5 re-checks it.

2. **Fix the enqueue gate in `src/server/lib/jobs.ts`.** Add `u.is_hidden` to the `getUrl` select, and skip on either flag:

   ```ts
   if (row.is_private || row.is_hidden) {
     if (row.status !== "skipped") upsert.run({ $id: id, $status: "skipped" });
     continue;
   }
   ```

   Update the function's doc comment (line 43) so it no longer says "Private hosts are recorded as 'skipped'" when it now means private *or hidden*.

   **Verify:** `bunx tsc --noEmit` → exits 0.

3. **Fix the three scope queries in `src/server/routes/enrich.ts`.** Add `AND is_hidden=0` to each of the `top`, `domain` and `recent` queries, matching `routes/ai.ts:103`.

   This is belt-and-braces over step 2 — but it also keeps the reported `candidates` count honest, which it would not be if hidden URLs were selected and then silently skipped.

   **Verify:** `bunx tsc --noEmit` → exits 0.

4. **Add the regression tests** (see the test plan). Write them before running the manual check, so a future refactor cannot silently undo this.

   **Verify:** `bun test` → passes, including the new assertions.

5. **Manual end-to-end check.** With the hidden rule from step 1 still in place, run a scoped batch: `POST /api/enrich/liveness/batch {"scope":"top","n":5000}`. Then:

   ```
   bun -e "const {Database}=require('bun:sqlite');const db=new Database('data/history.db');console.log(db.query(\"SELECT e.status, COUNT(*) n FROM enrichments e JOIN urls u ON u.id=e.url_id WHERE u.is_hidden=1 AND e.kind='liveness' GROUP BY e.status\").all())"
   ```

   **Verify:** no hidden URL is in `pending` or `running`. Rows that were already `done` from before this fix may remain — that is expected and covered in Maintenance notes.

6. **Reconcile the documents.** Make one sentence describe hidden's guarantee, and make both files agree:
   - `README.md:222-223` — already correct under Option A; verify the wording covers liveness, AI, and ThreadCrumb.
   - `SECURITY.md:21-23` — change "Hidden hosts are excluded from every view" to state both properties: excluded from every view **and** never contacted by liveness, AI, or ThreadCrumb.
   - The Settings view copy — check `src/web/components/SettingsView.tsx` describes "Hide entirely" consistently with the new behavior. If it only mentions view exclusion, update the description text (copy only, no logic).

   **Verify:** `grep -n "hidden" README.md SECURITY.md` → every claim is consistent, and no sentence in either file contradicts the other.

## Test plan

Extend `test/security.test.ts` or add `test/privacy-gate.test.ts`. Build a temporary database with a handful of `urls` rows covering every flag combination.

- **Hidden-only URL is never queued.** Seed a URL with `is_private=0, is_hidden=1`, call `enqueueUrlIds([id])`, assert the return value is `0` **and** the `enrichments` row for it has `status='skipped'`. Both halves matter: the count proves it was not queued, the row proves it was deliberately recorded rather than silently ignored.
- **Private-only URL still behaves as before.** `is_private=1, is_hidden=0` → `skipped`. This is the pre-existing guarantee; the test pins it so this change cannot regress it.
- **Both flags set** → `skipped`, and `enqueueUrlIds` returns `0`.
- **Neither flag set** → queued, returns `1`, row status `pending`. Without this the other tests would pass on a function that skips everything.
- **Scope queries exclude hidden.** Seed five public URLs and two hidden ones, run the `top` scope's SQL, and assert the returned id list contains **none** of the hidden ids. Assert on the ids, not the count.
- **The lazy path is covered too.** Assert via `enqueueUrlIds` directly with a hidden id, since that is what `POST /api/enrich/liveness/ensure` calls with client-supplied ids. This is the path a scope-only fix would have missed.

## Done criteria

- [ ] Step 0's decision is recorded in the commit message (Option A or B, and why)
- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including the new privacy-gate assertions
- [ ] `bun run build` completes
- [ ] `enqueueUrlIds` on a hidden-only URL returns 0 and records `skipped`
- [ ] All three scope queries in `enrich.ts` contain `is_hidden=0`
- [ ] After a full `top` batch, no `is_hidden=1` URL is `pending` or `running`
- [ ] Liveness still works normally for public URLs (run a batch, see counts move)
- [ ] `README.md` and `SECURITY.md` describe hidden's guarantee identically
- [ ] `src/server/lib/rules.ts` is unchanged

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- Step 0 has not been answered by the maintainer.
- You are about to modify `src/server/lib/rules.ts` to make hidden imply private.
- You are about to weaken the existing `is_private` gate in any way.
- Step 5 shows hidden URLs still reaching `pending` after both fixes — report rather than adding a third guard somewhere else.
- Any step's **Verify** fails twice.

## Maintenance notes

**Already-stored results.** A hidden host that was liveness-checked *before* this fix still has a `done` enrichment row with its status code and final URL. This plan does not delete those. Deleting them is defensible (the data was collected against the user's stated intent) and so is keeping them (deleting is destructive and the check already happened). **Raise it as a question rather than deciding silently** — a follow-up could offer a "purge enrichments for hidden hosts" button in Settings, which pairs naturally with plan 004's egress audit log.

**Makes easier:** establishes egress gating as a property checked at the enqueue boundary rather than duplicated across callers — the right place for any future outbound feature to hook into.

**Makes harder:** nothing meaningfully. The gate costs one extra column in an already-indexed lookup.

**A note for reviewers:** the reason this was missed is worth remembering. `is_private` and `is_hidden` are computed independently and read independently, so "gated correctly" had to be verified per call site, and six of seven were right. A single `canContactExternally(urlRow)` helper would make the seventh impossible to forget. Deliberately not introduced here to keep the fix minimal, but it is the obvious follow-up.

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\007-close-hidden-host-liveness-gap.md in full
before doing anything. It is a self-contained implementation plan: follow the
executor instructions at the top, run the drift check first, execute the steps in
order verifying each before moving on, and stop at any STOP condition. Scope:
hosts the user marked "hide entirely" are currently still contacted by liveness
checks, contradicting README.md:222 — gate them at enqueueUrlIds in
src/server/lib/jobs.ts and in the three scope queries in
src/server/routes/enrich.ts, then reconcile README.md and SECURITY.md so both
describe the same guarantee. STEP 0 IS A DECISION FOR THE MAINTAINER (tighten the
code vs. narrow the README) — confirm it before writing code. Do not change
src/server/lib/rules.ts. Work on a branch; when done, report against the Done
criteria checklist.
```
