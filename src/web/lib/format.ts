export function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const DAY = 86_400_000;
export function fmtRelative(ms: number | null): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const days = Math.floor(diff / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function fmtNum(n: number | null): string {
  if (n == null) return "0";
  return n.toLocaleString();
}

/** Convert an <input type="date"> value to epoch ms (local midnight). */
export function dateInputToMs(v: string, endOfDay = false): number | undefined {
  if (!v) return undefined;
  const d = new Date(v + (endOfDay ? "T23:59:59.999" : "T00:00:00"));
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}
