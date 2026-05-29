import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildClusters } from "../src/server/lib/clusters.ts";

const SCHEMA = readFileSync(join(import.meta.dir, "../src/server/schema.sql"), "utf8");

// buildClusters uses Math.random() for k-means++ init/reseeding. Pin it to a
// seeded PRNG so these assertions are fully deterministic, not just relying on
// well-separated fixtures. Restored after each test.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const realRandom = Math.random;
beforeEach(() => {
  Math.random = mulberry32(0x1234abcd);
});
afterEach(() => {
  Math.random = realRandom;
});

function newDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** Insert a URL plus a completed embedding enrichment carrying `vector`. */
function addEmbedded(
  db: Database,
  id: number,
  vector: number[],
  opts: { hidden?: number; priv?: number; visits?: number } = {},
) {
  const domain = `site${id}.com`;
  db.run(
    `INSERT INTO urls(id,url,hostname,domain,title,is_private,is_hidden,visit_count,first_visited,last_visited,device_count)
     VALUES (?,?,?,?,?,?,?,?,0,0,0)`,
    [id, `https://${domain}/p${id}`, domain, domain, `Title ${id}`, opts.priv ?? 0, opts.hidden ?? 0, opts.visits ?? 1],
  );
  db.run(`INSERT INTO enrichments(url_id,kind,status,fetched_at,result_json) VALUES (?, 'embedding', 'done', 0, ?)`, [
    id,
    JSON.stringify({ vector, model: "test", dim: vector.length }),
  ]);
}

/** Three well-separated 4-D blobs, deterministic tiny jitter (no RNG in fixtures). */
function seedBlobs(db: Database) {
  const centers = [
    [10, 0, 0, 0],
    [0, 10, 0, 0],
    [0, 0, 10, 0],
  ];
  let id = 1;
  for (const c of centers) {
    for (let j = 0; j < 5; j++) {
      addEmbedded(db, id, [c[0] + j * 0.01, c[1] + j * 0.01, c[2], c[3]], { visits: 100 - id });
      id++;
    }
  }
}
const blobOf = (urlId: number) => (urlId <= 5 ? "A" : urlId <= 10 ? "B" : "C");

describe("buildClusters", () => {
  test("assigns every embedded point; sizes sum to members; no empty clusters", () => {
    const db = newDb();
    seedBlobs(db);
    const res = buildClusters(db, { k: 3 });

    expect(res.embedded).toBe(15);
    expect(res.members).toBe(15);
    expect(res.clusters).toBe(3);

    const rows = db.query(`SELECT size FROM clusters`).all() as { size: number }[];
    expect(rows.length).toBe(3);
    expect(rows.reduce((a, r) => a + r.size, 0)).toBe(15);
    expect(rows.every((r) => r.size >= 1)).toBe(true); // empty clusters dropped

    const memberCount = (db.query(`SELECT COUNT(*) n FROM cluster_members`).get() as { n: number }).n;
    expect(memberCount).toBe(15);
  });

  test("separable blobs each become their own pure cluster", () => {
    const db = newDb();
    seedBlobs(db);
    buildClusters(db, { k: 3 });

    const rows = db.query(`SELECT cluster_id, url_id FROM cluster_members`).all() as {
      cluster_id: number;
      url_id: number;
    }[];
    const blobsPerCluster = new Map<number, Set<string>>();
    for (const r of rows) {
      const s = blobsPerCluster.get(r.cluster_id) ?? new Set<string>();
      s.add(blobOf(r.url_id));
      blobsPerCluster.set(r.cluster_id, s);
    }
    // Each cluster contains members from exactly one blob, and all 3 blobs appear.
    expect([...blobsPerCluster.values()].every((s) => s.size === 1)).toBe(true);
    const distinctBlobs = new Set([...blobsPerCluster.values()].flatMap((s) => [...s]));
    expect(distinctBlobs.size).toBe(3);
  });

  test("excludes hidden and private pages from clustering", () => {
    const db = newDb();
    seedBlobs(db); // ids 1..15, all public
    addEmbedded(db, 100, [10, 0, 0, 0], { hidden: 1 });
    addEmbedded(db, 101, [0, 10, 0, 0], { priv: 1 });

    const res = buildClusters(db, { k: 3 });
    expect(res.embedded).toBe(15); // hidden + private not counted

    const memberIds = (db.query(`SELECT url_id FROM cluster_members`).all() as { url_id: number }[]).map(
      (r) => r.url_id,
    );
    expect(memberIds).not.toContain(100);
    expect(memberIds).not.toContain(101);
    expect(memberIds.length).toBe(15);
  });

  test("trains on the bounded set but assigns all embedded points", () => {
    const db = newDb();
    // 250 points across 5 loose blobs; visit_count descending so "top-N" is defined.
    const centers = [
      [10, 0, 0, 0],
      [0, 10, 0, 0],
      [0, 0, 10, 0],
      [0, 0, 0, 10],
      [10, 10, 0, 0],
    ];
    for (let id = 1; id <= 250; id++) {
      const c = centers[id % 5];
      addEmbedded(db, id, [c[0] + id * 0.001, c[1], c[2], c[3] + id * 0.001], { visits: 1000 - id });
    }
    const res = buildClusters(db, { k: 5, max: 120 }); // train on top-120 by visit_count
    expect(res.trained_on).toBe(120); // bounded training set (max >= the 100 floor)
    expect(res.members).toBe(250); // every embedded point still assigned
    expect(res.embedded).toBe(250);
    expect(res.clusters).toBeGreaterThan(0);
  });

  test("no embeddings yields an empty map", () => {
    const db = newDb();
    const res = buildClusters(db, {});
    expect(res.clusters).toBe(0);
    expect(res.members).toBe(0);
    expect((db.query(`SELECT COUNT(*) n FROM clusters`).get() as { n: number }).n).toBe(0);
  });
});
