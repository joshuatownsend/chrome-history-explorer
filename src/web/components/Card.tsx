import type { ReactNode } from "react";

/** Bordered dashboard/insights card with a title and an optional hint line. */
export function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <h2 className={`text-xs font-semibold uppercase tracking-wide text-neutral-500 ${hint ? "mb-1" : "mb-3"}`}>
        {title}
      </h2>
      {hint && <p className="mb-3 text-[11px] text-neutral-600">{hint}</p>}
      {children}
    </div>
  );
}
