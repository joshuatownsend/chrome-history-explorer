/**
 * ETL: Google Takeout History.json -> SQLite.
 * Idempotent: re-running upserts urls, dedupes visits, and rebuilds aggregates.
 *
 * Usage: bun run src/server/ingest.ts [path/to/History.json]
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./db.ts";
import { parseUrl } from "./lib/domain.ts";

const SRC = process.argv[2] ?? join(process.cwd(), "History.json");

interface RawVisit {
  url: string;
  title?: string;
  time_usec: number;
  client_id?: string;
  favicon_url?: string;
}

interface RawNav {
  title?: string;
  virtual_url?: string;
  timestamp_msec?: number;
  http_status_code?: number;
  referrer?: string;
}
interface RawSession {
  tab_node_id?: number;
  session_tag?: string;
  tab?: {
    tab_id?: number;
    pinned?: boolean;
    current_navigation_index?: number;
    browser_type?: string;
    window_id?: number;
    last_active_time_unix_epoch_millis?: number;
    navigation?: RawNav[];
  };
}

function ingest(db: Database, data: any) {
  const history: RawVisit[] = data["Browser History"] ?? [];
  const sessions: RawSession[] = data["Session"] ?? [];

  // ---- URLs + visits -------------------------------------------------------
  const upsertUrl = db.prepare(
    `INSERT INTO urls (url, hostname, domain, title, is_private)
     VALUES ($url, $hostname, $domain, $title, $isPrivate)
     ON CONFLICT(url) DO UPDATE SET
       title = COALESCE(excluded.title, urls.title)
     RETURNING id`,
  );
  const insertVisit = db.prepare(
    `INSERT OR IGNORE INTO visits (url_id, time_ms, client_id)
     VALUES ($urlId, $timeMs, $clientId)`,
  );
  const upsertDevice = db.prepare(
    `INSERT INTO devices (client_id, first_seen, last_seen, visit_count)
     VALUES ($id, $t, $t, 0)
     ON CONFLICT(client_id) DO NOTHING`,
  );

  const urlIdCache = new Map<string, number>();

  const run = db.transaction((rows: RawVisit[]) => {
    for (const r of rows) {
      if (!r.url) continue;
      const timeMs = Math.floor(r.time_usec / 1000);
      const clientId = r.client_id ?? null;

      let urlId = urlIdCache.get(r.url);
      if (urlId === undefined) {
        const parts = parseUrl(r.url);
        const res = upsertUrl.get({
          $url: r.url,
          $hostname: parts.hostname,
          $domain: parts.domain,
          $title: r.title ?? null,
          $isPrivate: parts.isPrivate ? 1 : 0,
        }) as { id: number };
        urlId = res.id;
        urlIdCache.set(r.url, urlId);
      }

      if (clientId) upsertDevice.run({ $id: clientId, $t: timeMs });
      insertVisit.run({ $urlId: urlId, $timeMs: timeMs, $clientId: clientId });
    }
  });
  run(history);

  // ---- Recompute URL aggregates from the visit log -------------------------
  db.exec(`
    UPDATE urls SET
      visit_count = COALESCE((SELECT COUNT(*) FROM visits v WHERE v.url_id = urls.id), 0),
      first_visited = (SELECT MIN(time_ms) FROM visits v WHERE v.url_id = urls.id),
      last_visited  = (SELECT MAX(time_ms) FROM visits v WHERE v.url_id = urls.id),
      device_count  = (SELECT COUNT(DISTINCT client_id) FROM visits v WHERE v.url_id = urls.id);
  `);

  // ---- Device aggregates ---------------------------------------------------
  db.exec(`
    UPDATE devices SET
      visit_count = COALESCE((SELECT COUNT(*) FROM visits v WHERE v.client_id = devices.client_id), 0),
      first_seen  = (SELECT MIN(time_ms) FROM visits v WHERE v.client_id = devices.client_id),
      last_seen   = (SELECT MAX(time_ms) FROM visits v WHERE v.client_id = devices.client_id);
  `);

  // ---- FTS rebuild (contentless, rowid = urls.id) --------------------------
  // Contentless FTS5 tables reject plain DELETE; use the special delete-all cmd.
  db.exec(`INSERT INTO urls_fts(urls_fts) VALUES('delete-all');`);
  const insertFts = db.prepare(
    `INSERT INTO urls_fts (rowid, title, url, domain, path)
     VALUES ($id, $title, $url, $domain, $path)`,
  );
  const ftsRun = db.transaction(() => {
    const all = db
      .query<{ id: number; url: string; title: string | null; domain: string | null }, []>(
        `SELECT id, url, title, domain FROM urls`,
      )
      .all();
    for (const u of all) {
      const { path } = parseUrl(u.url);
      insertFts.run({
        $id: u.id,
        $title: u.title ?? "",
        $url: u.url,
        $domain: u.domain ?? "",
        $path: path,
      });
    }
  });
  ftsRun();

  // ---- Sessions / tabs / navigations --------------------------------------
  db.exec(`DELETE FROM tab_navigations; DELETE FROM session_tabs; DELETE FROM sessions;`);
  const insSession = db.prepare(
    `INSERT INTO sessions (session_tag, window_id, last_active_ms, tab_count)
     VALUES ($tag, $win, $active, $count) RETURNING id`,
  );
  const insTab = db.prepare(
    `INSERT INTO session_tabs
       (session_id, tab_id, tab_node_id, pinned, current_nav_index, browser_type, last_active_ms, current_url, current_title)
     VALUES ($sid, $tabId, $nodeId, $pinned, $navIdx, $btype, $active, $curUrl, $curTitle) RETURNING id`,
  );
  const insNav = db.prepare(
    `INSERT INTO tab_navigations (tab_pk, idx, title, virtual_url, timestamp_ms, http_status, referrer)
     VALUES ($tabPk, $idx, $title, $url, $ts, $status, $ref)`,
  );

  const sessionsRun = db.transaction(() => {
    // Group tab nodes by (session_tag, window_id) into one logical session/window.
    const byWindow = new Map<string, RawSession[]>();
    for (const s of sessions) {
      const key = `${s.session_tag ?? "?"}::${s.tab?.window_id ?? "?"}`;
      const arr = byWindow.get(key) ?? [];
      arr.push(s);
      byWindow.set(key, arr);
    }
    for (const [, tabs] of byWindow) {
      const first = tabs[0];
      const lastActive = Math.max(
        0,
        ...tabs.map((t) => t.tab?.last_active_time_unix_epoch_millis ?? 0),
      );
      const sid = (
        insSession.get({
          $tag: first.session_tag ?? null,
          $win: first.tab?.window_id ?? null,
          $active: lastActive || null,
          $count: tabs.length,
        }) as { id: number }
      ).id;

      for (const s of tabs) {
        const tab = s.tab ?? {};
        const navs = tab.navigation ?? [];
        const curIdx = tab.current_navigation_index ?? navs.length - 1;
        const cur = navs[curIdx] ?? navs[navs.length - 1];
        const tabPk = (
          insTab.get({
            $sid: sid,
            $tabId: tab.tab_id ?? null,
            $nodeId: s.tab_node_id ?? null,
            $pinned: tab.pinned ? 1 : 0,
            $navIdx: curIdx,
            $btype: tab.browser_type ?? null,
            $active: tab.last_active_time_unix_epoch_millis ?? null,
            $curUrl: cur?.virtual_url ?? null,
            $curTitle: cur?.title ?? null,
          }) as { id: number }
        ).id;

        navs.forEach((n, i) => {
          insNav.run({
            $tabPk: tabPk,
            $idx: i,
            $title: n.title ?? null,
            $url: n.virtual_url ?? null,
            $ts: n.timestamp_msec ?? null,
            $status: n.http_status_code ?? null,
            $ref: n.referrer ?? null,
          });
        });
      }
    }
  });
  sessionsRun();
}

function main() {
  console.log(`Reading ${SRC} ...`);
  const data = JSON.parse(readFileSync(SRC, "utf8"));
  const db = getDb();
  const t0 = Date.now();
  ingest(db, data);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
  console.log(`\nIngest complete in ${secs}s`);
  console.log("  visits          :", one("SELECT COUNT(*) n FROM visits"));
  console.log("  urls            :", one("SELECT COUNT(*) n FROM urls"));
  console.log("  domains         :", one("SELECT COUNT(DISTINCT domain) n FROM urls"));
  console.log("  devices         :", one("SELECT COUNT(*) n FROM devices"));
  console.log("  private urls    :", one("SELECT COUNT(*) n FROM urls WHERE is_private=1"));
  console.log("  sessions        :", one("SELECT COUNT(*) n FROM sessions"));
  console.log("  session_tabs    :", one("SELECT COUNT(*) n FROM session_tabs"));
  console.log("  tab_navigations :", one("SELECT COUNT(*) n FROM tab_navigations"));
}

main();
