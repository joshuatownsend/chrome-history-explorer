import { Fragment } from "react";

/** Highlights query-term prefixes within text (matches FTS5 prefix semantics). */
export function Highlight({ text, query }: { text: string | null; query: string }) {
  const value = text ?? "";
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length || !value) return <>{value}</>;

  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const splitRe = new RegExp(`(${escaped.join("|")})`, "gi");
  const testRe = new RegExp(`^(?:${escaped.join("|")})$`, "i");
  const parts = value.split(splitRe);

  return (
    <>
      {parts.map((p, i) =>
        testRe.test(p) ? (
          <mark key={i} className="rounded-sm bg-yellow-500/30 text-yellow-100">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
