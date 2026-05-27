import { Hono } from "hono";
import { getDb } from "../db.ts";

export const tree = new Hono();

interface Row {
  id: number;
  url: string;
  title: string | null;
  visit_count: number;
  last_visited: number | null;
  is_private: number;
  hostname: string | null;
  liveness: string | null;
  liveness_json: string | null;
}

interface BuildNode {
  label: string;
  ownVisits: number; // visits to this exact page (0 for pure containers)
  repVisits: number; // visit_count of the representative URL (for tie-breaking)
  lastVisited: number | null;
  isPage: boolean;
  urlId?: number;
  url?: string;
  title?: string | null;
  isPrivate?: number;
  liveness?: string | null;
  livenessJson?: string | null;
  children: Map<string, BuildNode>;
}

interface OutNode {
  label: string;
  visits: number; // aggregate: own + all descendants
  ownVisits: number;
  lastVisited: number | null;
  isPage: boolean;
  urlId?: number;
  url?: string;
  title?: string | null;
  isPrivate?: number;
  liveness?: string | null;
  livenessJson?: string | null;
  pageCount: number; // visited pages in this subtree (incl. self)
  children: OutNode[];
}

function makeNode(label: string): BuildNode {
  return { label, ownVisits: 0, repVisits: -1, lastVisited: null, isPage: false, children: new Map() };
}

/** Path segments for a URL: optional subdomain node, then each path part. */
function segmentsFor(r: Row, domain: string): string[] {
  let host = r.hostname || domain;
  let path = "";
  try {
    const u = new URL(r.url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    /* keep fallbacks */
  }
  const segs: string[] = [];
  if (host && host !== domain) segs.push(host); // subdomain grouping node
  for (const part of path.split("/")) if (part) segs.push("/" + part);
  if (segs.length === 0) segs.push("/"); // the domain's root page
  return segs;
}

function finalize(node: BuildNode): OutNode {
  const children = [...node.children.values()].map(finalize).sort((a, b) => b.visits - a.visits);
  const childVisits = children.reduce((s, c) => s + c.visits, 0);
  const childPages = children.reduce((s, c) => s + c.pageCount, 0);
  return {
    label: node.label,
    visits: node.ownVisits + childVisits,
    ownVisits: node.ownVisits,
    lastVisited: node.lastVisited,
    isPage: node.isPage,
    urlId: node.urlId,
    url: node.url,
    title: node.title,
    isPrivate: node.isPrivate,
    liveness: node.liveness,
    livenessJson: node.livenessJson,
    pageCount: (node.isPage ? 1 : 0) + childPages,
    children,
  };
}

/** GET /api/tree?domain=X — nested path tree for one registrable domain. */
tree.get("/", (c) => {
  const db = getDb();
  const domain = new URL(c.req.url).searchParams.get("domain");
  if (!domain) return c.json({ error: "domain required" }, 400);

  const rows = db
    .query<Row, [string]>(
      `SELECT u.id, u.url, u.title, u.visit_count, u.last_visited, u.is_private, u.hostname,
              e.status AS liveness, e.result_json AS liveness_json
       FROM urls u
       LEFT JOIN enrichments e ON e.url_id = u.id AND e.kind = 'liveness'
       WHERE u.domain = ?`,
    )
    .all(domain);

  const root = makeNode(domain);
  for (const r of rows) {
    let node = root;
    for (const seg of segmentsFor(r, domain)) {
      let child = node.children.get(seg);
      if (!child) {
        child = makeNode(seg);
        node.children.set(seg, child);
      }
      node = child;
    }
    // `node` is where this URL lives. Multiple URLs (query/hash variants) can
    // collapse here; sum their visits and keep the most-visited as representative.
    node.isPage = true;
    node.ownVisits += r.visit_count;
    if (r.visit_count > node.repVisits) {
      node.repVisits = r.visit_count;
      node.url = r.url;
      node.urlId = r.id;
      node.title = r.title;
      node.isPrivate = r.is_private;
      node.liveness = r.liveness;
      node.livenessJson = r.liveness_json;
    }
    if (r.last_visited && (!node.lastVisited || r.last_visited > node.lastVisited)) {
      node.lastVisited = r.last_visited;
    }
  }

  return c.json({ domain, children: finalize(root).children });
});
