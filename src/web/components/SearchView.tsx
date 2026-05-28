import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Filters, type UrlRow } from "../api.ts";
import { fmtNum, fmtRelative } from "../lib/format.ts";
import { Highlight } from "./Highlight.tsx";
import { LivenessBadge } from "./LivenessBadge.tsx";
import { SummaryButton } from "./SummaryButton.tsx";
import { ThreadcrumbButton } from "./ThreadcrumbButton.tsx";
import { useLazyLiveness } from "../lib/useLazyLiveness.ts";

const PAGE = 50;

interface SearchResponse {
  total: number;
  rows: UrlRow[];
  query: string;
}

interface Props {
  filters: Filters;
  onPickDomain: (domain: string) => void;
  aiSummarize: boolean;
  aiSemantic: boolean;
  threadcrumbEnabled: boolean;
}

function buildQs(f: Filters, limit: number, offset: number): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  sp.set("limit", String(limit));
  sp.set("offset", String(offset));
  return sp.toString();
}

export function SearchView({ filters, onPickDomain, aiSummarize, aiSemantic, threadcrumbEnabled }: Props) {
  const [rows, setRows] = useState<UrlRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [semantic, setSemantic] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const q = filters.q?.trim() ?? "";
  const seq = useRef(0);
  const liveness = useLazyLiveness(rows);

  const fetchPage = useCallback(
    async (offset: number, replace: boolean) => {
      if (!q) {
        setRows([]);
        setTotal(0);
        setNote(null);
        return;
      }
      const mine = ++seq.current;
      setLoading(true);
      try {
        if (semantic) {
          const data = await api.semanticSearch(q, 50);
          if (mine !== seq.current) return;
          setNote(data.error ?? data.note ?? null);
          setRows(data.rows ?? []);
          setTotal(data.rows?.length ?? 0);
        } else {
          const r = await fetch(`/api/search?${buildQs(filters, PAGE, offset)}`);
          const data = (await r.json()) as SearchResponse;
          if (mine !== seq.current) return; // stale response, ignore
          setNote(null);
          setTotal(data.total);
          setRows((prev) => (replace ? data.rows : [...prev, ...data.rows]));
        }
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [filters, q, semantic],
  );

  useEffect(() => {
    void fetchPage(0, true);
  }, [fetchPage]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-4 py-1.5 text-xs text-neutral-500">
        {q ? (
          <span>
            {fmtNum(total)} {semantic ? "semantic" : ""} matches for “{q}”{" "}
            {loading && <span className="text-blue-400">…</span>}
          </span>
        ) : (
          <span>Type in the box above to search.</span>
        )}
        {aiSemantic && (
          <label className="ml-auto flex items-center gap-1.5 text-neutral-400">
            <input
              type="checkbox"
              checked={semantic}
              onChange={(e) => setSemantic(e.target.checked)}
            />
            Semantic search
          </label>
        )}
      </div>
      {note && <div className="px-4 py-1 text-xs text-amber-400">{note}</div>}
      <div className="flex-1 overflow-auto">
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex items-center gap-3 border-b border-neutral-900 px-4 py-2 hover:bg-neutral-900/70"
          >
            <div className="min-w-0 flex-1">
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-neutral-100 hover:text-blue-400"
                title={r.title || r.url}
              >
                <Highlight text={r.title || r.url} query={q} />
              </a>
              <div className="truncate text-xs text-neutral-500" title={r.url}>
                <Highlight text={r.url} query={q} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <ThreadcrumbButton url={r.url} isPrivate={!!r.is_private} enabled={threadcrumbEnabled} />
                <SummaryButton urlId={r.id} isPrivate={!!r.is_private} enabled={aiSummarize} />
              </div>
            </div>
            <button
              onClick={() => r.domain && onPickDomain(r.domain)}
              className="w-44 shrink-0 truncate text-left text-xs text-neutral-400 hover:text-blue-400"
            >
              {r.is_private ? "🔒 " : ""}
              {r.domain}
            </button>
            <div className="w-16 shrink-0 text-right text-sm tabular-nums">{fmtNum(r.visit_count)}</div>
            <div className="w-24 shrink-0 text-right text-xs text-neutral-400">
              {fmtRelative(r.last_visited)}
            </div>
            <div className="w-24 shrink-0 text-right">
              <LivenessBadge
                status={liveness.get(r.id)?.status ?? r.liveness}
                resultJson={liveness.get(r.id)?.result_json ?? r.liveness_json}
              />
            </div>
          </div>
        ))}
        {rows.length < total && (
          <button
            onClick={() => void fetchPage(rows.length, false)}
            disabled={loading}
            className="w-full py-3 text-sm text-blue-400 hover:bg-neutral-900 disabled:opacity-50"
          >
            Load more ({fmtNum(total - rows.length)} remaining)
          </button>
        )}
      </div>
    </div>
  );
}
