import { useCallback, useEffect, useState } from "react";
import { api, type ClusterMember, type ClusterRow, type TrendRow } from "../api.ts";
import { fmtNum, fmtRelative } from "../lib/format.ts";
import { LivenessBadge } from "./LivenessBadge.tsx";

function TrendBadge({ t }: { t?: TrendRow }) {
  if (!t) return null;
  if (t.pct == null)
    return <span className="rounded-sm bg-emerald-900/50 px-1.5 py-0.5 text-[11px] text-emerald-300">new</span>;
  if (t.pct === 0) return null;
  const up = t.pct > 0;
  return (
    <span
      className={`rounded-sm px-1.5 py-0.5 text-[11px] ${up ? "bg-green-900/50 text-green-300" : "bg-red-900/50 text-red-300"}`}
      title={`${t.recent} visits last 90d vs ${t.prior} prior`}
    >
      {up ? "↑" : "↓"} {Math.abs(t.pct)}%
    </span>
  );
}

function ClusterCard({
  c,
  trend,
  max,
}: {
  c: ClusterRow;
  trend?: TrendRow;
  max: number;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<ClusterMember[] | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !members) setMembers((await api.cluster(c.id, 60)).members);
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40">
      <button onClick={toggle} className="flex w-full items-start gap-3 p-3 text-left hover:bg-neutral-900/70">
        <span className="mt-0.5 text-neutral-500">{open ? "▾" : "▸"}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-neutral-100">{c.label || "(unlabeled)"}</span>
            {c.label_source === "llm" && <span title="named by AI">✨</span>}
            <TrendBadge t={trend} />
          </div>
          {c.description && <div className="truncate text-xs text-neutral-500">{c.description}</div>}
          {c.top_domains && <div className="mt-0.5 truncate text-[11px] text-neutral-600">{c.top_domains}</div>}
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-neutral-800">
              <div className="h-full bg-blue-600/70" style={{ width: `${(c.size / max) * 100}%` }} />
            </div>
            <span className="shrink-0 tabular-nums text-xs text-neutral-500">{fmtNum(c.size)}</span>
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-neutral-800 px-3 pb-2 pt-1">
          {!members && <div className="py-2 text-xs text-neutral-500">loading…</div>}
          {members?.map((m) => (
            <div key={m.url_id} className="flex items-center gap-2 py-1">
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sm text-neutral-300 hover:text-blue-400"
                title={m.url}
              >
                {m.is_private ? "🔒 " : ""}
                {m.title || m.url}
              </a>
              <LivenessBadge status={m.liveness} resultJson={m.liveness_json} />
              <span className="shrink-0 text-xs text-neutral-600">{fmtRelative(m.last_visited)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function InterestMapView({
  embedEnabled,
}: {
  embedEnabled: boolean;
}) {
  const [clusters, setClusters] = useState<ClusterRow[]>([]);
  const [trends, setTrends] = useState<Map<number, TrendRow>>(new Map());
  const [busy, setBusy] = useState<"" | "build" | "embed">("");
  const [toast, setToast] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const [cl, tr] = await Promise.all([api.clusters().catch(() => ({ rows: [] })), api.clusterTrends().catch(() => ({ rows: [] }))]);
    setClusters(cl.rows);
    setTrends(new Map(tr.rows.map((t) => [t.cluster_id, t])));
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 4000);
  };

  const build = async () => {
    setBusy("build");
    const r = await api.buildClusters().catch(() => null);
    setBusy("");
    if (r?.note) flash(r.note);
    else if (r) flash(`Built ${r.clusters} clusters from ${fmtNum(r.embedded)} pages (${r.labeled} named).`);
    await refresh();
  };

  const embedAll = async () => {
    setBusy("embed");
    const r = await api.buildEmbeddings("all").catch(() => null);
    setBusy("");
    if (r?.error) flash(r.error);
    else if (r) flash(`Embedded ${fmtNum(r.embedded ?? 0)} new pages (${fmtNum(r.skipped ?? 0)} already done). Now Build the map.`);
  };

  const max = Math.max(1, ...clusters.map((c) => c.size));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-900 px-4 py-2 text-xs text-neutral-500">
        <span>
          {clusters.length
            ? `${clusters.length} interest clusters across ${fmtNum(clusters.reduce((a, c) => a + c.size, 0))} pages`
            : "Group your history into topics by meaning"}
        </span>
        <span className="flex-1" />
        {embedEnabled && (
          <button
            onClick={embedAll}
            disabled={busy !== ""}
            className="rounded-sm bg-neutral-800 px-2.5 py-1 text-neutral-200 hover:bg-neutral-700 disabled:opacity-50"
            title="Embed every public page so the map covers your whole history (uses your OpenAI key)"
          >
            {busy === "embed" ? "embedding…" : "Embed all pages"}
          </button>
        )}
        <button
          onClick={build}
          disabled={busy !== ""}
          className="rounded-sm bg-blue-700 px-2.5 py-1 text-white hover:bg-blue-600 disabled:opacity-50"
        >
          {busy === "build" ? "building…" : clusters.length ? "Rebuild map" : "Build map"}
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {loaded && clusters.length === 0 ? (
          <div className="mx-auto max-w-md py-10 text-center text-sm text-neutral-500">
            No interest map yet. {embedEnabled ? "Embed your pages, then " : ""}click{" "}
            <span className="text-neutral-300">Build map</span> to group your history into topics.
            {!embedEnabled && (
              <p className="mt-2 text-xs text-neutral-600">
                Semantic clustering needs embeddings — set an OpenAI key to enable it.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {clusters.map((c) => (
              <ClusterCard key={c.id} c={c} trend={trends.get(c.id)} max={max} />
            ))}
          </div>
        )}
      </div>

      {toast && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-sm bg-neutral-800 px-4 py-2 text-sm text-neutral-100 shadow-lg ring-1 ring-neutral-700">
          {toast}
        </div>
      )}
    </div>
  );
}
