/**
 * Semantic topic clustering for the "Interest Map".
 *
 * Strategy (see the AI-features plan): embeddings exist for many URLs, but
 * iterative k-means over all of them is both slow and unnecessary. We TRAIN
 * k-means on the top-N most-visited embedded pages (default 5000 — the
 * "right weight" for in-process JS) and then make ONE assignment pass mapping
 * every embedded public page to its nearest centroid. So the map covers the
 * whole corpus while the expensive part stays bounded and well under the
 * server's idleTimeout.
 *
 * Privacy: only is_private=0 AND is_hidden=0 pages are loaded — the existing
 * embedding backfill predates the is_hidden filter, so hidden pages can have
 * stale embeddings and must be excluded here too (mirrors ai.ts / journeys).
 */
import type { Database } from "bun:sqlite";

export interface ClusterBuildOpts {
  k?: number; // number of clusters (auto when omitted)
  max?: number; // training-set cap (default 5000)
}

interface Point {
  url_id: number;
  vec: number[];
  visit_count: number;
  title: string | null;
  domain: string | null;
}

export interface ClusterSummary {
  id: number; // inserted clusters.id
  size: number;
  topDomain: string | null;
  repTitles: string[]; // titles nearest the centroid, for LLM labeling
}

export interface BuildResult {
  clusters: number;
  members: number;
  embedded: number;
  trained_on: number;
  summaries: ClusterSummary[];
}

function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

function sqdist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/** k-means++ seeding: spread initial centroids by distance, with a running min. */
function kppInit(vecs: number[][], K: number): number[][] {
  const n = vecs.length;
  const centroids: number[][] = [vecs[Math.floor(Math.random() * n)].slice()];
  const minD = new Float64Array(n).fill(Infinity);
  while (centroids.length < K) {
    const last = centroids[centroids.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = sqdist(vecs[i], last);
      if (d < minD[i]) minD[i] = d;
      total += minD[i];
    }
    if (total === 0) break; // all remaining points coincide with a centroid
    let r = Math.random() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= minD[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(vecs[pick].slice());
  }
  return centroids;
}

/** Train k-means on `vecs`; returns centroids (Lloyd's, k-means++ init). */
function trainKmeans(vecs: number[][], K: number, maxIter = 15): number[][] {
  const dim = vecs[0].length;
  let centroids = kppInit(vecs, K);
  const assign = new Int32Array(vecs.length).fill(-1);

  for (let iter = 0; iter < maxIter; iter++) {
    let moved = 0;
    for (let i = 0; i < vecs.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = sqdist(vecs[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved++;
      }
    }
    // Recompute centroids.
    const sums = centroids.map(() => new Float64Array(dim));
    const counts = new Int32Array(centroids.length);
    for (let i = 0; i < vecs.length; i++) {
      const c = assign[i];
      counts[c]++;
      const s = sums[c];
      const v = vecs[i];
      for (let d = 0; d < dim; d++) s[d] += v[d];
    }
    centroids = sums.map((s, c) => {
      if (counts[c] === 0) return vecs[Math.floor(Math.random() * vecs.length)].slice(); // reseed empty
      return Array.from(s, (x) => x / counts[c]);
    });
    if (moved === 0) break; // converged
  }
  return centroids;
}

function nearest(vec: number[], centroids: number[][]): { idx: number; d2: number } {
  let idx = 0;
  let best = Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const d = sqdist(vec, centroids[c]);
    if (d < best) {
      best = d;
      idx = c;
    }
  }
  return { idx, d2: best };
}

/**
 * Rebuild all clusters. Inserts heuristic labels; the route LLM-labels each
 * non-empty cluster afterward (returned in `summaries`).
 */
export function buildClusters(db: Database, opts: ClusterBuildOpts = {}): BuildResult {
  const maxTrain = Math.min(Math.max(opts.max ?? 5000, 100), 20000);

  const rows = db
    .query<{ url_id: number; result_json: string; visit_count: number; title: string | null; domain: string | null }, []>(
      `SELECT e.url_id, e.result_json, u.visit_count, u.title, u.domain
         FROM enrichments e JOIN urls u ON u.id = e.url_id
        WHERE e.kind = 'embedding' AND e.status = 'done'
          AND u.is_private = 0 AND u.is_hidden = 0
        ORDER BY u.visit_count DESC`,
    )
    .all();

  const points: Point[] = [];
  let dim = 0;
  for (const r of rows) {
    try {
      const vec = JSON.parse(r.result_json).vector as number[];
      if (!Array.isArray(vec) || !vec.length) continue;
      if (!dim) dim = vec.length;
      if (vec.length !== dim) continue; // skip mismatched dims (provider/model change)
      points.push({ url_id: r.url_id, vec: l2normalize(vec), visit_count: r.visit_count, title: r.title, domain: r.domain });
    } catch {
      /* skip unparseable */
    }
  }

  const wipe = () => {
    db.query("DELETE FROM cluster_members").run();
    db.query("DELETE FROM clusters").run();
  };

  if (points.length < 2) {
    db.transaction(wipe)();
    return { clusters: 0, members: 0, embedded: points.length, trained_on: 0, summaries: [] };
  }

  // Train on the most-visited subset; assign everyone.
  const trainPoints = points.slice(0, maxTrain);
  const autoK = Math.round(Math.sqrt(trainPoints.length / 2));
  const K = Math.max(2, Math.min(opts.k ?? autoK, 24, trainPoints.length));
  const centroids = trainKmeans(trainPoints.map((p) => p.vec), K);

  // One assignment pass over ALL embedded points.
  const buckets: Point[][] = centroids.map(() => []);
  const dists: number[][] = centroids.map(() => []);
  for (const p of points) {
    const { idx, d2 } = nearest(p.vec, centroids);
    buckets[idx].push(p);
    dists[idx].push(d2 / 2); // normalized vectors: cosine distance = sqdist/2
  }

  const insertCluster = db.query(
    `INSERT INTO clusters (label, description, size, label_source, built_at)
     VALUES ($label, NULL, $size, 'heuristic', $at)`,
  );
  const insertMember = db.query(
    `INSERT INTO cluster_members (cluster_id, url_id, distance) VALUES ($cid, $uid, $dist)`,
  );
  const at = Date.now();
  const summaries: ClusterSummary[] = [];
  let memberTotal = 0;

  db.transaction(() => {
    wipe();
    centroids.forEach((_, c) => {
      const members = buckets[c];
      if (!members.length) return; // drop empty clusters

      // Order members by distance (representative first).
      const order = members.map((_, i) => i).sort((a, b) => dists[c][a] - dists[c][b]);
      const domainCount = new Map<string, number>();
      for (const m of members) if (m.domain) domainCount.set(m.domain, (domainCount.get(m.domain) ?? 0) + 1);
      const topDomain = [...domainCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      const repTitles: string[] = [];
      const seen = new Set<string>();
      for (const i of order) {
        const t = (members[i].title || members[i].domain || "").trim();
        if (t && !seen.has(t)) {
          seen.add(t);
          repTitles.push(t);
          if (repTitles.length >= 30) break;
        }
      }

      const info = insertCluster.run({ $label: topDomain ?? "(unlabeled)", $size: members.length, $at: at });
      const cid = Number(info.lastInsertRowid);
      for (const i of order) {
        insertMember.run({ $cid: cid, $uid: members[i].url_id, $dist: dists[c][i] });
        memberTotal++;
      }
      summaries.push({ id: cid, size: members.length, topDomain, repTitles });
    });
  })();

  return { clusters: summaries.length, members: memberTotal, embedded: points.length, trained_on: trainPoints.length, summaries };
}
