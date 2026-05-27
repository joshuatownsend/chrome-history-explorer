import { firefoxTransition, type HistorySource, type NormalizedVisit } from "./types.ts";
import { openSqliteCopy } from "./sqlite-open.ts";

const PAGE = 5000;

interface Row {
  url: string;
  title: string | null;
  visit_date: number; // microseconds since Unix epoch
  visit_type: number | null;
}

/** Firefox history (places.sqlite). */
export class FirefoxSource implements HistorySource {
  constructor(
    private placesPath: string,
    public source: string,
  ) {}

  *readVisits(): Iterable<NormalizedVisit> {
    const { db, cleanup } = openSqliteCopy(this.placesPath);
    try {
      const stmt = db.query<Row, [number, number]>(
        `SELECT p.url, p.title, h.visit_date, h.visit_type
         FROM moz_historyvisits h JOIN moz_places p ON p.id = h.place_id
         WHERE p.url IS NOT NULL ORDER BY h.id LIMIT ? OFFSET ?`,
      );
      for (let offset = 0; ; offset += PAGE) {
        const rows = stmt.all(PAGE, offset);
        if (!rows.length) break;
        for (const r of rows) {
          if (!r.visit_date) continue;
          yield {
            url: r.url,
            title: r.title || null,
            timeMs: Math.floor(r.visit_date / 1000),
            clientId: null,
            transition: firefoxTransition(r.visit_type),
          };
        }
        if (rows.length < PAGE) break;
      }
    } finally {
      cleanup();
    }
  }
}
