# 003 — Open tabs into the right Chrome profile

> Executor instructions: follow steps in order; verify each before the next.
> If a STOP condition triggers, stop and report — do not improvise.
> Drift check first: `git diff --stat a33971d..HEAD -- src/server/routes/open.ts src/server/lib/sources/detect.ts src/web/components/SessionsView.tsx src/web/api.ts`
> If in-scope files changed since planning, STOP and report drift.

- **Status**: SELECTED
- **Verdict**: Advance
- **Score**: 9/10
- **Lenses**: inside-out (Signal 3 — surface asymmetries) / outside-in (`interview`)
- **Effort (coarse)**: S
- **Planned at**: `a33971d` on 2026-08-12
- **Depends on**: none

## Why this matters

This is not a missing feature. It is a shipped feature that is **actively wrong** for the only confirmed user of this software.

The maintainer runs several Chrome profiles simultaneously — personal, work, and one per client — each signed into different accounts. His words, when asked what he does around the app that it doesn't support:

> "...moving tabs across windows (different chrome sessions with different logins for personal, work, clients, etc.)"

When he clicks "reopen" on a saved session, the app hands the URL to the *operating system's default browser*. The tab opens in whichever Chrome profile happens to be default — frequently the wrong one, with the wrong logins. For a client URL that means either a login wall or, worse, silently loading a client page in a personal profile.

The app already knows the answer. It enumerates every Chrome profile on the machine in order to import from them, and it stores which profile a visit came from, in the `source` column of every visit row. It has simply never used that knowledge in the outbound direction.

**"Good" looks like:** reopening a tab that came from `chrome:Profile 2` opens it in `Profile 2`, and reopening something with no known profile behaves exactly as it does today.

## Current state

### `src/server/routes/open.ts` — the entire file is 52 lines

The validator (lines 7–16) and the launcher (lines 18–32):

```ts
/** Only real web URLs may be opened. Rejects file:, chrome:, javascript:, etc. */
function isOpenableUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * Launch a URL in the OS default browser. The URL is passed as a literal argv
 * element (never interpolated into a shell string), so query strings with `&`
 * and other metacharacters cannot inject a command.
 */
function launch(url: string): void {
  if (process.platform === "win32") {
    // rundll32 hands the URL straight to the default protocol handler.
    Bun.spawn(["rundll32", "url.dll,FileProtocolHandler", url], { stdout: "ignore", stderr: "ignore" });
  } else if (process.platform === "darwin") {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  } else {
    Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  }
}
```

The handler (lines 34–52), including the bulk cap at line 5 (`const MAX_BULK = 50;`):

```ts
open.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { urls?: unknown };
  const list = Array.isArray(body.urls) ? body.urls : [];
  const valid = list.filter(isOpenableUrl);

  if (valid.length === 0) return c.json({ opened: 0, rejected: list.length });
  if (valid.length > MAX_BULK) {
    return c.json({ error: `Refusing to open ${valid.length} tabs (max ${MAX_BULK}).` }, 400);
  }

  for (const url of valid) launch(url);
  return c.json({ opened: valid.length, rejected: list.length - valid.length });
});
```

**The argv-isolation property at lines 18–22 is load-bearing security** and must survive this change. `INSIGHTS.md:135` records why:

> "argv isolation is the actual injection defense, not URL validation. Even a URL containing `& calc.exe` is harmless because `Bun.spawn([...])` passes it as one element of an argument vector straight to `rundll32` — no `cmd.exe`, no shell tokenization."

Every new argument this plan adds must go through the same array form. **Never build a command string.**

### `src/server/lib/sources/detect.ts` — where profile knowledge already lives

`chromiumRoots()` (lines 26–57) hardcodes the User Data directory per browser per platform. The Windows entries (lines 28–37):

```ts
    return [
      { browser: "Chrome", slug: "chrome", userDataDir: join(LOCALAPPDATA, "Google", "Chrome", "User Data") },
      { browser: "Edge", slug: "edge", userDataDir: join(LOCALAPPDATA, "Microsoft", "Edge", "User Data") },
      { browser: "Brave", slug: "brave", userDataDir: join(LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data") },
      ...
    ];
```

Profile discovery and the label format (lines 110–124):

```ts
  for (const def of chromiumRoots()) {
    for (const profile of listDirs(def.userDataDir)) {
      // Chromium profiles are "Default" / "Profile N" / "Guest Profile" with a History file.
      const dbPath = join(def.userDataDir, profile, "History");
      if (!existsSync(dbPath)) continue;
      const meta = withProbe ? probe("chromium", dbPath) : { visitCount: null, lastVisitMs: null };
      found.push({
        browser: def.browser,
        kind: "chromium",
        label: `${def.slug}:${profile}`,
        path: dbPath,
        ...meta,
      });
    }
  }
```

**So the label is exactly `<slug>:<profile-directory-name>`** — e.g. `chrome:Default`, `chrome:Profile 2`, `edge:Default`. The second half is precisely the value Chrome's `--profile-directory` flag expects. That is the whole reason this plan is small.

### The gap detect.ts does *not* close

`detect.ts` knows the **User Data** directory, not the **executable** path. Chrome's data lives under `%LOCALAPPDATA%` while `chrome.exe` lives under `%PROGRAMFILES%`. Resolving the binary is new work and is the only genuinely fiddly part of this plan.

### Where the profile is recorded per visit

`src/server/schema.sql:38-45`:

```sql
CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY,
  url_id     INTEGER NOT NULL REFERENCES urls(id),
  time_ms    INTEGER NOT NULL,    -- epoch ms (UTC)
  client_id  TEXT REFERENCES devices(client_id), -- physical device (Takeout sync hash)
  source     TEXT NOT NULL DEFAULT 'takeout',     -- ingestion provenance (browser/export)
  transition TEXT                 -- normalized: link|typed|reload|form|bookmark|redirect|generated|other
);
```

`visits.source` holds exactly the same label string (`chrome:Default`). So "which profile did this URL come from" is a `SELECT DISTINCT source FROM visits WHERE url_id = ?` — the identical query `routes/threadcrumb.ts:64-67` already runs for another purpose.

### The only caller

`src/web/components/SessionsView.tsx:31` — `const res = await api.openUrls(valid);` is the sole caller of the open endpoint anywhere in the frontend.

### Repo conventions

TypeScript strict, ESM, `.ts` extensions on relative imports. Node built-ins imported as `node:fs`, `node:os`, `node:path` (see `detect.ts:1-3`). Tests are `bun:test` unit tests of `lib/` modules — exemplar `test/adapters.test.ts` for platform-shaped logic. No lint step.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| typecheck | `bunx tsc --noEmit` | exits 0, no output |
| test | `bun test` | all tests pass |
| build | `bun run build` | Vite build completes |
| run server | `bun run server` | logs `API listening on http://127.0.0.1:8787` |

## Scope

**In:**
- New: `src/server/lib/browsers.ts` — executable resolution and profile-aware launch argv.
- `src/server/routes/open.ts` — accept an optional profile, route to the new launcher.
- `src/web/api.ts` — the `openUrls` signature only.
- `src/web/components/SessionsView.tsx` — pass the profile through.
- New: `test/browsers.test.ts`.

**Out:**
- `src/server/lib/sources/detect.ts`. Reading `chromiumRoots()` is expected; **modifying it is not**. If executable paths belong there, that is a follow-up refactor, not this plan.
- The `MAX_BULK = 50` cap and `isOpenableUrl`. Both stay exactly as they are.
- Firefox and Safari. Firefox profile switching uses a different flag (`-P`) with different semantics, and Safari has none. Chromium-family only.
- Any attempt to *focus* an existing window, reuse a specific window, or move a tab. That is plan 010's territory.

## Steps

1. **Create `src/server/lib/browsers.ts` with executable resolution.** Export:

   ```ts
   export interface LaunchTarget {
     exe: string;
     profileDir: string;
   }
   /** Resolve a source label like "chrome:Profile 2" to an executable + profile directory. */
   export function resolveLaunchTarget(sourceLabel: string): LaunchTarget | null;
   ```

   Parse the label on the **first** colon only — profile directory names can contain spaces but the slug cannot contain a colon. Map the slug to candidate executable paths per platform, returning the first that exists (`existsSync`):

   - **win32** — Chrome: `%PROGRAMFILES%\Google\Chrome\Application\chrome.exe`, then `%PROGRAMFILES(X86)%\...`, then `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` (per-user installs are common and are the case most often missed). Edge: `%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe`. Brave: `...\BraveSoftware\Brave-Browser\Application\brave.exe`. Vivaldi, Opera similarly.
   - **darwin** — `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, and the equivalents.
   - **linux** — resolve from `PATH` (`google-chrome`, `chromium`, `microsoft-edge`, `brave-browser`, `vivaldi`).

   Return `null` for any unknown slug, for a non-chromium slug (`firefox`, `safari`), and when no candidate exists. **`null` means "fall back to the current behavior"** — never an error.

   **Verify:** `bunx tsc --noEmit` → exits 0.

2. **Add the argv builder** in the same file:

   ```ts
   export function launchArgs(target: LaunchTarget, url: string): string[] {
     return [target.exe, `--profile-directory=${target.profileDir}`, url];
   }
   ```

   Returning an array is the whole safety property — the caller passes it straight to `Bun.spawn`. Do not add a function that returns a command string, even for logging.

   **Verify:** `bunx tsc --noEmit` → exits 0.

3. **Teach `launch()` about an optional profile** in `src/server/routes/open.ts`:

   ```ts
   function launch(url: string, sourceLabel?: string): void {
     if (sourceLabel) {
       const target = resolveLaunchTarget(sourceLabel);
       if (target) {
         Bun.spawn(launchArgs(target, url), { stdout: "ignore", stderr: "ignore" });
         return;
       }
     }
     // …existing OS-default-browser behavior, unchanged…
   }
   ```

   The existing platform branches stay byte-identical below. Every unresolved case falls through to them.

   **Verify:** `bunx tsc --noEmit` → exits 0.

4. **Accept an optional `profile` in the request body.** Change the body type to `{ urls?: unknown; profile?: unknown }`, accept `profile` only when it is a string matching `/^[a-z-]+:.{1,64}$/`, and pass it to `launch`. Reject anything else by ignoring it — an invalid profile must degrade to the default browser, never error.

   **Verify:** `bunx tsc --noEmit` → exits 0. Then:
   `curl -s -X POST http://127.0.0.1:8787/api/open -H 'content-type: application/json' -d '{"urls":["https://example.com"],"profile":"nonsense"}'`
   → responds `{"opened":1,...}` and the page opens in the default browser.

5. **Thread the profile through the client.** In `src/web/api.ts`, add an optional second parameter to `openUrls(urls: string[], profile?: string)`. In `src/web/components/SessionsView.tsx:31`, pass the session's source label if one is available on the row; pass nothing if not.

   If `session_tabs` has no source label available in the current response shape, **pass nothing and stop there** — deriving it per URL is step 6 and is optional.

   **Verify:** `bunx tsc --noEmit` → exits 0, `bun run build` → completes.

6. **(Optional, only if step 5 had no label to pass.)** Resolve the profile server-side: for a single-URL open, look up `SELECT source FROM visits WHERE url_id = ? GROUP BY source ORDER BY COUNT(*) DESC LIMIT 1`, mirroring the query pattern at `routes/threadcrumb.ts:64-67`. Use it only when the request supplied no explicit profile.

   **Verify:** open a URL you know came from a non-default profile and confirm it lands in that profile.

7. **Manual verification on the real machine.** With at least two Chrome profiles present, open a URL with `profile: "chrome:Default"` and again with the label of a second profile.

   **Verify:** the two URLs open in visibly different Chrome windows, signed into different accounts. **This is the check the whole plan exists for** — if it fails, nothing else matters.

## Test plan

`test/browsers.test.ts`. Pure-function tests only; do not spawn a browser in tests.

- **Label parsing:** `chrome:Default` → slug `chrome`, profile `Default`. `chrome:Profile 2` → profile `Profile 2` (asserting the space survives). `edge:Default` → slug `edge`. A label with a colon in the profile name splits on the *first* colon only.
- **Non-chromium slugs return null:** `firefox:abc123.default`, `safari`, and a bare string with no colon all return `null`. Assert `null` explicitly — this is the fallback contract.
- **Unknown slug returns null:** `netscape:Default` → `null`.
- **`launchArgs` shape:** assert the returned array has exactly three elements, that element 1 is exactly `--profile-directory=Profile 2` for that profile, and that the URL is element 2 **unmodified**. Then assert with a hostile URL containing `& calc.exe` and a space that it is still a single unmodified array element. **This is the security regression test** — it is the most important assertion in the file.
- **Profile-string validation:** the route's accepted pattern matches `chrome:Default` and rejects `../../etc`, a 300-character string, and a value containing a newline.

Note the resolution functions touch the filesystem via `existsSync`; test the parsing and argv construction, which are pure. Executable resolution is environment-dependent and is covered by step 7's manual check, not by a unit test that would pass or fail based on what is installed on the runner.

## Done criteria

- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun test` passes, including `test/browsers.test.ts`
- [ ] `bun run build` completes
- [ ] Opening with a valid profile label lands the tab in that Chrome profile (step 7)
- [ ] Opening with **no** profile behaves exactly as before (default browser)
- [ ] Opening with an unresolvable or malformed profile falls back silently to the default browser — no error, no 500
- [ ] `MAX_BULK` is still 50 and `isOpenableUrl` is unchanged
- [ ] `grep -n "Bun.spawn" src/server/` shows every call still passing an **array**, never a string
- [ ] No new dependency in `package.json`

## STOP conditions

- The drift check shows any in-scope file changed since `a33971d`.
- You are about to construct a shell command string anywhere, or pass `shell: true` to `Bun.spawn`. The argv-isolation property is the injection defense; breaking it is worse than shipping nothing.
- You are about to modify `src/server/lib/sources/detect.ts`.
- You are about to change `MAX_BULK` or `isOpenableUrl`.
- Step 7 shows tabs still landing in the wrong profile after the flag is applied — report what Chrome actually did rather than trying alternative flags at random.
- Any step's **Verify** fails twice.

## Maintenance notes

**Makes easier:** `src/server/lib/browsers.ts` becomes the place any future browser-invocation work lives — plan 010's spike will need executable resolution regardless of whether it chooses an extension or the DevTools Protocol, and this file is exactly that lookup.

**Makes harder:** hardcoded executable paths join the hardcoded User Data paths in `detect.ts` as a second per-platform table that drifts as browsers change install locations. Worth consolidating later; deliberately not consolidated now, to keep this change small and reviewable.

**Deliberately not done:** no Firefox (`-P` has different semantics and interacts with the profile manager), no Safari (no equivalent), no window targeting or focus control, and no UI for choosing a profile manually — the profile is inferred from provenance, not selected.

## Kickoff prompt

> Copy-paste to start this work in any session or agent.

```text
Read C:\dev\chrome-history\ideas\003-open-into-the-right-profile.md in full
before doing anything. It is a self-contained implementation plan: follow the
executor instructions at the top, run the drift check first, execute the steps
in order verifying each before moving on, and stop at any STOP condition. Scope:
make POST /api/open launch a URL in a specific Chromium-family browser profile
(derived from the visit's source label like "chrome:Profile 2") instead of always
handing it to the OS default browser, falling back to current behavior whenever
the profile cannot be resolved. Every Bun.spawn call must keep passing an
argument array, never a shell string. Work on a branch; when done, report against
the Done criteria checklist.
```
