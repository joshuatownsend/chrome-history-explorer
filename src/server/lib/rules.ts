/**
 * User-defined privacy/ignore rules. Stored in the `settings` table; applied on
 * top of the built-in localhost/LAN detection by recomputing the urls flags.
 *
 * Pattern syntax (matched against hostname, case-insensitive):
 *   - bare domain  e.g. "example.com"  → matches the host AND any subdomain
 *   - glob with *  e.g. "*.corp.net", "10.0.*"  → wildcard match
 */
import type { Database } from "bun:sqlite";
import { parseUrl } from "./domain.ts";

export interface PrivacyRules {
  privatePatterns: string[]; // treat as private (skip liveness/AI, lock icon)
  hiddenPatterns: string[]; // hide from all browsing views
}

const KEY = "privacy_rules";
const EMPTY: PrivacyRules = { privatePatterns: [], hiddenPatterns: [] };

export function getRules(db: Database): PrivacyRules {
  const row = db.query("SELECT value FROM settings WHERE key=?").get(KEY) as
    | { value: string }
    | undefined;
  if (!row) return EMPTY;
  try {
    const p = JSON.parse(row.value) as Partial<PrivacyRules>;
    return { privatePatterns: p.privatePatterns ?? [], hiddenPatterns: p.hiddenPatterns ?? [] };
  } catch {
    return EMPTY;
  }
}

function clean(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const s = v.trim().toLowerCase();
    if (s) seen.add(s);
  }
  return [...seen].slice(0, 1000);
}

export function setRules(db: Database, rules: Partial<PrivacyRules>): PrivacyRules {
  const value: PrivacyRules = {
    privatePatterns: clean(rules.privatePatterns),
    hiddenPatterns: clean(rules.hiddenPatterns),
  };
  db.query(
    "INSERT INTO settings(key,value) VALUES($k,$v) ON CONFLICT(key) DO UPDATE SET value=$v",
  ).run({ $k: KEY, $v: JSON.stringify(value) });
  return value;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function hostMatches(hostname: string | null, patterns: string[]): boolean {
  if (!hostname || !patterns.length) return false;
  const h = hostname.toLowerCase();
  return patterns.some((p) =>
    p.includes("*") ? globToRegExp(p).test(h) : h === p || h.endsWith("." + p),
  );
}

export interface RecomputeResult {
  privateCount: number;
  hiddenCount: number;
  changed: number;
}

/**
 * Recompute is_private / is_hidden for every URL: built-in privacy OR a user
 * private rule → private; a user hidden rule → hidden. Only writes changed rows.
 */
export function recomputePrivacy(db: Database, rules: PrivacyRules = getRules(db)): RecomputeResult {
  const rows = db
    .query<{ id: number; url: string; hostname: string | null; is_private: number; is_hidden: number }, []>(
      "SELECT id, url, hostname, is_private, is_hidden FROM urls",
    )
    .all();
  const upd = db.query("UPDATE urls SET is_private=$p, is_hidden=$h WHERE id=$id");

  let changed = 0,
    privateCount = 0,
    hiddenCount = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const builtIn = parseUrl(r.url).isPrivate;
      const isPriv = builtIn || hostMatches(r.hostname, rules.privatePatterns) ? 1 : 0;
      const isHid = hostMatches(r.hostname, rules.hiddenPatterns) ? 1 : 0;
      if (isPriv) privateCount++;
      if (isHid) hiddenCount++;
      if (isPriv !== r.is_private || isHid !== r.is_hidden) {
        upd.run({ $p: isPriv, $h: isHid, $id: r.id });
        changed++;
      }
    }
  });
  tx();
  return { privateCount, hiddenCount, changed };
}
