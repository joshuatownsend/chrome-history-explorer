/**
 * Visit-burst detection ("research sessions" / "journeys").
 *
 * A journey is a maximal run of visits on a single device with no idle gap longer
 * than `gapMinutes`. This is a DERIVED object computed from the visit log — it is
 * unrelated to the `sessions` table (which holds Takeout saved tab windows).
 *
 * The rebuild is a full wipe-and-recompute: journeys are cheap to derive and any
 * new import invalidates them, so there is no incremental path to maintain.
 */
import type { Database } from "bun:sqlite";

export interface BuildOpts {
  gapMinutes?: number; // idle gap that ends a burst (default 30)
  minPages?: number; // minimum distinct URLs to keep a burst (default 3)
  days?: number; // only consider visits in the last N days (default: all)
}

interface VisitRow {
  visit_id: number;
  url_id: number;
  time_ms: number;
  client_id: string | null;
  transition: string | null;
  domain: string | null;
  title: string | null;
}

/** Title for a journey when no LLM label has been generated. */
function heuristicLabel(group: VisitRow[]): { label: string; description: string } {
  const urls = new Set(group.map((g) => g.url_id));
  const domains = new Map<string, number>();
  for (const g of group) if (g.domain) domains.set(g.domain, (domains.get(g.domain) ?? 0) + 1);
  const topDomain = [...domains.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // Prefer the entry page's title; fall back to the busiest domain.
  const entryTitle = group[0]?.title?.trim();
  const label = (entryTitle && entryTitle.length > 2 ? entryTitle : topDomain) ?? "(untitled session)";

  const nDomains = domains.size;
  const description = `${urls.size} page${urls.size === 1 ? "" : "s"} · ${nDomains} site${nDomains === 1 ? "" : "s"}`;
  return { label: label.slice(0, 120), description };
}

/**
 * Recompute all journeys. Returns the number of journeys created.
 * Wrapped in a single transaction so a partial build never leaves the tables
 * in a half-populated state.
 */
export function buildJourneys(db: Database, opts: BuildOpts = {}): number {
  const gapMs = Math.max(1, opts.gapMinutes ?? 30) * 60_000;
  const minPages = Math.max(2, opts.minPages ?? 3);
  const cutoff = opts.days && opts.days > 0 ? Date.now() - opts.days * 86_400_000 : 0;

  // Chronological per device. Hidden URLs ("ignore" rules) never appear in a journey.
  // NULL client_id sorts together as its own partition.
  const rows = db
    .query<VisitRow, [number]>(
      `SELECT v.id AS visit_id, v.url_id, v.time_ms, v.client_id, v.transition,
              u.domain, u.title
         FROM visits v
         JOIN urls u ON u.id = v.url_id
        WHERE u.is_hidden = 0 AND v.time_ms >= ?
        ORDER BY v.client_id, v.time_ms`,
    )
    .all(cutoff);

  const insertJourney = db.query(
    `INSERT INTO journeys
       (client_id, start_ms, end_ms, visit_count, url_count, domain_count,
        link_hops, entry_url_id, exit_url_id, label, description, label_source)
     VALUES ($client, $start, $end, $visits, $urls, $domains,
             $hops, $entry, $exit, $label, $desc, 'heuristic')`,
  );
  const insertMember = db.query(
    `INSERT INTO journey_visits (journey_id, visit_id, url_id, time_ms, transition, ord)
     VALUES ($jid, $vid, $uid, $time, $trans, $ord)`,
  );

  let created = 0;

  const flush = (group: VisitRow[]) => {
    const urlIds = new Set(group.map((g) => g.url_id));
    if (urlIds.size < minPages) return; // not a "session", just a stray visit or two

    const { label, description } = heuristicLabel(group);
    const info = insertJourney.run({
      $client: group[0].client_id,
      $start: group[0].time_ms,
      $end: group[group.length - 1].time_ms,
      $visits: group.length,
      $urls: urlIds.size,
      $domains: new Set(group.map((g) => g.domain).filter(Boolean)).size,
      $hops: group.filter((g) => g.transition === "link").length,
      $entry: group[0].url_id,
      $exit: group[group.length - 1].url_id,
      $label: label,
      $desc: description,
    });
    const jid = Number(info.lastInsertRowid);
    group.forEach((g, ord) =>
      insertMember.run({
        $jid: jid,
        $vid: g.visit_id,
        $uid: g.url_id,
        $time: g.time_ms,
        $trans: g.transition,
        $ord: ord,
      }),
    );
    created++;
  };

  const build = db.transaction(() => {
    db.query("DELETE FROM journey_visits").run();
    db.query("DELETE FROM journeys").run();

    let group: VisitRow[] = [];
    for (const r of rows) {
      const prev = group[group.length - 1];
      const sameDevice = prev ? prev.client_id === r.client_id : true;
      const withinGap = prev ? r.time_ms - prev.time_ms <= gapMs : true;
      if (prev && (!sameDevice || !withinGap)) {
        flush(group);
        group = [];
      }
      group.push(r);
    }
    if (group.length) flush(group);
  });
  build();

  return created;
}
