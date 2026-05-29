import { useEffect, useState } from "react";
import {
  api,
  type GraveyardRow,
  type OnThisDayRow,
  type OpenLoopRow,
  type RecurringRow,
  type Rhythm,
  type UrlRow,
} from "../api.ts";
import { fmtNum, fmtRelative } from "../lib/format.ts";
import { ThreadcrumbButton } from "./ThreadcrumbButton.tsx";

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
      {hint && <p className="mb-3 text-[11px] text-neutral-600">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </div>
  );
}

const HOUR_LABEL = (h: number | null) =>
  h == null ? "—" : `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;

const CADENCE_TONE: Record<string, string> = {
  daily: "bg-green-900/50 text-green-300",
  weekly: "bg-blue-900/50 text-blue-300",
  monthly: "bg-purple-900/50 text-purple-300",
};

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-neutral-500">{children}</p>;
}

export function InsightsView({ threadcrumbEnabled }: { threadcrumbEnabled: boolean }) {
  const [otd, setOtd] = useState<OnThisDayRow[]>([]);
  const [rediscovery, setRediscovery] = useState<UrlRow[]>([]);
  const [rhythm, setRhythm] = useState<Rhythm | null>(null);
  const [recurring, setRecurring] = useState<RecurringRow[]>([]);
  const [openLoops, setOpenLoops] = useState<OpenLoopRow[]>([]);
  const [graveyard, setGraveyard] = useState<GraveyardRow[]>([]);

  useEffect(() => {
    api.onThisDay().then((r) => setOtd(r.rows)).catch(() => {});
    api.rediscovery().then((r) => setRediscovery(r.rows)).catch(() => {});
    api.rhythm().then(setRhythm).catch(() => {});
    api.recurring().then((r) => setRecurring(r.rows)).catch(() => {});
    api.openLoops().then((r) => setOpenLoops(r.rows)).catch(() => {});
    api.graveyard().then((r) => setGraveyard(r.rows)).catch(() => {});
  }, []);

  // Group "on this day" by year, newest first.
  const otdByYear = new Map<number, OnThisDayRow[]>();
  for (const r of otd) (otdByYear.get(r.yr) ?? otdByYear.set(r.yr, []).get(r.yr)!).push(r);
  const years = [...otdByYear.keys()].sort((a, b) => b - a);

  const archivedOf = (j: string | null) => {
    try {
      return j ? (JSON.parse(j).archived_url as string | undefined) : undefined;
    } catch {
      return undefined;
    }
  };

  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card title="On this day" hint="What you were browsing on this date in years past">
          {years.length === 0 ? (
            <Empty>Nothing recorded on this calendar day yet.</Empty>
          ) : (
            <div className="space-y-3">
              {years.map((yr) => (
                <div key={yr}>
                  <div className="mb-1 text-xs font-medium text-neutral-400">{yr}</div>
                  <ul className="space-y-1 text-sm">
                    {otdByYear.get(yr)!.slice(0, 6).map((r) => (
                      <li key={r.id} className="flex items-center gap-2">
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex-1 truncate text-neutral-200 hover:text-blue-400"
                          title={r.url}
                        >
                          {r.is_private ? "🔒 " : ""}
                          {r.title || r.domain || r.url}
                        </a>
                        <span className="shrink-0 tabular-nums text-neutral-600">{r.day_visits}×</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Forgotten gems" hint="Pages you visited a lot but haven't returned to in months">
          {rediscovery.length === 0 ? (
            <Empty>No dormant favorites found.</Empty>
          ) : (
            <ol className="space-y-1 text-sm">
              {rediscovery.slice(0, 12).map((u) => (
                <li key={u.id} className="flex items-center gap-2">
                  <a
                    href={u.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 truncate text-neutral-200 hover:text-blue-400"
                    title={u.url}
                  >
                    {u.title || u.domain || u.url}
                  </a>
                  <span className="shrink-0 tabular-nums text-neutral-500">{fmtNum(u.visit_count)}×</span>
                  <span className="shrink-0 text-xs text-neutral-600">{fmtRelative(u.last_visited)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title="Your rhythm" hint="When you browse, and how deep you go">
          {!rhythm ? (
            <Empty>Loading…</Empty>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-400">Peak hour</span>
                <span className="text-neutral-200">{HOUR_LABEL(rhythm.peak_hour)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Night owl (10pm–5am)</span>
                <span className="text-neutral-200">
                  {Math.round((rhythm.night_owl_share / (rhythm.total_visits || 1)) * 100)}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Work hours (9–6)</span>
                <span className="text-neutral-200">
                  {Math.round((rhythm.work_share / (rhythm.total_visits || 1)) * 100)}%
                </span>
              </div>
              <div className="mt-2 border-t border-neutral-800 pt-2 text-xs text-neutral-500">
                {fmtNum(rhythm.journeys.count)} research sessions · deepest{" "}
                <span className="text-purple-300">🐇 {rhythm.journeys.deepest_hops} hops</span> · avg{" "}
                {rhythm.journeys.avg_pages} pages
              </div>
            </div>
          )}
        </Card>

        <Card title="Your routine" hint="Sites you return to on a regular cadence">
          {recurring.length === 0 ? (
            <Empty>No recurring visits detected yet.</Empty>
          ) : (
            <ul className="space-y-1 text-sm">
              {recurring.slice(0, 12).map((r) => (
                <li key={r.domain} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-neutral-200">{r.domain}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${CADENCE_TONE[r.cadence] ?? ""}`}>
                    {r.cadence}
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-neutral-600">{r.days}d</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Pick back up" hint="Research sessions that stalled — worth revisiting">
          {openLoops.length === 0 ? (
            <Empty>No stalled sessions. (Build Research Sessions first.)</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {openLoops.slice(0, 8).map((o) => (
                <li key={o.id} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <a
                      href={o.entry_url ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-neutral-200 hover:text-blue-400"
                      title={o.description ?? undefined}
                    >
                      {o.label || "(untitled)"}
                    </a>
                    <span className="text-xs text-neutral-600">
                      {o.url_count} pages · {fmtRelative(o.end_ms)}
                    </span>
                  </div>
                  {o.entry_url && (
                    <ThreadcrumbButton
                      url={o.entry_url}
                      isPrivate={!!o.entry_private}
                      enabled={threadcrumbEnabled}
                      compact
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Graveyard" hint="High-value pages that have since gone dead">
          {graveyard.length === 0 ? (
            <Empty>No dead links found. (Run a liveness check in the URL views.)</Empty>
          ) : (
            <ol className="space-y-1 text-sm">
              {graveyard.slice(0, 12).map((g) => {
                const archived = archivedOf(g.result_json);
                return (
                  <li key={g.id} className="flex items-center gap-2">
                    <span className="flex-1 truncate text-neutral-400 line-through" title={g.url}>
                      {g.title || g.domain || g.url}
                    </span>
                    {archived && (
                      <a
                        href={archived}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-xs text-blue-400 hover:text-blue-300"
                      >
                        archived
                      </a>
                    )}
                    <span className="shrink-0 tabular-nums text-neutral-600">{fmtNum(g.visit_count)}×</span>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}
