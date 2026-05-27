/** Shared filter parsing + WHERE-clause building for the urls/domains routes. */

export interface UrlFilters {
  domain?: string;
  device?: string; // client_id
  source?: string; // ingestion provenance (browser/export)
  from?: number; // epoch ms
  to?: number; // epoch ms
  q?: string; // simple substring match on title/url (FTS handled separately)
  privacy?: "all" | "public" | "private";
}

export function parseFilters(q: URLSearchParams): UrlFilters {
  const num = (v: string | null) => (v != null && v !== "" ? Number(v) : undefined);
  const privacy = q.get("privacy");
  return {
    domain: q.get("domain") || undefined,
    device: q.get("device") || undefined,
    source: q.get("source") || undefined,
    from: num(q.get("from")),
    to: num(q.get("to")),
    q: q.get("q") || undefined,
    privacy: privacy === "public" || privacy === "private" ? privacy : "all",
  };
}

/**
 * Build a WHERE fragment + bound params for filtering the `urls` table (alias u).
 * Visit-level filters (device/date) are applied as a membership subquery so the
 * URL appears iff it has a matching visit; precomputed aggregates are still shown.
 */
export function buildWhere(f: UrlFilters): { sql: string; params: Record<string, string | number> } {
  // Hidden URLs ("ignore" rules) are excluded from every browsing view.
  const clauses: string[] = ["u.is_hidden = 0"];
  const params: Record<string, string | number> = {};

  if (f.domain) {
    clauses.push("u.domain = $domain");
    params.$domain = f.domain;
  }
  if (f.privacy === "public") clauses.push("u.is_private = 0");
  if (f.privacy === "private") clauses.push("u.is_private = 1");

  if (f.q) {
    clauses.push("(u.title LIKE $like OR u.url LIKE $like)");
    params.$like = `%${f.q}%`;
  }

  const visitClauses: string[] = [];
  if (f.device) {
    visitClauses.push("v.client_id = $device");
    params.$device = f.device;
  }
  if (f.source) {
    visitClauses.push("v.source = $source");
    params.$source = f.source;
  }
  if (f.from != null) {
    visitClauses.push("v.time_ms >= $from");
    params.$from = f.from;
  }
  if (f.to != null) {
    visitClauses.push("v.time_ms <= $to");
    params.$to = f.to;
  }
  if (visitClauses.length) {
    clauses.push(
      `u.id IN (SELECT v.url_id FROM visits v WHERE ${visitClauses.join(" AND ")})`,
    );
  }

  const sql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { sql, params };
}

const SORT_COLUMNS: Record<string, string> = {
  last_visited: "u.last_visited",
  first_visited: "u.first_visited",
  visit_count: "u.visit_count",
  title: "u.title",
  domain: "u.domain",
};

export function parseSort(q: URLSearchParams): { col: string; dir: "ASC" | "DESC" } {
  const col = SORT_COLUMNS[q.get("sort") ?? ""] ?? "u.last_visited";
  const dir = (q.get("dir") ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  return { col, dir };
}

export function parsePage(q: URLSearchParams): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 100), 1), 500);
  const offset = Math.max(Number(q.get("offset") ?? 0), 0);
  return { limit, offset };
}
