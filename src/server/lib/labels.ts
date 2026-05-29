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
