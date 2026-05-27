import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, type Filters, type UrlRow } from "../api.ts";
import { fmtNum, fmtRelative } from "../lib/format.ts";
import { LivenessBadge } from "./LivenessBadge.tsx";
import { useLazyLiveness } from "../lib/useLazyLiveness.ts";

const PAGE = 150;

type SortKey = "last_visited" | "visit_count" | "title" | "domain";
const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: "title", label: "Page", className: "flex-1 min-w-0" },
  { key: "domain", label: "Domain", className: "w-44 shrink-0" },
  { key: "visit_count", label: "Visits", className: "w-20 shrink-0 text-right" },
  { key: "last_visited", label: "Last visit", className: "w-28 shrink-0 text-right" },
];

interface Props {
  filters: Filters;
  onPickDomain: (domain: string) => void;
}

export function HistoryTable({ filters, onPickDomain }: Props) {
  const [rows, setRows] = useState<UrlRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<SortKey>("last_visited");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(
    async (offset: number, replace: boolean) => {
      setLoading(true);
      try {
        const page = await api.urls(filters, sort, dir, PAGE, offset);
        setTotal(page.total);
        setRows((prev) => (replace ? page.rows : [...prev, ...page.rows]));
      } finally {
        setLoading(false);
      }
    },
    [filters, sort, dir],
  );

  // Reset + refetch whenever filters or sort change.
  useEffect(() => {
    void fetchPage(0, true);
  }, [fetchPage]);

  const liveness = useLazyLiveness(rows);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 12,
  });

  // Load more when the last virtual item nears the end.
  const items = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = items[items.length - 1];
    if (!last) return;
    if (last.index >= rows.length - 20 && rows.length < total && !loading) {
      void fetchPage(rows.length, false);
    }
  }, [items, rows.length, total, loading, fetchPage]);

  const toggleSort = (key: SortKey) => {
    if (key === sort) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSort(key);
      setDir(key === "title" || key === "domain" ? "asc" : "desc");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-neutral-500">
        <span>{fmtNum(total)} URLs</span>
        {loading && <span className="text-blue-400">loading…</span>}
      </div>

      {/* header */}
      <div className="flex gap-3 border-b border-neutral-800 px-4 py-2 text-xs font-medium text-neutral-400">
        {COLUMNS.map((col) => (
          <button
            key={col.key}
            onClick={() => toggleSort(col.key)}
            className={`${col.className} text-left hover:text-neutral-100`}
          >
            {col.label}
            {sort === col.key && <span className="ml-1">{dir === "desc" ? "↓" : "↑"}</span>}
          </button>
        ))}
        <span className="w-24 shrink-0 text-right">Status</span>
      </div>

      {/* virtualized body */}
      <div ref={parentRef} className="flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {items.map((vi) => {
            const r = rows[vi.index];
            return (
              <div
                key={r.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`,
                }}
                className="flex items-center gap-3 border-b border-neutral-900 px-4 hover:bg-neutral-900/70"
              >
                <div className="min-w-0 flex-1">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-neutral-100 hover:text-blue-400"
                    title={r.title || r.url}
                  >
                    {r.title || r.url}
                  </a>
                  <div className="truncate text-xs text-neutral-500" title={r.url}>
                    {r.url}
                  </div>
                </div>
                <button
                  onClick={() => r.domain && onPickDomain(r.domain)}
                  className="w-44 shrink-0 truncate text-left text-xs text-neutral-400 hover:text-blue-400"
                  title={r.domain ?? ""}
                >
                  {r.is_private ? "🔒 " : ""}
                  {r.domain}
                </button>
                <div className="w-20 shrink-0 text-right text-sm tabular-nums">
                  {fmtNum(r.visit_count)}
                  {r.device_count > 1 && (
                    <span className="ml-1 text-xs text-neutral-600" title={`${r.device_count} devices`}>
                      ×{r.device_count}
                    </span>
                  )}
                </div>
                <div className="w-28 shrink-0 text-right text-xs text-neutral-400">
                  {fmtRelative(r.last_visited)}
                </div>
                <div className="w-24 shrink-0 text-right">
                  <LivenessBadge
                    status={liveness.get(r.id)?.status ?? r.liveness}
                    resultJson={liveness.get(r.id)?.result_json ?? r.liveness_json}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
