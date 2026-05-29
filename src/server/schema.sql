-- Chrome History Explorer schema (bun:sqlite / SQLite 3.51+)
-- Events (visits) are split from entities (urls); see plan.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 4 synced devices, keyed by Chrome's client_id. Label is user-editable.
CREATE TABLE IF NOT EXISTS devices (
  client_id   TEXT PRIMARY KEY,
  label       TEXT,
  first_seen  INTEGER,            -- epoch ms
  last_seen   INTEGER,
  visit_count INTEGER NOT NULL DEFAULT 0
);

-- The URL entity (~30k rows). Aggregates live here, not on visits.
CREATE TABLE IF NOT EXISTS urls (
  id            INTEGER PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  hostname      TEXT,             -- full host, e.g. mail.google.com
  domain        TEXT,             -- eTLD+1, e.g. google.com
  title         TEXT,
  is_private    INTEGER NOT NULL DEFAULT 0,  -- 1 = localhost/LAN/IP/.local or user rule
  is_hidden     INTEGER NOT NULL DEFAULT 0,  -- 1 = user "ignore" rule; excluded from views
  visit_count   INTEGER NOT NULL DEFAULT 0,
  first_visited INTEGER,          -- epoch ms
  last_visited  INTEGER,
  device_count  INTEGER NOT NULL DEFAULT 0   -- distinct devices that hit this url
);

CREATE INDEX IF NOT EXISTS idx_urls_domain        ON urls(domain);
CREATE INDEX IF NOT EXISTS idx_urls_last_visited  ON urls(last_visited DESC);
CREATE INDEX IF NOT EXISTS idx_urls_visit_count   ON urls(visit_count DESC);
CREATE INDEX IF NOT EXISTS idx_urls_private       ON urls(is_private);
-- idx_urls_hidden is created in db.ts migrate() so it works on pre-existing DBs too.

-- The visit event log.
CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY,
  url_id     INTEGER NOT NULL REFERENCES urls(id),
  time_ms    INTEGER NOT NULL,    -- epoch ms (UTC)
  client_id  TEXT REFERENCES devices(client_id), -- physical device (Takeout sync hash)
  source     TEXT NOT NULL DEFAULT 'takeout',     -- ingestion provenance (browser/export)
  transition TEXT                 -- normalized: link|typed|reload|form|bookmark|redirect|generated|other
);

CREATE INDEX IF NOT EXISTS idx_visits_url_id  ON visits(url_id);
CREATE INDEX IF NOT EXISTS idx_visits_time    ON visits(time_ms DESC);
CREATE INDEX IF NOT EXISTS idx_visits_client  ON visits(client_id);
-- idx_visits_source is created in db.ts migrate() (works on pre-existing DBs too).
-- Dedupe guard: one row per (url, moment), regardless of source, so importing
-- the same visit from Takeout AND a local browser does not double-count.
CREATE UNIQUE INDEX IF NOT EXISTS uq_visits_url_time ON visits(url_id, time_ms);

-- Full-text search over the URL entity. Contentless table kept in sync by ingest.
CREATE VIRTUAL TABLE IF NOT EXISTS urls_fts USING fts5(
  title,
  url,
  domain,
  path,                          -- URL path+query, tokenized separately
  content=''                     -- external content managed manually; rowid = urls.id
);

-- Saved tab sessions (527). One row per window/session_tag pairing.
CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY,
  session_tag    TEXT NOT NULL,
  window_id      INTEGER,
  last_active_ms INTEGER,
  tab_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active_ms DESC);

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
CREATE INDEX IF NOT EXISTS idx_tabs_session ON session_tabs(session_id);

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

-- Async enrichment job system (liveness / summary / embedding). Built day 1.
CREATE TABLE IF NOT EXISTS enrichments (
  id          INTEGER PRIMARY KEY,
  url_id      INTEGER NOT NULL REFERENCES urls(id),
  kind        TEXT NOT NULL,      -- 'liveness' | 'summary' | 'embedding'
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|skipped
  fetched_at  INTEGER,            -- epoch ms
  result_json TEXT,               -- kind-specific payload
  error       TEXT,
  UNIQUE(url_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_enrich_kind_status ON enrichments(kind, status);

-- Derived "research sessions": bursts of visits with no long idle gap.
-- Computed from the visit log by lib/journeys.ts (full rebuild on demand).
-- NOTE: deliberately distinct from `sessions` above (Takeout saved tab windows).
CREATE TABLE IF NOT EXISTS journeys (
  id           INTEGER PRIMARY KEY,
  client_id    TEXT,                       -- device the burst happened on (nullable)
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  visit_count  INTEGER NOT NULL,           -- total visits in the burst
  url_count    INTEGER NOT NULL,           -- distinct URLs
  domain_count INTEGER NOT NULL,
  link_hops    INTEGER NOT NULL DEFAULT 0, -- # visits via transition='link' (rabbit-hole depth proxy)
  entry_url_id INTEGER REFERENCES urls(id),
  exit_url_id  INTEGER REFERENCES urls(id),
  label        TEXT,                        -- title (LLM or heuristic)
  description  TEXT,                        -- one-line LLM summary (nullable)
  label_source TEXT                         -- 'llm' | 'heuristic' | NULL
);
CREATE INDEX IF NOT EXISTS idx_journeys_start ON journeys(start_ms DESC);

CREATE TABLE IF NOT EXISTS journey_visits (
  journey_id INTEGER NOT NULL REFERENCES journeys(id),
  visit_id   INTEGER NOT NULL REFERENCES visits(id),
  url_id     INTEGER NOT NULL REFERENCES urls(id),
  time_ms    INTEGER NOT NULL,
  transition TEXT,
  ord        INTEGER NOT NULL              -- position within the journey
);
CREATE INDEX IF NOT EXISTS idx_journey_visits_jid ON journey_visits(journey_id, ord);

-- Semantic topic clusters (the "Interest Map"). Derived by lib/clusters.ts:
-- k-means is trained on the top-N most-visited embedded pages, then EVERY
-- embedded public page is assigned to its nearest centroid. Full rebuild.
CREATE TABLE IF NOT EXISTS clusters (
  id           INTEGER PRIMARY KEY,
  label        TEXT,
  description  TEXT,
  size         INTEGER NOT NULL DEFAULT 0,  -- assigned member count
  label_source TEXT,                        -- 'llm' | 'heuristic' | NULL
  built_at     INTEGER
);

CREATE TABLE IF NOT EXISTS cluster_members (
  cluster_id INTEGER NOT NULL REFERENCES clusters(id),
  url_id     INTEGER NOT NULL REFERENCES urls(id),
  distance   REAL                           -- cosine distance to centroid (asc = representative)
);
CREATE INDEX IF NOT EXISTS idx_cluster_members_cid ON cluster_members(cluster_id, distance);
CREATE INDEX IF NOT EXISTS idx_cluster_members_uid ON cluster_members(url_id);

-- Simple key/value for app settings (e.g. AI provider, allowlist).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
