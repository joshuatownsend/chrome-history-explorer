# 010 — Act on the tabs that are open right now

> Brief for a design spike. Investigate and prototype; do not ship.
> Drift check: `git diff --stat a33971d..HEAD -- src/server/routes/open.ts src/server/routes/sessions.ts src/server/schema.sql src/web/components/SessionsView.tsx` — if these changed materially, re-validate the evidence before spiking.

- **Status**: SELECTED
- **Verdict**: Validate
- **Score**: 8/10 (see `ideas/README.md` for portfolio context)
- **Lenses**: inside-out (Signal 3 — surface asymmetries) / outside-in (`interview`)
- **Effort (coarse)**: L
- **Planned at**: `a33971d` on 2026-08-12

## The idea

Give the app a two-way relationship with the browser it currently only talks *at*. Today it can launch a URL and then loses all contact with it. The capability being investigated is the other direction: enumerate the tabs that are open right now, across all open windows and Chrome profiles, and act on them — close a set, group them, move them between windows, or file them into the history store and a ThreadCrumb inbox before closing.

Using it would look like a new view listing live windows and their tabs beside the historical data the app already holds, so a tab open for three weeks can be shown next to the fact that you visited it 40 times last year, or never returned to it after the day you opened it. The actions are bulk ones: "close every tab in this window I haven't touched in 30 days", "group these by domain", "send these twelve to ThreadCrumb and close them".

**This brief deliberately does not choose an implementation.** Choosing between a browser extension and the Chrome DevTools Protocol is the point of the spike.

## Who wants this and why now

**Persona P1 — the multi-profile tab hoarder** (the maintainer; the only confirmed user this project has).

The maintainer's own answer, verbatim, when asked what workflows he runs around the app that it does not support:

> "closing tabs, grouping tabs, or otherwise taking some action on the way-too-many-tabs that I have open at any given time. Also moving tabs across windows (different chrome sessions with different logins for personal, work, clients, etc.)"

Source type: `interview`, 2026-08-12.

The repository corroborates the scale independently. `INSIGHTS.md:136`:

> "**One window holding 521 of 527 tabs** tells you these aren't 4 tidy sessions — it's one giant always-open window plus a few strays. The hard cap turns a catastrophic 'reopen 521 tabs' misclick into a no-op with a clear message."

That note was written about protecting the user from *reopening* 521 tabs. The same number read the other way is the problem statement for this brief: there are 521 tabs open, and the app has no verb for any of them.

Frequency: daily. This is not an occasional maintenance chore — it is the persona's standing condition.

## Why this project, why cheap

Two qualifications, and one large disqualification.

**The app already owns the hard half.** A year of visit history, per-URL visit counts, liveness verdicts, topic clusters, and research-session groupings all exist. A tab-manager extension can tell you a tab is open; only this app can tell you that you opened it in March, visited it 40 times, and haven't touched it since — or that it now 404s. That join is the entire product argument, and no comparator in the research has both halves.

**The data model already has the shape.** `src/server/schema.sql:74-85` models a tab as a first-class entity:

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

`pinned`, `last_active_ms`, `browser_type` and a tab identifier are all already there. What is missing is not the schema but the *liveness of the data*: these rows come only from a Google Takeout export, which is a manual, periodic snapshot. Every tab the app knows about is a fossil.

**The disqualification: the app has no channel to a running browser.** `src/server/routes/open.ts:23-32` is the entire outbound surface:

```ts
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

`Bun.spawn` with `stdout: "ignore"` is fire-and-forget. Nothing is returned, no handle is retained, and no callback exists. This is a one-directional pipe by construction — and `src/web/components/SessionsView.tsx:31` is its only caller anywhere in the frontend.

So: the *value* is cheap because the history join already exists. The *mechanism* is not cheap at all, and that is what the spike must price.

## Trade-offs and risks

**This changes what the product is.** Everything in the app today is read-only archaeology over data the user already produced. Acting on live browser state makes it a control surface for a running application — a different security posture, a different failure mode, and a different support burden. A bug in the history view shows wrong numbers; a bug here closes tabs someone wanted.

**Both candidate mechanisms carry a real install cost.**

- *Chrome DevTools Protocol* requires Chrome to have been launched with `--remote-debugging-port`. Chrome does not enable this by default, and enabling it means the user restarts every browser window they currently have open — which for this persona means the 521-tab window. It also opens a local debugging port that any process on the machine can drive, which is a meaningfully wider trust boundary than the current loopback-only, no-auth posture described in `SECURITY.md`.
- *A browser extension* is a second artifact with its own manifest, its own build, its own update path, and — if distributed — a store review process. It also has to talk back to the local server, which means a documented local API contract where currently `src/web/api.ts` is the only consumer.

**Multi-profile is the hard case, not the easy one.** The persona's need is explicitly cross-profile ("different chrome sessions with different logins"). CDP attaches to a browser instance, so several profiles means several debug ports and several connections. An extension is installed per-profile, so several profiles means several installations each reporting separately. Neither mechanism makes cross-profile a natural single view — this is the requirement most likely to break a design that looked fine for one profile.

**It competes with real work.** At L effort this displaces several of the S-effort items in the same portfolio — ideas 3, 7, 9 and 11 together are probably less total work and all ship value immediately.

**The honest failure mode:** the spike concludes that the install cost is too high for a tool whose current pitch is "run one command and look at your history", and the right answer is idea 3 (open into the correct profile) plus a documented manual workflow. That is a legitimate outcome and the brief exists to make it cheap to reach.

## Open questions

1. **Can CDP enumerate and control tabs across multiple Chrome profiles simultaneously**, and what exactly must the user do to their existing browser session to make that possible? Specifically: is there any path that does not require closing the 521-tab window?
2. **What does an extension cost end-to-end** — manifest, build integration with the existing Vite setup, the local-server channel, and installation for a user who is not the maintainer? Does it need store distribution, or is unpacked/developer-mode acceptable for a self-hosted tool?
3. **Is the cross-profile view achievable in either mechanism**, or does the design have to accept per-profile silos? If silos, is the feature still worth building?
4. **What is the minimum useful verb set?** Is "close a filtered set" alone worth the mechanism, or does the value only appear with group and move as well?
5. **What is the safety design for destructive actions?** The existing code already answers this question once, for the opposite direction: `open.ts:5` caps bulk opens at `MAX_BULK = 50`. What is the equivalent guard for closing, and is an undo (reopen-what-I-just-closed) feasible?
6. **Does the history join actually earn its keep in practice?** Prototype the "tabs I have open that I never returned to" query against real data and check that the result is genuinely useful rather than merely computable.
7. **What is the security posture change**, stated in the same terms as `SECURITY.md`? A debug port or an extension channel both widen the trust boundary that document currently describes as "network isolation".

## Spike plan

Target: one day. Prototype work stays on a branch; nothing merges from this spike.

1. **Read the existing outbound path end to end** — `src/server/routes/open.ts` (52 lines) and its single caller `src/web/components/SessionsView.tsx:31`, plus the `session_tabs` / `tab_navigations` tables in `src/server/schema.sql:74-98`.
   *You'll know when:* you can state precisely which fields a live tab would supply that the Takeout snapshot already models, and which would be new.

2. **Test CDP against a live Chrome without disturbing the main window.** Launch a *second* Chrome instance with `--remote-debugging-port=9222` and a separate `--user-data-dir`, then `curl http://127.0.0.1:9222/json/list`.
   *You'll know when:* you have a JSON list of real open tabs printed to the terminal, and you know whether the already-running default-profile Chrome appears in it or not. **That second point is the crux of question 1** — if a running browser cannot be attached to retroactively, the install cost is "restart everything" and that should be recorded plainly.

3. **Test the destructive verb.** Against that throwaway instance, close a tab via CDP (`Target.closeTarget`) and try to create/move one.
   *You'll know when:* a tab visibly disappears from the second Chrome window, and you know whether "move to another window" is a single call or a close-plus-reopen (which loses scroll position and form state — a materially worse user experience worth recording).

4. **Price the extension path on paper, not in code.** Write a one-page sketch: manifest version, permissions required (`tabs`, `tabGroups`), how it reaches `127.0.0.1:8787` given the existing CSRF/rebinding guard in `src/server/lib/security.ts`, and how it would be installed.
   *You'll know when:* you can name the specific permission strings and state whether the existing security middleware would accept or reject a request originating from an extension.

5. **Prototype the value query, not the mechanism.** Using the existing `session_tabs` data as a stand-in for live tabs, write the SQL for "tabs open now that I have not revisited in N days" by joining against `urls.last_visited` and `visit_count`.
   *You'll know when:* you have run it against the real database and looked at the actual rows. If the output is obviously useful, the mechanism is worth paying for; if it is noise, stop here.

6. **Draft the security delta.** Two paragraphs in the shape of `SECURITY.md`'s existing "Known, accepted behaviors" section, describing what changes for each mechanism.
   *You'll know when:* you can state the new trust boundary in one sentence per mechanism.

7. **Write the recommendation** — mechanism, verb set, cross-profile answer, and a coarse effort estimate for the build.

## Decision criteria

**Build it** — if step 2 shows tabs can be enumerated without forcing the user to restart their existing browser session, *and* step 5's query produces obviously useful rows, *and* the cross-profile answer is a single view rather than silos. Follow with a full handoff plan for the chosen mechanism, starting with read-only enumeration and adding destructive verbs only after that ships.

**Reshape it** — if enumeration works but only per-profile, or only for browsers launched by the app. The reshaped version is narrower and still valuable: a "tab triage" mode the user opts into for one profile at a time, with the history join as the differentiator. Re-scope and re-plan rather than proceeding.

**Drop it** — if every path requires restarting the browser session, *or* the extension proves to need store distribution to be usable by anyone but the maintainer, *or* step 5 shows the history join adds nothing a plain tab manager could not do. In that case idea 3 (open into the right Chrome profile) captures most of the achievable value for hours instead of days, and this idea moves to the parked ledger with the spike's findings attached so it is never re-litigated from scratch.

## Kickoff prompt

> Copy-paste to start this spike in any session or agent.

```text
Read C:\dev\chrome-history\ideas\010-act-on-open-tabs.md in full before doing
anything. It is a design-spike brief: run the spike steps in order, answer the
open questions, and report against its decision criteria. Scope: determine
whether this app can enumerate and act on currently-open Chrome tabs across
multiple profiles, and at what install and security cost — comparing the Chrome
DevTools Protocol against a browser extension. Do not build beyond the spike;
prototype work happens on a branch and nothing merges. The deliverable is a
recommendation, not an implementation.
```
