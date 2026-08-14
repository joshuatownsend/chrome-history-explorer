# Ideation run report — chrome-history-explorer

- **Date:** 2026-08-12
- **Mode:** `/ideate deep`
- **Repo:** `C:\dev\chrome-history` (`joshuatownsend/chrome-history-explorer`)
- **Stamped SHA:** `a33971d` (branch `main`)
- **Candidates generated:** 27 · **Survivors:** 12 · **Killed:** 4 · **Parked:** 11

---

## 1. Evidence sources — delivery accounting

| Source | Status | Notes |
|---|---|---|
| Inside-out: Signals 1–3 (unfinished intent, stated-but-undelivered, surface asymmetries) | **delivered** | Explore subagent, 8 findings + 6 lead verdicts. Load-bearing claims re-verified by hand. |
| Inside-out: Signals 4–5 (adjacent possible, friction worth productizing) | **delivered** | Explore subagent, 8 findings + 6 lead verdicts. All 8 re-verified by hand. |
| Outside-in: live research (`live-research`) | **delivered** | 9 themes, comparator projects Promnesia / Falcon / Memex + HN. Reaction counts re-verified via GitHub API. |
| Outside-in: maintainer interview (`interview`) | **delivered** | 2 of 3 questions answered substantively; Q2 answered "nothing comes to mind". |
| Outside-in: session-transcript mining (`transcript`) | **FAILED** | See disclosures. Substituted with `repo-internal` evidence. |
| This repo's issue tracker (`repo-internal`) | **delivered — empty** | 0 issues, 0 discussions, 0 forks, 2 stars, 4 views / 14 days. A confirmed null result. |

### Independently re-verified claims

Subagent line numbers are leads, not facts. These were re-read or re-queried directly:

- `lib/rules.ts:92-93` — `isPriv` / `isHid` computed independently. **Confirmed.**
- `routes/enrich.ts` — all three batch scopes filter `is_private=0` only, no `is_hidden`. **Confirmed.**
- `lib/jobs.ts:enqueueUrlIds` — selects `u.is_private` only; skips only on private. **Confirmed.**
- `lib/jobs.ts` — `kind='liveness'` hardcoded at lines 26, 55, 59, 88, 155, 164. **Confirmed.**
- `index.ts:79` — `idleTimeout: 60`. **Confirmed.**
- `routes/ai.ts` — `scope:'all'` loads every public URL, awaits `provider.embed()` in 100-row chunks in one request, writes `status='done'` directly. **Confirmed.**
- `final_url` — 3 occurrences, all inside `lib/liveness.ts`. Never surfaced. **Confirmed.**
- `referrer`, `tab_node_id` — written in `load.ts`, never SELECTed. **Confirmed.**
- `http_status` — typed at `web/api.ts:54`, rendered by no component. **Confirmed.**
- `api.urlVisits()` / `api.aiSummariesFor()` — **zero callers** outside `api.ts`. **Confirmed.**
- `api.openUrls()` — one caller, `SessionsView.tsx:31`. **Confirmed.**
- Export affordances — grep for `createObjectURL|Content-Disposition|text/csv|download=` across `src/` returns **nothing**. **Confirmed.**
- Falcon #29 "Feature Request! Bookmarks" — 8 reactions, 5 comments, open. Repo 1,832★, last push 2024-08-09. **Confirmed via GitHub API.**
- Promnesia #55 "Backend in docker container?" — 6 reactions, 9 comments. Repo 1,891★, last push 2026-08-07, 71 open. **Confirmed via GitHub API.**
- Memex #1229 "License?" — 5 reactions, 7 comments. **Confirmed via GitHub API.**
- HN 30696451 (Ask HN, full-text browser history) — author `emptysongglass`; karlicoss reply confirmed verbatim via Algolia API. **Confirmed.**

---

## 2. Personas

### P1 — Josh, the multi-profile tab hoarder *(primary; HIGH confidence)*

**Today.** He runs several Chrome profiles at once — personal, work, and one per client, each with different logins — and at any moment has far more tabs open than he can reason about. The scale is on record: `INSIGHTS.md:136` notes one saved window holding **521 of 527 tabs**. The explorer lets him look *backwards* at all of it beautifully, and gives him exactly one action to take on it: open a URL. He can create tabs; he cannot close, group, or move one.

**Weekly ritual.** Re-imports periodically, because the two archives are complementary — local Chrome expires at ~90 days while his Takeout export holds a full year (`INSIGHTS.md:74`). Browses Research Sessions and Insights. Forwards links he means to return to into ThreadCrumb, his own intent inbox.

**Frustration.** Verbatim (interview Q1): *"closing tabs, grouping tabs, or otherwise taking some action on the way-too-many-tabs that I have open at any given time. Also moving tabs across windows (different chrome sessions with different logins for personal, work, clients, etc.)"* — and when he does reopen something, `routes/open.ts:23-32` hands it to the **OS default browser**, so a client tab lands in whatever profile happens to be default.

*Evidence: `interview` (Q1, Q3), `repo-internal` (`INSIGHTS.md:68,74,136`; `routes/open.ts`; `schema.sql:65-98`).*

### P2 — The "I know I read this" searcher *(MED confidence; problem-space persona)*

**Today.** Types a half-remembered phrase into the browser's history box and gets what one HN commenter called *"the same barely searchable table of URLs as their only history view"* (andrew_eu, HN 45295647). The phrase they remember is from the **body** of the page, not its title — so title-and-URL search cannot find it. They fall back to Google, or hand-roll: one HN user built a local logging proxy in Twisted, later ported to Go, feeding a Django app (thraxil, HN 30697416); another pastes raw `moz_places` SQL from their dotfiles (barbuk, HN 30699317).

**Weekly ritual.** Several times a week, tries to re-find something seen weeks to years ago. Their browser has already forgotten it.

**Frustration.** From the 235-point Ask HN thread that anchors this persona: *"My biggest force-multiplier is my fish shell history, going on 7 years... I want to do the same thing for my web browser... Is there any product out there that creates a fully searchable full-text history forever with little fuss?"* (emptysongglass, HN 30696451). They rejected the leading alternative specifically because it required saving first: *"My brain, naturally, does not know ahead of time what could be useful in the future."*

*Evidence: `live-research` (HN 30696451 — 235 pts / 83 comments; HN 45295647; HN 30697416; HN 30699317; Falcon's existence).*
*Caveat: drawn from users of comparable tools, not confirmed users of this project.*

### P3 — The local-first refugee *(MED confidence; problem-space persona)*

**Today.** Has been burned. Memex removed its LICENSE file and confirmed it was *"no longer intended to be open-source"* (#1229, 5 reactions) — and a user in that thread said FOSS *"was the main reason I chose to use Memex."* Falcon, still the tool people recommend to each other, hasn't been pushed since August 2024. Histre drew a two-word review: *"Subscription fatigue."*

**Weekly ritual.** Evaluates a tool roughly monthly and abandons most of them. The first question asked, every time, before any feature discussion: *"How and where is the full text of every page I visit getting stored & for how long?"* (pogue, HN 43930899).

**Frustration.** There is no durable winner, and no way to audit what a tool actually sends outward. This project is MIT, loopback-only, and never phones home by default — but it *does* have three optional egress paths (AI summaries, embeddings, liveness checks), and today there is no visible record of which hosts were sent where.

*Evidence: `live-research` (Memex #1229; HN 43931075; HN 43930899; HN 30709595), `repo-internal` (`routes/enrich.ts`, `routes/ai.ts`, `routes/threadcrumb.ts`).*

**Degrade level: 1–2.** Live research + interview + repo-internal, no transcripts. P1 is fully grounded; P2 and P3 are grounded in real quotes from users of *comparable* tools rather than of this project — which currently has none.

---

## 3. Portfolio

Sorted by dual-lens bonus, then score.

| # | Idea | Verdict | Score | Lenses | Persona | Evidence | Effort | Build |
|---|------|---------|-------|--------|---------|----------|--------|-------|
| 1 | Keep the page text you already fetch, and search it | Advance | 10/10 | both | P2 | HN 30696451 (235 pts): *"fully searchable full-text history forever"*; `extract.ts` already extracts text, `ai.ts:43-60` discards it | M | natural-fit |
| 2 | Put liveness and transition into the ThreadCrumb capture | Advance | 10/10 | both | P1 | Interview Q3: *"Better integration with ThreadCrumb"*; `INSIGHTS.md:68` names `buildCaptureContext` "the one real design lever" | S | natural-fit |
| 3 | Open tabs into the right Chrome profile | Advance | 9/10 | both | P1 | Interview Q1: *"different chrome sessions with different logins for personal, work, clients"*; `open.ts:23-32` uses the OS default browser | S | natural-fit |
| 4 | Show what left the machine — an egress audit log | Advance | 9/10 | both | P3 | HN 43930899: *"How and where is the full text... stored & for how long?"*; `enrichments` already records every outbound call | M | natural-fit |
| 5 | Import bookmarks as a first-class source | Advance | 9/10 | both | P2 | Falcon #29, **8 reactions** (verified) — highest-reacted request on the closest comparator; `firefox.ts:24-26` reads only visits from a DB holding `moz_bookmarks` | M | natural-fit |
| 6 | Render saved windows as the navigation tree they were | Advance | 9/10 | both | P1 | HN 33722664: *"showing trails as tree instead of tabs"*; `tab_navigations.referrer` + `tab_node_id` written at `load.ts:71,67`, never read | M | natural-fit |
| 7 | Close the hidden-host liveness gap | Advance | 8/10 | both | P3 | `README.md:222` promises hidden hosts are never sent to liveness; `enrich.ts` + `jobs.ts` gate on `is_private` only | S | natural-fit |
| 8 | Let every view export what's on screen | Advance | 8/10 | both | P2 | Promnesia #243/#192 (PKM export requests); zero export affordances anywhere in `src/` (verified by grep) | M | natural-fit |
| 9 | Make Takeout importable from the Import tab | Advance | 8/10 | both | P2 | Promnesia #55 "Backend in docker?" is its top issue (6 reactions) — setup friction decides adoption here; `ImportView.tsx` has no path input | S | natural-fit |
| 10 | Act on the tabs that are open right now | **Validate** | 8/10 | both | P1 | Interview Q1 (verbatim, above); `open.ts` can create tabs and nothing else | L | new-ground |
| 11 | Finish the three half-wired features | Advance | 7/10 | inside-out | P1 | `api.urlVisits()` and `api.aiSummariesFor()` have zero callers; `journeys.ts:8-9` maintainer comment on import invalidation | S | natural-fit |
| 12 | Generalize the enrichment queue past liveness | Advance | 6/10 | inside-out | P1 | `jobs.ts` hardcodes `kind='liveness'` 6×; `ai.ts` embeds ~30k URLs synchronously against `idleTimeout: 60` | M | natural-fit |

### Verdict/band disagreements (recorded per the rubric)

- **#10 scores 8/10 (Advance band) but lands at Validate.** The demand is the strongest single piece of evidence in the run, but the implementation path is genuinely unresolved: a browser extension, or CDP against `--remote-debugging-port`, are different products with different install stories. A plan here would front-run the decision.
- **#11 (7/10) and #12 (6/10) score in the Validate band but land at Advance.** Neither has anything to validate — both are completion/refactor work over code that already exists, with no open question. Recorded rather than silently promoted.

---

## 4. Kill-question answers — survivors

Abbreviated to the load-bearing answers; Q1 (persona/frequency), Q3 (unique leverage), Q5 (duplication), Q6 (smallest version), Q8 (opportunity cost).

**#1 Keep the page text.** Q1: P2, several times a week, whenever re-finding something. Q3: the leverage is structural — every extension-based competitor is bounded by `storage.local`/IndexedDB quotas (phil294, HN 30698994; Falcon's maintainer on the storage ceiling); a server-side SQLite file has no such ceiling. Q5: extends FTS5 and the Interest Map rather than duplicating — embeddings today are built from `title + url` truncated to 800 chars (`ai.ts:133`), so two pages titled "Docs" cluster nowhere near their real topic. Q6: persist `enrichments(kind='text')` when summarizing, embed text instead of titles, add a fifth FTS column. Q8: displaces #8 export; justified because it is the single largest quality lever on the app's most differentiated feature. **Depends on #12** for a durable backfill.

**#2 ThreadCrumb capture.** Q1: P1, every time he forwards a link. Q3: cross-source join — the Graveyard already computes a liveness verdict no inbox could derive on its own. Q5: extends the existing button. Q6: one join in the `threadcrumb.ts:52` query plus two fields in `buildCaptureContext`. Q8: near-zero cost. Open question carried into the brief: "better integration" was under-specified in the interview, so the brief should name what else the seam could carry.

**#3 Profile-aware open.** Q1: P1, every reopen. Q3: the app already detects profile directories for import (`detect.ts`) — nothing else knows his profile layout. Q5: fixes an existing feature that is actively wrong for a multi-profile user. Q6: invoke `chrome.exe --profile-directory=...` instead of the OS handler, with the current handler as fallback. Q8: hours.

**#4 Egress audit log.** Q1: P3 on first evaluation, P1 whenever a rule changes. Q3: `enrichments` already holds a row per outbound call with timestamps — the record exists, it has just never been shown. Q5: complements privacy rules (which state intent) by showing outcome. Q6: a Settings panel listing hosts contacted, by path and date. Q8: displaces #5.

**#5 Bookmarks.** Q1: P2, whenever hunting something they saved rather than browsed. Q3: bookmarks × the existing Graveyard = "this bookmark is dead", which hickford asked for on Falcon #29 verbatim. Q5: new entity, not a second path to an existing one. Q6: Firefox first (`moz_bookmarks` is in the DB already opened); Chromium's is a separate JSON file. Q8: displaces #6. **Effort is uneven across browser families — verify before committing.**

**#6 Navigation tree.** Q1: P1, when reviewing a saved window before reopening it. Q3: `referrer` is the actual parent edge; Research Sessions today infer structure from time-adjacency plus a `transition='link'` count. Q5: extends Sessions. Q6: join on referrer→virtual_url within a session; show `http_status >= 400` inline. Q8: **limited to Takeout data** — local sources expose no sessions, so this never lights up for a local-only importer.

**#7 Hidden-host gap.** Q1: P3, continuously and invisibly. Q3: none needed — it is a promise the docs already make. Q5: closes a gap in an existing guarantee. Q6: one predicate in three `enrich.ts` scopes plus `enqueueUrlIds`. Q8: hours. **Note:** README and SECURITY.md disagree with each other; the alternative resolution is to narrow `README.md:222`. That is a maintainer decision, not a bug fix.

**#8 Export.** Q1: P2, whenever moving a finding into notes. Q3: the exported artifacts (AI session names, topic labels, liveness verdicts) exist nowhere else. Q5: fills a one-way door — four import paths, zero export. Q6: one CSV/JSON endpoint per list view honoring the read-time privacy filter. Q8: displaces #9.

**#9 Takeout from the UI.** Q1: every new user, once — but it is the first five minutes. Q3: none; it is friction removal. Q5: extends `POST /api/import/run`, which already accepts profile labels. Q6: add `{ takeoutPath }`, auto-detect `./History.json`. Q8: hours. Justification is timing — the repo just went public and Takeout is the *headline* source yet the only one requiring a terminal.

**#10 Live tabs.** Q1: P1, daily. Q3: joins live tab state to a year of history — nobody has both halves. Q5: extends the single `/api/open` verb into a two-way surface. Q6: **this is the open question** — CDP requires Chrome relaunched with a debug port; an extension is a separate artifact with its own install and review story. Q7: beats #3, which only fixes the outbound direction. Q8: displaces multiple smaller wins; that is why it is Validate, not Advance.

**#11 Half-wired features.** Q1: P1, per session. Q3: none; it is completion of built work. Q5: three separate half-features — visit timeline, summary read-back, stale-view banner. Q6: wire existing endpoints to existing components. Q8: hours. Note: summary read-back has direct cost impact — today a summary generated yesterday is invisible and re-clicking bills the provider again.

**#12 Generalize the queue.** Q1: P1, whenever embedding a full history. Q3: crash-recoverable job machinery already exists, artificially narrowed to one `kind`. Q5: replaces the hand-rolled synchronous loop in `ai.ts`. Q6: parameterize `kind` through `resetStuckJobs`/`claimOne`/`enqueueUrlIds`. Q8: displaces user-facing work — justified because it unblocks #1 and removes a real timeout/data-loss risk today.

---

## 5. Killed ledger

| Idea | Reason | Closest surviving sibling |
|---|---|---|
| Publish an OpenAPI spec / version the HTTP API | 39 handlers, but the only consumer is the app's own hand-maintained `web/api.ts`, and there are zero external users to serve. Category-generic. | #8 |
| Import downloads as an entity | No demand evidence anywhere in the research, unlike bookmarks which have a verified 8-reaction request. | #5 |
| Harden `ingest` CLI flag parsing (`--source` unvalidated, `--label` silently ignored) | Real defects (`ingest.ts:96`, `sources/index.ts:15`), but bug-list items, not product options. | #9 |
| Add tagging / annotation | Competes head-on with the capture-everything thesis. The 235-pt OP rejected the leading annotation tool for exactly this, and Promnesia's maintainer explicitly refuses annotations as out of scope. | #1 |

## 6. Parked ledger

| Idea | Reason | Closest surviving sibling |
|---|---|---|
| Multi-machine consolidation | Strong demand (3 comparators + HN), but largely **already works** — `--source chrome --path` into the same DB dedupes by `(url_id, time_ms)`. The gap is documentation and discovery, not capability. | #9 |
| Backup / restore | The database is a single SQLite file the user already owns. ankostis's actual ask on Promnesia #339 was *documentation* of the no-data-loss story. | #8 |
| One-click "Refresh everything" | Depends on #12; revisit once the queue is generalized. | #12 |
| `transition` as a filter facet | Cheap and thesis-aligned (typed/bookmark = deliberate vs. link = drift), but zero demand evidence. | #1 |
| "Moved on" — surface `final_url` | Free insight from data every past liveness run already stored, but nobody asked for it. | #5 |
| Non-browser sources (Pocket / Raindrop / Zotero) via `HistorySource` | Inferred from the interface shape, not from users. | #5 |
| Safari hardening (TCC `EPERM` silently lists an unimportable profile) | Real defect at `detect.ts:98`, but no Safari user exists to be hurt by it yet. | #11 |
| Packaged / Docker install | Top request on Promnesia (#55, 6 reactions) — but that project's stack is Python indexer + extension + config file. `bun install` is already far lighter, so the pain doesn't transfer. | — |
| On-page context injection (Promnesia-style sidebar) | Large new ground; rides on whatever #10's spike concludes about extensions. | #10 |
| Manual rename for Research Sessions and clusters | Naming is AI-or-heuristic only today; a badly-named topic can only be fixed by rebuilding the whole map. No demand evidence. | #11 |
| Liveness controls and filters on the views that display but can't populate them | `LivenessBadge` renders in six views; `useLazyLiveness` is wired in two. Consistency, not demand. | #11 |

---

## 7. Disclosures

1. **Session-transcript mining failed.** The only `.jsonl` for this repo is *this run's own transcript* (created 2026-08-12 16:25). The sessions that built the app — IDs `2acac87a-…` and `144599ce-…`, both referenced in `INSIGHTS.md` — have been rotated off disk. Mining the surviving file would have matched the ideate skill's own reference text loaded minutes earlier, producing self-referential pollution rather than usage evidence. No reduced-breadth inline fallback was possible because the source material no longer exists. Substituted: `INSIGHTS.md` (25 distilled insights carrying those same session IDs) and `.remember/*.md`, tagged `repo-internal`. Disclosed in-turn at the moment of failure, not retroactively.

2. **Reddit is unmined ground, not an absence of evidence.** The research agent hit HTTP 403 from `old.reddit.com` search and four targeted web searches returned no Reddit thread content. r/selfhosted, r/DataHoarder and r/PKMS remain uncovered — worth a manual pass.

3. **P2 and P3 are problem-space personas.** They are grounded in verbatim quotes from real people, but those people are users of *comparable* tools (Promnesia, Falcon, Memex) and HN commenters on the problem — not confirmed users of this project, which has none. P1 is the only persona grounded in direct evidence about this software.

4. **This project's own tracker contributed nothing** — 0 issues, 0 discussions, 2 stars, 4 views / 14 days. Notably, this is *normal* for the niche rather than a verdict: Promnesia, the healthiest comparator at 1,891★, has a top-reacted open issue of only 6 reactions.

5. **No prompt-injection content was encountered** by any lens, in the repo or on the web. No secrets were surfaced.

6. **One conflict between the project's own documents** was found and is presented as a decision, not a defect: `README.md:222` says hidden hosts are never sent to liveness; `SECURITY.md:21-23` says only that hidden hosts are excluded from every *view*. The code matches SECURITY.md. Idea #7 can resolve it in either direction.

---

## 8. Market context (from live research)

The space is simultaneously **crowded and abandoned**, which is the finding rather than a caveat:

- Chrome shipped native full-text history search and later removed it; the engineer who wrote it says SQLite FTS was contributed upstream specifically for that feature (evmar, HN 17745931).
- Falcon: 1,832★, no push since 2024-08-09, top requests still open — and still the tool people recommend to each other in 2025.
- Memex: 4,712★, removed its LICENSE, confirmed no longer open-source.
- Yet new entrants keep arriving: browserparrot (2021), Pinbot (2023), Zenfetch (YC W23), rearview (2025), full-text-tabs-forever, TraceMind (2026).

Demand recurs for a decade; supply keeps dying, and every incumbent is either abandoned, closed-source, or storage-constrained by living inside a browser extension. **The position nobody currently holds: outside the browser, local-only, MIT, capture-everything, page content included.** That is the strategic frame behind idea #1.
