/**
 * Shared helpers for turning an LLM `TITLE — SUMMARY` reply into a clean label +
 * description. Used by both journey labeling and cluster (Interest Map) labeling.
 */

/** Title-case a label only when the model SHOUTED it back in all caps. */
export function tidyLabel(s: string): string {
  const label = s.trim().replace(/^["']|["']$/g, "");
  if (label && label === label.toUpperCase() && /[A-Z]/.test(label)) {
    return label.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
  }
  return label;
}

/** Parse an LLM reply into a short title + one-line description. */
export function parseLabel(raw: string): { label: string; description: string } {
  const text = raw.trim();
  const clean = (d: string) => d.trim().replace(/\s+/g, " ");
  const dash = text.match(/^(.{2,90}?)\s[—–-]\s(.+)$/s);
  if (dash) return { label: tidyLabel(dash[1]), description: clean(dash[2]) };
  const nl = text.indexOf("\n");
  if (nl > 1) return { label: tidyLabel(text.slice(0, nl)), description: clean(text.slice(nl + 1)) };
  return { label: tidyLabel(text.slice(0, 80)), description: clean(text) };
}

/** Distinct page titles (falling back to domain) in order, capped — for labeling. */
export function representativeTitles(items: { title: string | null; domain: string | null }[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const t = (it.title || it.domain || "").trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
      if (out.length >= cap) break;
    }
  }
  return out;
}

/** The most frequently occurring domain among items (null if none). */
export function topDomain(items: { domain: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const it of items) if (it.domain) counts.set(it.domain, (counts.get(it.domain) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** One LLM labeling round-trip: complete → parse → guard. Null on failure/empty. */
export async function completeLabel(
  provider: { complete(system: string, user: string): Promise<string> },
  system: string,
  user: string,
): Promise<{ label: string; description: string } | null> {
  try {
    const { label, description } = parseLabel(await provider.complete(system, user));
    return label ? { label, description } : null;
  } catch {
    return null;
  }
}
