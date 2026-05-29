import { useCallback, useEffect, useState } from "react";
import { api, type JourneyRow, type JourneyVisit } from "../api.ts";
import { fmtDateTime, fmtNum } from "../lib/format.ts";
import { LivenessBadge } from "./LivenessBadge.tsx";
import { ThreadcrumbButton } from "./ThreadcrumbButton.tsx";

/** "1h 23m" / "12m" / "45s" from a duration in ms. */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">{children}</span>
  );
}

/** A single expandable journey card. */
function JourneyCard({
  j,
  aiEnabled,
  threadcrumbEnabled,
  onLabeled,
}: {
  j: JourneyRow;
  aiEnabled: boolean;
  threadcrumbEnabled: boolean;
  onLabeled: (id: number, label: string, description: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [visits, setVisits] = useState<JourneyVisit[] | null>(null);
  const [labeling, setLabeling] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !visits) {
      const d = await api.journey(j.id);
      setVisits(d.visits);
    }
  };

  const nameIt = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (labeling) return;
    setLabeling(true);
    const res = await api.labelJourney(j.id);
    setLabeling(false);
    if (res.label && res.label_source === "llm") {
      onLabeled(j.id, res.label, res.description ?? "");
    }
  };

  return (
    <div className="border-b border-neutral-900">
      <div className="flex items-start gap-3 px-4 py-2.5 hover:bg-neutral-900/70">
        <button onClick={toggle} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
          <div className="flex items-center gap-2">
            <span className="text-neutral-500">{open ? "▾" : "▸"}</span>
            <span className="truncate font-medium text-neutral-100">
              {j.label || "(untitled session)"}
            </span>
            {j.label_source === "llm" && <span title="named by AI">✨</span>}
          </div>
          {j.description && (
            <span className="truncate pl-5 text-xs text-neutral-500">{j.description}</span>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pl-5">
            <Pill>{fmtNum(j.url_count)} pages</Pill>
            <Pill>{fmtNum(j.domain_count)} sites</Pill>
            <Pill>{fmtDuration(j.end_ms - j.start_ms)}</Pill>
            {j.link_hops > 0 && (
              <span
                className="rounded bg-purple-900/40 px-1.5 py-0.5 text-xs text-purple-300"
                title="links followed within the session — how deep the rabbit hole went"
              >
                🐇 {fmtNum(j.link_hops)} hops
              </span>
            )}
            {j.device_label && <Pill>{j.device_label}</Pill>}
          </div>
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-xs text-neutral-500">{fmtDateTime(j.start_ms)}</span>
          {aiEnabled && j.label_source !== "llm" && (
            <button
              onClick={nameIt}
              className="text-xs text-neutral-600 hover:text-blue-400"
              title="Name this session with AI"
            >
              {labeling ? "naming…" : "✨ name this"}
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="bg-neutral-950/60 pb-2">
          {!visits && <div className="px-10 py-2 text-xs text-neutral-500">loading…</div>}
          {visits?.map((v) => (
            <div key={v.ord} className="flex items-center gap-2 px-8 py-1">
              <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-neutral-600">
                {new Date(v.time_ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </span>
              {v.transition === "link" && (
                <span className="shrink-0 text-neutral-600" title="followed a link">
                  ↳
                </span>
              )}
              <a
                href={v.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sm text-neutral-200 hover:text-blue-400"
                title={v.url}
              >
                {v.is_private ? "🔒 " : ""}
                {v.title || v.url}
              </a>
              <LivenessBadge status={v.liveness} resultJson={v.liveness_json} />
              <ThreadcrumbButton url={v.url} isPrivate={!!v.is_private} enabled={threadcrumbEnabled} compact />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function JourneysView({
  aiEnabled,
  threadcrumbEnabled,
}: {
  aiEnabled: boolean;
  threadcrumbEnabled: boolean;
}) {
  const [rows, setRows] = useState<JourneyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [gap, setGap] = useState(30);
  const [building, setBuilding] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    return api
      .journeys({ limit: 200 })
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const build = async () => {
    if (building) return;
    setBuilding(true);
    await api.buildJourneys({ gapMinutes: gap }).catch(() => {});
    await refresh();
    setBuilding(false);
  };

  const onLabeled = (id: number, label: string, description: string) =>
    setRows((rs) =>
      rs.map((r) => (r.id === id ? { ...r, label, description, label_source: "llm" } : r)),
    );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-900 px-4 py-2 text-xs text-neutral-500">
        <span>
          {fmtNum(total)} research session{total === 1 ? "" : "s"} — bursts of browsing with no long pause
        </span>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-neutral-400">
          gap
          <input
            type="number"
            min={5}
            max={240}
            value={gap}
            onChange={(e) => setGap(Math.max(5, Math.min(240, Number(e.target.value) || 30)))}
            className="w-14 rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-200 outline-none focus:ring-1 focus:ring-blue-600"
          />
          min
        </label>
        <button
          onClick={build}
          disabled={building}
          className="rounded bg-blue-700 px-2.5 py-1 text-white hover:bg-blue-600 disabled:opacity-50"
        >
          {building ? "building…" : total ? "Rebuild" : "Build"}
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {rows.map((j) => (
          <JourneyCard
            key={j.id}
            j={j}
            aiEnabled={aiEnabled}
            threadcrumbEnabled={threadcrumbEnabled}
            onLabeled={onLabeled}
          />
        ))}
        {loaded && rows.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-neutral-500">
            No research sessions yet. Click <span className="text-neutral-300">Build</span> to detect
            them from your visit history.
          </div>
        )}
      </div>
    </div>
  );
}
