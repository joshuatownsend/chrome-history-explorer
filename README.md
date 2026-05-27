# Chrome History Explorer

A **local-first** web app for exploring your browser history — from a Google Takeout export
**or directly from local browser profiles** (Chrome, Edge, Brave, Vivaldi, Opera, Firefox,
and Safari). Browse, sort, filter, and full-text search tens of thousands of visits; group
by parent domain; reopen saved tab sessions; check which links are still alive (vs
dead/blocked); and — optionally — summarize pages and search semantically with AI.

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
- **Liveness checking** — lazy as you scroll, plus scoped batches ("top 500", "last 30
  days", "this domain"). Classifies `live` / `dead` / `blocked` / `rate-limited` /
  `error`, with a Wayback Machine fallback for dead links.
- **AI (optional, pluggable)** — on-demand page summaries and semantic search via
  embeddings. Works with Anthropic (Claude) and/or OpenAI.
- **Insights dashboard** — totals, browsing by hour/day-of-week, top domains,
  most-revisited pages, liveness rollup, and per-device labeling.
- **Privacy & ignore rules** — define your own host patterns to treat as private
  (skipped from liveness/AI) or hide from the app entirely.

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

### Optional environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `API_PORT` | `8787` | Backend port (Vite dev proxy targets this too). |
| `HISTORY_DB` | `data/history.db` | SQLite database path. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Chat model for summaries. |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` | Embedding model for semantic search. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Claude model for summaries. |

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
      …                 domain/privacy, user rules, job queue, liveness, page extraction
    ai/                 pluggable provider abstraction (anthropic, openai)
    routes/             urls, domains, devices, search, sessions, open, enrich,
                        stats, ai, tree, settings, import (+ sources)
  web/
    App.tsx             view shell (Dashboard / Search / By domain / All URLs / Sessions / Import / Settings)
    api.ts              typed fetch client
    components/         table, domain/tree views, sessions, dashboard, import, settings, filters, badges
test/
  adapters.test.ts      fixture-based epoch/transition tests per browser adapter (bun test)
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
bun test    # fixture-based adapter epoch/transition tests
```
