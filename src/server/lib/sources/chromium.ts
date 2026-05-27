import { chromiumTransition, type HistorySource, type NormalizedVisit } from "./types.ts";
import { openSqliteCopy } from "./sqlite-open.ts";

// Chrome/WebKit time is microseconds since 1601-01-01 UTC.
const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000;
const PAGE = 5000;

interface Row {
  url: string;
  title: string | null;
  visit_time: number;
  transition: number | null;
}

/** Chromium-family history (Chrome, Edge, Brave, Vivaldi, Opera, Arc, …). */
export class ChromiumSource implements HistorySource {
  constructor(
    private historyPath: string,
    public source: string,
  ) {}

  *readVisits(): Iterable<NormalizedVisit> {
    const { db, cleanup } = openSqliteCopy(this.historyPath);
    try {
      const stmt = db.query<Row, [number, number]>(
        `SELECT u.url, u.title, v.visit_time, v.transition
         FROM visits v JOIN urls u ON u.id = v.url
         WHERE u.url <> '' ORDER BY v.id LIMIT ? OFFSET ?`,
      );
      for (let offset = 0; ; offset += PAGE) {
        const rows = stmt.all(PAGE, offset);
        if (!rows.length) break;
        for (const r of rows) {
          const timeMs = Math.floor(r.visit_time / 1000) - CHROMIUM_EPOCH_OFFSET_MS;
          if (timeMs <= 0) continue; // skip null/zero timestamps
          yield {
            url: r.url,
            title: r.title || null,
            timeMs,
            clientId: null, // local DB doesn't carry a sync device id
            transition: chromiumTransition(r.transition),
          };
        }
        if (rows.length < PAGE) break;
      }
    } finally {
      cleanup();
    }
  }
}
