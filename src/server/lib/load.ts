/** Source-agnostic loader: turns NormalizedVisit streams into DB rows. */
import type { Database } from "bun:sqlite";
import { parseUrl } from "./domain.ts";
import { recomputePrivacy } from "./rules.ts";
import type { NormalizedVisit, SessionData } from "./sources/types.ts";

export function createLoader(db: Database) {
  const upsertUrl = db.prepare(
    `INSERT INTO urls (url, hostname, domain, title, is_private)
     VALUES ($url, $hostname, $domain, $title, $isPrivate)
     ON CONFLICT(url) DO UPDATE SET title = COALESCE(excluded.title, urls.title)
     RETURNING id`,
  );
  const insertVisit = db.prepare(
    `INSERT OR IGNORE INTO visits (url_id, time_ms, client_id, source, transition)
     VALUES ($urlId, $timeMs, $clientId, $source, $transition)`,
  );
  const upsertDevice = db.prepare(
    `INSERT INTO devices (client_id, first_seen, last_seen, visit_count)
     VALUES ($id, $t, $t, 0) ON CONFLICT(client_id) DO NOTHING`,
  );
  const urlIdCache = new Map<string, number>();

  /** Load a source's visits. Streams the iterable inside one transaction. */
  function loadVisits(source: string, visits: Iterable<NormalizedVisit>): number {
    let inserted = 0;
    const run = db.transaction(() => {
      for (const r of visits) {
        if (!r.url || !Number.isFinite(r.timeMs)) continue;
        let urlId = urlIdCache.get(r.url);
        if (urlId === undefined) {
          const parts = parseUrl(r.url);
          urlId = (
            upsertUrl.get({
              $url: r.url,
              $hostname: parts.hostname,
              $domain: parts.domain,
              $title: r.title ?? null,
              $isPrivate: parts.isPrivate ? 1 : 0,
            }) as { id: number }
          ).id;
          urlIdCache.set(r.url, urlId);
        }
        if (r.clientId) upsertDevice.run({ $id: r.clientId, $t: r.timeMs });
        const res = insertVisit.run({
          $urlId: urlId,
          $timeMs: r.timeMs,
          $clientId: r.clientId,
          $source: source,
          $transition: r.transition,
        });
        if (res.changes) inserted++;
      }
    });
    run();
    return inserted;
  }

  /** Load Takeout sessions (windows → tabs → navigation). */
  function loadSessions(sessions: SessionData[]): void {
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
    const run = db.transaction(() => {
      db.exec("DELETE FROM tab_navigations; DELETE FROM session_tabs; DELETE FROM sessions;");
      for (const s of sessions) {
        const sid = (
          insSession.get({
            $tag: s.sessionTag,
            $win: s.windowId,
            $active: s.lastActiveMs,
            $count: s.tabs.length,
          }) as { id: number }
        ).id;
        for (const t of s.tabs) {
          const tabPk = (
            insTab.get({
              $sid: sid,
              $tabId: t.tabId,
              $nodeId: t.tabNodeId,
              $pinned: t.pinned ? 1 : 0,
              $navIdx: t.currentNavIndex,
              $btype: t.browserType,
              $active: t.lastActiveMs,
              $curUrl: t.currentUrl,
              $curTitle: t.currentTitle,
            }) as { id: number }
          ).id;
          for (const n of t.navigation) {
            insNav.run({
              $tabPk: tabPk,
              $idx: n.idx,
              $title: n.title,
              $url: n.virtualUrl,
              $ts: n.timestampMs,
              $status: n.httpStatus,
              $ref: n.referrer,
            });
          }
        }
      }
    });
    run();
  }

  return { loadVisits, loadSessions };
}

/** Recompute all derived data after one or more loads. Call once at the end. */
export function finalize(db: Database): void {
  db.exec(`
    UPDATE urls SET
      visit_count   = COALESCE((SELECT COUNT(*) FROM visits v WHERE v.url_id = urls.id), 0),
      first_visited = (SELECT MIN(time_ms) FROM visits v WHERE v.url_id = urls.id),
      last_visited  = (SELECT MAX(time_ms) FROM visits v WHERE v.url_id = urls.id),
      device_count  = (SELECT COUNT(DISTINCT client_id) FROM visits v WHERE v.url_id = urls.id);
  `);
  db.exec(`
    UPDATE devices SET
      visit_count = COALESCE((SELECT COUNT(*) FROM visits v WHERE v.client_id = devices.client_id), 0),
      first_seen  = (SELECT MIN(time_ms) FROM visits v WHERE v.client_id = devices.client_id),
      last_seen   = (SELECT MAX(time_ms) FROM visits v WHERE v.client_id = devices.client_id);
  `);

  // Rebuild the contentless FTS index from the urls table.
  db.exec("INSERT INTO urls_fts(urls_fts) VALUES('delete-all');");
  const insertFts = db.prepare(
    "INSERT INTO urls_fts (rowid, title, url, domain, path) VALUES ($id, $title, $url, $domain, $path)",
  );
  const ftsRun = db.transaction(() => {
    const all = db
      .query<{ id: number; url: string; title: string | null; domain: string | null }, []>(
        "SELECT id, url, title, domain FROM urls",
      )
      .all();
    for (const u of all) {
      insertFts.run({
        $id: u.id,
        $title: u.title ?? "",
        $url: u.url,
        $domain: u.domain ?? "",
        $path: parseUrl(u.url).path,
      });
    }
  });
  ftsRun();

  recomputePrivacy(db); // apply built-in + user privacy/ignore rules
}
