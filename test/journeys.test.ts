import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildJourneys } from "../src/server/lib/journeys.ts";

const SCHEMA = readFileSync(join(import.meta.dir, "../src/server/schema.sql"), "utf8");
const T = Date.UTC(2025, 0, 1); // base instant
const MIN = 60_000;

function newDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

function addDevice(db: Database, id: string) {
  db.run(`INSERT OR IGNORE INTO devices(client_id,label,first_seen,last_seen,visit_count) VALUES (?,?,0,0,0)`, [id, id]);
}
function addUrl(db: Database, id: number, opts: { hidden?: number; priv?: number; domain?: string } = {}) {
  const domain = opts.domain ?? `site${id}.com`;
  db.run(
    `INSERT INTO urls(id,url,hostname,domain,title,is_private,is_hidden,visit_count,first_visited,last_visited,device_count)
     VALUES (?,?,?,?,?,?,?,0,0,0,0)`,
    [id, `https://${domain}/p${id}`, domain, domain, `Title ${id}`, opts.priv ?? 0, opts.hidden ?? 0],
  );
}
function addVisit(
  db: Database,
  urlId: number,
  timeMs: number,
  opts: { client?: string | null; source?: string; transition?: string | null } = {},
) {
  db.run(`INSERT INTO visits(url_id,time_ms,client_id,source,transition) VALUES (?,?,?,?,?)`, [
    urlId,
    timeMs,
    opts.client ?? null,
    opts.source ?? "takeout",
    opts.transition ?? null,
  ]);
}
const journeys = (db: Database) => db.query(`SELECT * FROM journeys ORDER BY start_ms`).all() as any[];
const members = (db: Database, jid: number) =>
  db.query(`SELECT * FROM journey_visits WHERE journey_id=? ORDER BY ord`).all(jid) as any[];

describe("buildJourneys", () => {
  test("splits bursts on an idle gap and drops bursts under minPages", () => {
    const db = newDb();
    addDevice(db, "A");
    for (let i = 1; i <= 7; i++) addUrl(db, i);
    // Burst 1: 4 distinct urls within the gap.
    addVisit(db, 1, T + 0 * MIN, { client: "A" });
    addVisit(db, 2, T + 1 * MIN, { client: "A" });
    addVisit(db, 3, T + 2 * MIN, { client: "A" });
    addVisit(db, 4, T + 3 * MIN, { client: "A" });
    // Burst 2 after a >30m gap: 3 distinct urls.
    addVisit(db, 5, T + 40 * MIN, { client: "A" });
    addVisit(db, 6, T + 41 * MIN, { client: "A" });
    addVisit(db, 7, T + 42 * MIN, { client: "A" });
    // Burst 3 after another gap: only 2 distinct urls -> dropped.
    addVisit(db, 1, T + 80 * MIN, { client: "A" });
    addVisit(db, 2, T + 81 * MIN, { client: "A" });

    const n = buildJourneys(db, { gapMinutes: 30, minPages: 3 });
    expect(n).toBe(2);

    const js = journeys(db);
    expect(js.length).toBe(2);
    expect(js[0].url_count).toBe(4);
    expect(js[0].entry_url_id).toBe(1);
    expect(js[0].exit_url_id).toBe(4);
    expect(js[1].url_count).toBe(3);

    // ord is dense + ascending starting at 0.
    const m = members(db, js[0].id);
    expect(m.map((r) => r.ord)).toEqual([0, 1, 2, 3]);
  });

  test("counts link-transition hops as rabbit-hole depth", () => {
    const db = newDb();
    addDevice(db, "A");
    for (let i = 1; i <= 4; i++) addUrl(db, i);
    addVisit(db, 1, T + 0 * MIN, { client: "A", transition: "typed" });
    addVisit(db, 2, T + 1 * MIN, { client: "A", transition: "link" });
    addVisit(db, 3, T + 2 * MIN, { client: "A", transition: "link" });
    addVisit(db, 4, T + 3 * MIN, { client: "A", transition: "link" });

    buildJourneys(db, { gapMinutes: 30, minPages: 3 });
    expect(journeys(db)[0].link_hops).toBe(3);
  });

  test("partitions concurrent activity by device", () => {
    const db = newDb();
    addDevice(db, "A");
    addDevice(db, "B");
    for (let i = 1; i <= 6; i++) addUrl(db, i);
    // Same time window, two devices — must NOT merge into one journey.
    for (const [i, t] of [1, 2, 3].entries()) addVisit(db, t, T + i * MIN, { client: "A" });
    for (const [i, t] of [4, 5, 6].entries()) addVisit(db, t, T + i * MIN, { client: "B" });

    expect(buildJourneys(db, { gapMinutes: 30, minPages: 3 })).toBe(2);
    expect(journeys(db).every((j) => j.url_count === 3)).toBe(true);
  });

  test("partitions null-client local profiles by source", () => {
    const db = newDb();
    for (let i = 1; i <= 6; i++) addUrl(db, i);
    for (const [i, t] of [1, 2, 3].entries())
      addVisit(db, t, T + i * MIN, { client: null, source: "chrome:Default" });
    for (const [i, t] of [4, 5, 6].entries())
      addVisit(db, t, T + i * MIN, { client: null, source: "firefox:x" });

    expect(buildJourneys(db, { gapMinutes: 30, minPages: 3 })).toBe(2);
  });

  test("excludes hidden URLs from journeys", () => {
    const db = newDb();
    addDevice(db, "A");
    addUrl(db, 1);
    addUrl(db, 2);
    addUrl(db, 3, { hidden: 1 });
    addUrl(db, 4);
    addVisit(db, 1, T + 0 * MIN, { client: "A" });
    addVisit(db, 2, T + 1 * MIN, { client: "A" });
    addVisit(db, 3, T + 2 * MIN, { client: "A" }); // hidden — must be skipped
    addVisit(db, 4, T + 3 * MIN, { client: "A" });

    buildJourneys(db, { gapMinutes: 30, minPages: 3 });
    const js = journeys(db);
    expect(js.length).toBe(1);
    expect(js[0].url_count).toBe(3); // 1,2,4 — not the hidden 3
    const urlIds = members(db, js[0].id).map((m) => m.url_id);
    expect(urlIds).not.toContain(3);
  });

  test("a full rebuild replaces prior journeys", () => {
    const db = newDb();
    addDevice(db, "A");
    for (let i = 1; i <= 3; i++) addUrl(db, i);
    for (const [i, t] of [1, 2, 3].entries()) addVisit(db, t, T + i * MIN, { client: "A" });
    buildJourneys(db, { gapMinutes: 30, minPages: 3 });
    buildJourneys(db, { gapMinutes: 30, minPages: 3 }); // re-run
    expect(journeys(db).length).toBe(1); // not duplicated
    expect((db.query(`SELECT COUNT(*) n FROM journey_visits`).get() as any).n).toBe(3);
  });
});
