import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromiumSource } from "../src/server/lib/sources/chromium.ts";
import { FirefoxSource } from "../src/server/lib/sources/firefox.ts";
import { SafariSource } from "../src/server/lib/sources/safari.ts";

// A fixed instant used across every adapter so the epoch conversions are
// directly comparable: 2025-01-01T00:00:00.000Z.
const UNIX_MS = Date.UTC(2025, 0, 1);

function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "che-fixture-")), name);
}

describe("ChromiumSource", () => {
  test("converts 1601-epoch microseconds and normalizes transitions", () => {
    const path = tmpDb("History");
    const db = new Database(path);
    db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT);
             CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER);`);
    // chrome time = (unixMs + 11644473600000) * 1000
    const chromeTime = (UNIX_MS + 11_644_473_600_000) * 1000;
    db.exec(`INSERT INTO urls(id,url,title) VALUES (1,'https://a.com/x','A');`);
    db.run(`INSERT INTO visits(id,url,visit_time,transition) VALUES (1,1,?,0),(2,1,?,1),(3,1,?,8)`,
      [chromeTime, chromeTime + 1000, chromeTime + 2000]);
    db.close();

    const visits = [...new ChromiumSource(path, "chrome:test").readVisits()];
    expect(visits.length).toBe(3);
    expect(visits[0].timeMs).toBe(UNIX_MS);
    expect(visits[0].transition).toBe("link");
    expect(visits[1].transition).toBe("typed");
    expect(visits[2].transition).toBe("reload");
    expect(visits[0].url).toBe("https://a.com/x");
  });
});

describe("FirefoxSource", () => {
  test("converts Unix-epoch microseconds and normalizes visit_type", () => {
    const path = tmpDb("places.sqlite");
    const db = new Database(path);
    db.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT);
             CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, visit_type INTEGER);`);
    db.exec(`INSERT INTO moz_places(id,url,title) VALUES (1,'https://b.com/y','B');`);
    db.run(`INSERT INTO moz_historyvisits(id,place_id,visit_date,visit_type) VALUES (1,1,?,1),(2,1,?,2),(3,1,?,9)`,
      [UNIX_MS * 1000, UNIX_MS * 1000 + 1000, UNIX_MS * 1000 + 2000]);
    db.close();

    const visits = [...new FirefoxSource(path, "firefox:test").readVisits()];
    expect(visits.length).toBe(3);
    expect(visits[0].timeMs).toBe(UNIX_MS);
    expect(visits[0].transition).toBe("link");
    expect(visits[1].transition).toBe("typed");
    expect(visits[2].transition).toBe("reload");
  });
});

describe("SafariSource", () => {
  test("converts CFAbsoluteTime seconds (2001 epoch)", () => {
    const path = tmpDb("History.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE history_items(id INTEGER PRIMARY KEY, url TEXT);
             CREATE TABLE history_visits(id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);`);
    const cfTime = UNIX_MS / 1000 - 978307200; // seconds since 2001
    db.exec(`INSERT INTO history_items(id,url) VALUES (1,'https://c.com/z');`);
    db.run(`INSERT INTO history_visits(id,history_item,visit_time,title) VALUES (1,1,?,'C')`, [cfTime]);
    db.close();

    const visits = [...new SafariSource(path, "safari:test").readVisits()];
    expect(visits.length).toBe(1);
    expect(visits[0].timeMs).toBe(UNIX_MS);
    expect(visits[0].url).toBe("https://c.com/z");
    expect(visits[0].transition).toBeNull();
  });
});
