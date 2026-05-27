import { readFileSync } from "node:fs";
import type { HistorySource, NormalizedVisit, SessionData } from "./types.ts";

interface RawVisit {
  url: string;
  title?: string;
  time_usec: number;
  client_id?: string;
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

/** Google Takeout History.json — the only source that also carries tab sessions. */
export class TakeoutSource implements HistorySource {
  source = "takeout";
  private data: { "Browser History"?: RawVisit[]; Session?: RawSession[] };

  constructor(filePath: string) {
    this.data = JSON.parse(readFileSync(filePath, "utf8"));
  }

  *readVisits(): Iterable<NormalizedVisit> {
    for (const r of this.data["Browser History"] ?? []) {
      if (!r.url) continue;
      yield {
        url: r.url,
        title: r.title ?? null,
        timeMs: Math.floor(r.time_usec / 1000), // µs since Unix epoch → ms
        clientId: r.client_id ?? null,
        transition: null, // Takeout does not preserve transition types
      };
    }
  }

  readSessions(): SessionData[] {
    const sessions = this.data.Session ?? [];
    const byWindow = new Map<string, RawSession[]>();
    for (const s of sessions) {
      const key = `${s.session_tag ?? "?"}::${s.tab?.window_id ?? "?"}`;
      (byWindow.get(key) ?? byWindow.set(key, []).get(key)!).push(s);
    }
    const out: SessionData[] = [];
    for (const [, tabs] of byWindow) {
      const first = tabs[0];
      out.push({
        sessionTag: first.session_tag ?? null,
        windowId: first.tab?.window_id ?? null,
        lastActiveMs: Math.max(0, ...tabs.map((t) => t.tab?.last_active_time_unix_epoch_millis ?? 0)) || null,
        tabs: tabs.map((s) => {
          const tab = s.tab ?? {};
          const navs = tab.navigation ?? [];
          const curIdx = tab.current_navigation_index ?? navs.length - 1;
          const cur = navs[curIdx] ?? navs[navs.length - 1];
          return {
            tabId: tab.tab_id ?? null,
            tabNodeId: s.tab_node_id ?? null,
            pinned: !!tab.pinned,
            currentNavIndex: curIdx,
            browserType: tab.browser_type ?? null,
            lastActiveMs: tab.last_active_time_unix_epoch_millis ?? null,
            currentUrl: cur?.virtual_url ?? null,
            currentTitle: cur?.title ?? null,
            navigation: navs.map((n, i) => ({
              idx: i,
              title: n.title ?? null,
              virtualUrl: n.virtual_url ?? null,
              timestampMs: n.timestamp_msec ?? null,
              httpStatus: n.http_status_code ?? null,
              referrer: n.referrer ?? null,
            })),
          };
        }),
      });
    }
    return out;
  }
}
