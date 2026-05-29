# Chrome History Explorer

A **local-first** web app for exploring your browser history — from a Google Takeout export
**or directly from local browser profiles** (Chrome, Edge, Brave, Vivaldi, Opera, Firefox,
and Safari). Browse, sort, filter, and full-text search tens of thousands of visits; group
by parent domain; reopen saved tab sessions; check which links are still alive (vs
dead/blocked); reconstruct the research sessions and rabbit holes you fell into; surface
memories, routines, and trends; map your interests into topics; and — optionally —
summarize pages, search semantically, and name it all with AI.

Multiple sources merge into one database and dedupe by URL + time, so you can combine a
Takeout export with several local browsers without double-counting.

Your data stays on your machine. Private/LAN hosts (`localhost`, `192.168.x`, `*.local`, …)
are **never** sent to liveness checks or AI providers — and you can add your own hosts to
treat as private or hide entirely (see [Privacy & ignore rules](#privacy--ignore-rules)).

## Features

- **Multi-source import** — Google Takeout JSON plus local browser databases (all
  Chromium-family browsers, Firefox, and Safari), auto-detected per profile. Filter and
  attribute visits by source; real page-transition types are captured from local browsers.
- **Browse / sort / filter** a virtualized table of every unique URL, with visit counts,
  last-visit times, and per-device badges.
- **Group by domain** (true eTLD+1, so `mail.google.com` rolls up under `google.com`),
  with an optional **tree view** that nests pages under their URL-path hierarchy
  (`github.com → /user → /repo → /pulls`), aggregating visit counts up the tree.
- **Full-text search** over titles and URLs (SQLite FTS5) with match highlighting and
  date/device/domain facets.
- **Sessions** — your saved tab windows with their navigation history; reopen a single
  tab or a whole window in your default browser (validated, capped at 50).
- **Research Sessions** — reconstructs your "rabbit holes" by detecting bursts of browsing
  with no long pause (per device), showing each ordered page trail and how deep it went
  (link-transition hops). Name any session with one AI call, or by a heuristic if no key.
- **Insights** — *On This Day* (what you browsed on this date in past years), *Forgotten
  Gems* (heavily-visited pages you haven't returned to in months), *Your Rhythm* (night-owl
  vs work-hours, peak hour, deepest rabbit holes), *Your Routine* (sites you return to on a
  daily/weekly/monthly cadence), *Pick Back Up* (stalled research sessions → ThreadCrumb),
  and a dead-link *Graveyard* with archive links.
- **Interest Map** — clusters your history into named topics *by meaning* (k-means over
  embeddings, each cluster labeled by AI), with rising/declining **trend** indicators
  (last 90 days vs the prior 90) so you can see which interests are heating up.
- **Liveness checking** — lazy as you scroll, plus scoped batches ("top 500", "last 30
  days", "this domain"). Classifies `live` / `dead` / `blocked` / `rate-limited` /
  `error`, with a Wayback Machine fallback for dead links.
- **AI (optional, pluggable)** — on-demand page summaries, semantic search, research-session
  and topic naming, all via Anthropic (Claude) and/or OpenAI. Embeddings (OpenAI) power
  semantic search and the Interest Map.
- **Send to ThreadCrumb (optional)** — one-click forward a public history link to a
  [ThreadCrumb](https://threadcrumb.io) intent inbox; private/hidden URLs are refused.
- **Dashboard** — totals, browsing by hour/day-of-week, top domains, most-revisited pages,
  liveness rollup, per-device labeling, plus *On This Day* and *deepest rabbit hole* cards.
- **Privacy & ignore rules** — define your own host patterns to treat as private
  (skipped from liveness/AI) or hide from the app entirely. Private/hidden pages are
  filtered out of every derived view — sessions, insights, and clusters — at read time,
  so changing a rule never resurfaces suppressed history.

## Prerequisites

- [Bun](https://bun.com) ≥ 1.3 (the app uses Bun's built-in SQLite — no native build step).
- At least one history source: a Google Takeout export and/or a locally installed browser.

## Setup

```bash
bun install
bun run ingest    # builds data/history.db (gitignored) from ./History.json if present
```

`ingest` is idempotent — re-running, or loading another source, merges and dedupes by
URL + time rather than duplicating. `data/history.db` and any `*history*.json` exports are
gitignored, so your data is never committed.

## Importing history

You can load from a Takeout export, from local browser profiles, or both — they merge.

### Google Takeout

1. Go to [Google Takeout](https://takeout.google.com), deselect everything, select **Chrome**.
2. Export, download, and extract — you'll find `History.json`.
3. `bun run ingest` (looks for `./History.json`) or `bun run ingest /path/to/History.json`.

Takeout is the only source that also includes saved **tab sessions**.

### Local browsers (Chrome, Edge, Brave, Vivaldi, Opera, Firefox, Safari)

The app reads each browser's history database directly. It copies the file first, so it's
safe to leave the browser running, and it captures real page-transition types.

```bash
bun run ingest --list                    # detect installed profiles (with visit counts)
bun run ingest --profile chrome:Default  # import a detected profile by label
bun run ingest --source firefox --path "/path/to/places.sqlite"   # explicit path
```

Or use the **Import** tab in the app: it lists detected profiles with visit counts and
last-visit dates; tick the ones you want and click import.

> You typically have many profiles (work/personal/etc.) — selection is always explicit;
> nothing is imported automatically.

## Running

**Production-style (single server serves API + built UI):**

```bash
bun run build                # build the React app into dist/web
bun run server               # serves everything at http://localhost:8787
```

**Development (hot-reload):**

```bash
bun run dev                  # Vite UI on :5173 (proxying the API on :8787)
```

> **Loopback-only by default.** The server binds to `127.0.0.1`, so it's
> reachable only from the machine it runs on. This is deliberate — it's a
> no-login tool that can open browser tabs and read your full history. To reach
> it from another device (phone, another box on your LAN), set `API_HOST` **and**
> list the hostnames/IPs you'll use in `API_ALLOWED_HOSTS` (the rebinding/CSRF
> guard rejects anything else):
>
> ```bash
> API_HOST=0.0.0.0
> API_ALLOWED_HOSTS=192.168.1.50,history.lan
> ```
>
> Only do this on a trusted network, and ideally put it behind auth (a reverse
> proxy) or a VPN/SSH tunnel — see [Security](#security).

## AI configuration (optional)

Summaries and semantic search activate only when a provider key is present. Bun
auto-loads a `.env` file in the project root (also gitignored):

```bash
# .env
OPENAI_API_KEY=sk-...        # enables summaries + semantic search (embeddings)
ANTHROPIC_API_KEY=sk-ant-... # enables summaries (Claude has no native embeddings)
```

Without a key, every other feature still works; the AI controls simply stay disabled.

**Using AI:**
- **Summaries** are on-demand — click "✨ summarize" on any public URL in the Search view.
- **Semantic search** needs embeddings built first. From the app, build them for a scope
  (e.g. top URLs), then toggle "Semantic search" in the Search view. Embeddings persist
  in the database, so this is a one-time cost per URL.
- **Research Sessions** name themselves heuristically; click "✨ name this" on any session
  to get a concise AI title and one-line summary instead.
- **Interest Map** clusters your history by meaning. Click **Build map** to group the
  already-embedded pages into topics (each named by AI, or a top-domain heuristic without a
  key). For full-history coverage, click **Embed all pages** first to backfill embeddings
  across every public page, then **Rebuild map**. Only non-private, non-hidden pages are
  ever embedded, clustered, or sent to a provider.

### Optional environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `API_PORT` | `8787` | Backend port (Vite dev proxy targets this too). |
| `API_HOST` | `127.0.0.1` | Bind address. Loopback-only by default; set to a LAN IP / `0.0.0.0` to expose it (read [Security](#security) first). |
| `API_ALLOWED_HOSTS` | _(empty)_ | Comma-separated extra hostnames the rebinding/CSRF guard should trust when serving beyond loopback (e.g. `history.lan,192.168.1.50`). |
| `HISTORY_DB` | `data/history.db` | SQLite database path. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Chat model for summaries. |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` | Embedding model for semantic search. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Claude model for summaries. |
| `THREADCRUMB_TOKEN` | _(unset)_ | API token enabling the "send to ThreadCrumb" button. |
| `THREADCRUMB_BASE_URL` | `https://threadcrumb.io` | ThreadCrumb instance to send links to. |

## Send links to ThreadCrumb (optional)

If you use [ThreadCrumb](https://threadcrumb.io) — an "intent inbox" for links you
mean to come back to — each public history row gets a **🧵 ThreadCrumb** button (in
Search, the All-URLs table, Research Sessions, and the *Pick Back Up* insight) that
forwards the link to your inbox.

Setup:

1. In ThreadCrumb, create an API token (it's shown only once — copy the `tc_…` value).
2. Add it to `.env`:

   ```bash
   # .env
   THREADCRUMB_TOKEN=tc_...                  # enables the button
   THREADCRUMB_BASE_URL=https://threadcrumb.io   # or your self-hosted instance
   ```

The button stays hidden until a token is set. The token lives only on this server
(never the browser), so requests don't hit CORS and the key isn't exposed. Sending is
**gated**: only links that exist in your history are forwarded, and anything flagged
**private or hidden is refused** — the same posture as liveness and AI. Sends carry a
little context (visit count, first/last visit, which sources saw the URL); re-sending is
safe because ThreadCrumb dedupes by URL.

## Privacy & ignore rules

Beyond the built-in detection (`localhost`, RFC1918 LAN ranges, `*.local`), the **Settings**
view lets you define your own host patterns for two behaviors:

- **Treat as private** — still visible in the app, but never sent to liveness checks or AI
  providers, and marked with a 🔒.
- **Hide entirely** — excluded from all browsing views, search, the domain tree, and
  dashboard lists.

Pattern syntax (matched against the hostname, one per line):

- a bare domain like `example.com` also matches its subdomains;
- `*` is a wildcard, e.g. `*.corp.net` or `100.64.*`.

Saving recomputes the flags across every stored URL. Rules persist in the database and are
re-applied automatically after each `ingest`, so re-importing a fresh Takeout keeps them.
Nothing beyond `localhost`/LAN is hardcoded — all other privacy is configured here at runtime.

## Security

This is a **loopback-only, single-user** tool with no login — its security model
is network isolation. The server binds to `127.0.0.1` by default, and all `/api`
requests are checked against DNS-rebinding and CSRF (so a malicious website you
visit can't drive the local API). Provider/ThreadCrumb keys stay server-side;
private/hidden hosts are never sent to liveness, AI, or ThreadCrumb.

If you set `API_HOST` to expose it on a LAN, you widen the trust boundary —
add your hostnames to `API_ALLOWED_HOSTS` and front it with auth (or a VPN/SSH
tunnel). See [SECURITY.md](SECURITY.md) for the full threat model and how to
report a vulnerability.

## Tech stack

- **Backend:** Bun, [Hono](https://hono.dev), `bun:sqlite` (FTS5), [tldts](https://github.com/remusao/tldts) for eTLD+1.
- **Frontend:** React, Vite, Tailwind CSS, TanStack Table + Virtual.

## Project structure

```
src/
  server/
    index.ts            Hono app + Bun.serve (serves API and the built SPA)
    ingest.ts           CLI: detect/select a source, load via the loader
    schema.sql          tables, indexes, FTS5
    db.ts               connection + migration runner
    lib/
      load.ts           source-agnostic loader (NormalizedVisit -> rows) + finalize
      sources/          adapters: takeout, chromium, firefox, safari + detect + registry
      journeys.ts       visit-burst detection (Research Sessions)
      clusters.ts       k-means topic clustering (Interest Map)
      labels.ts         shared LLM label parsing (journeys + clusters)
      …                 domain/privacy, user rules, job queue, liveness, page extraction
    ai/                 pluggable provider abstraction (anthropic, openai)
    routes/             urls, domains, devices, search, sessions, open, enrich, stats,
                        ai, tree, journeys, insights, clusters, settings, import (+ sources)
  web/
    App.tsx             view shell (Dashboard / Search / By domain / All URLs /
                        Research Sessions / Insights / Interest Map / Sessions / Import / Settings)
    api.ts              typed fetch client
    components/         table, domain/tree views, sessions, journeys, insights, interest map,
                        dashboard, import, settings, filters, badges
test/
  adapters.test.ts      fixture-based epoch/transition tests per browser adapter (bun test)
  journeys.test.ts      visit-burst detection (gap/partition/min-pages/hops/privacy)
  clusters.test.ts      k-means clustering (assignment, empty-drop, privacy, bounding)
```

Adding a browser source is one file: implement `HistorySource` in `src/server/lib/sources/`,
add it to the registry and (optionally) profile detection.

## Notes & limitations

- **Takeout** exports don't preserve page-transition types and contain no bookmarks or
  downloads. Local-browser imports *do* capture real transition types.
- **Sessions** (saved tab windows) come only from Takeout; local sources don't expose them.
- **Safari** support is implemented and fixture-tested but unverified against a live profile
  (Safari only exists on macOS) — a macOS contributor's confirmation is welcome.
- The liveness HTTP-status classification lives in `src/server/lib/liveness.ts`
  (`classifyStatus`) — tweak the buckets there if you'd categorize differently.

## Tests

```bash
bun test    # adapter epoch/transition, journey detection, and clustering tests
```

## License

[MIT](LICENSE) © Josh Townsend
