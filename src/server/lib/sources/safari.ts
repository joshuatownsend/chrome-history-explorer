import type { HistorySource, NormalizedVisit } from "./types.ts";
import { openSqliteCopy } from "./sqlite-open.ts";

// Safari uses CFAbsoluteTime: seconds since 2001-01-01 UTC.
const COCOA_EPOCH_OFFSET_S = 978307200;
const PAGE = 5000;

interface Row {
  url: string;
  title: string | null;
  visit_time: number; // CFAbsoluteTime seconds (may be fractional)
}

/**
 * Safari history (History.db). Implemented but unverified — Safari only exists
 * on macOS, so this path is fixture-tested, not real-data-tested. A macOS
 * contributor should confirm against a live profile.
 */
export class SafariSource implements HistorySource {
  constructor(
    private historyDbPath: string,
    public source: string,
  ) {}

  *readVisits(): Iterable<NormalizedVisit> {
    const { db, cleanup } = openSqliteCopy(this.historyDbPath);
    try {
      const stmt = db.query<Row, [number, number]>(
        `SELECT i.url, v.title, v.visit_time
         FROM history_visits v JOIN history_items i ON i.id = v.history_item
         WHERE i.url IS NOT NULL ORDER BY v.id LIMIT ? OFFSET ?`,
      );
      for (let offset = 0; ; offset += PAGE) {
        const rows = stmt.all(PAGE, offset);
        if (!rows.length) break;
        for (const r of rows) {
          if (!r.visit_time) continue;
          yield {
            url: r.url,
            title: r.title || null,
            timeMs: Math.round((r.visit_time + COCOA_EPOCH_OFFSET_S) * 1000),
            clientId: null,
            transition: null, // Safari's schema has no comparable transition field
          };
        }
        if (rows.length < PAGE) break;
      }
    } finally {
      cleanup();
    }
  }
}
