import { useEffect, useState } from "react";
import { api, type DeviceRow, type JourneyRow, type OnThisDayRow, type Stats } from "../api.ts";
import { fmtDate, fmtNum } from "../lib/format.ts";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Inline-editable device label. Saves on blur/Enter, then refreshes app state. */
function DeviceLabelRow({ device, onSaved }: { device: DeviceRow; onSaved: () => void }) {
  const [value, setValue] = useState(device.label ?? "");
  const [saved, setSaved] = useState(false);

  const save = async () => {
    if ((value.trim() || null) === (device.label ?? null)) return;
    await api.setDeviceLabel(device.client_id, value.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    onSaved();
  };

  return (
    <li className="flex items-center justify-between gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        placeholder={`${device.client_id.slice(0, 10)}…`}
        className="min-w-0 flex-1 rounded bg-neutral-800/60 px-2 py-1 text-neutral-200 outline-none ring-1 ring-transparent focus:bg-neutral-800 focus:ring-blue-600"
      />
      {saved && <span className="text-xs text-green-400">saved</span>}
      <span className="shrink-0 tabular-nums text-neutral-500">{fmtNum(device.visit_count)}</span>
    </li>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums text-neutral-100">{value}</div>
      <div className="text-xs text-neutral-500">{label}</div>
    </div>
  );
}

/** Minimal CSS bar chart — avoids pulling in a charting dependency. */
function Bars({ data, label }: { data: { k: string; v: number }[]; label?: (k: string) => string }) {
  const max = Math.max(1, ...data.map((d) => d.v));
  return (
    <div className="flex h-32 items-stretch gap-1">
      {data.map((d) => (
        <div key={d.k} className="flex flex-1 flex-col items-center gap-1" title={`${d.k}: ${fmtNum(d.v)}`}>
          <div className="flex w-full flex-1 items-end">
            <div
              className="w-full rounded-t bg-blue-600/70 hover:bg-blue-500"
              style={{ height: `${(d.v / max) * 100}%` }}
            />
          </div>
          <span className="text-[10px] text-neutral-600">{label ? label(d.k) : d.k}</span>
        </div>
      ))}
    </div>
  );
}

export function Dashboard({
  onPickDomain,
  onOpenJourneys,
  onOpenInsights,
  devices,
  onLabelSaved,
}: {
  onPickDomain: (d: string) => void;
  onOpenJourneys: () => void;
  onOpenInsights: () => void;
  devices: DeviceRow[];
  onLabelSaved: () => void;
}) {
  const [s, setS] = useState<Stats | null>(null);
  const [journeys, setJourneys] = useState<JourneyRow[]>([]);
  const [onThisDay, setOnThisDay] = useState<OnThisDayRow[]>([]);
  useEffect(() => {
    api.stats().then(setS).catch(() => setS(null));
    api.journeys({ sort: "hops", limit: 6 }).then((r) => setJourneys(r.rows)).catch(() => setJourneys([]));
    api.onThisDay().then((r) => setOnThisDay(r.rows)).catch(() => setOnThisDay([]));
  }, []);
  if (!s) return <div className="p-8 text-neutral-500">Loading insights…</div>;

  const hasHops = journeys.some((j) => j.link_hops > 0);

  const days = Math.round((s.totals.last_visit - s.totals.first_visit) / 86_400_000);
  const hourData = Array.from({ length: 24 }, (_, h) => ({
    k: String(h),
    v: s.byHour.find((x) => x.h === h)?.n ?? 0,
  }));
  const dowData = Array.from({ length: 7 }, (_, w) => ({
    k: DOW[w],
    v: s.byDow.find((x) => x.w === w)?.n ?? 0,
  }));
  const liveTotal = s.liveness_checked;

  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {onThisDay.length > 0 && (
          <Card title="On this day — years ago">
            <ol className="space-y-1 text-sm">
              {onThisDay.slice(0, 6).map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <span className="w-10 shrink-0 text-xs text-neutral-600">{r.yr}</span>
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
                </li>
              ))}
            </ol>
            <button onClick={onOpenInsights} className="mt-2 text-xs text-blue-400 hover:text-blue-300">
              more insights →
            </button>
          </Card>
        )}

        <Card title="Overview">
          <div className="grid grid-cols-2 gap-4">
            <Stat label="visits" value={fmtNum(s.totals.visits)} />
            <Stat label="unique URLs" value={fmtNum(s.totals.urls)} />
            <Stat label="domains" value={fmtNum(s.totals.domains)} />
            <Stat label="days tracked" value={fmtNum(days)} />
            <Stat label="devices" value={fmtNum(s.totals.devices)} />
            <Stat label="private URLs" value={fmtNum(s.totals.private_urls)} />
          </div>
          <div className="mt-3 text-xs text-neutral-500">
            {fmtDate(s.totals.first_visit)} → {fmtDate(s.totals.last_visit)}
          </div>
        </Card>

        <Card title="By hour of day">
          <Bars data={hourData} label={(k) => (Number(k) % 6 === 0 ? k : "")} />
        </Card>

        <Card title="By day of week">
          <Bars data={dowData} />
        </Card>

        <Card title="Liveness">
          {liveTotal === 0 ? (
            <p className="text-sm text-neutral-500">
              No links checked yet. Use the liveness buttons in the URL views.
            </p>
          ) : (
            <div className="space-y-1.5">
              {Object.entries(s.liveness)
                .sort((a, b) => b[1] - a[1])
                .map(([state, n]) => (
                  <div key={state} className="flex items-center gap-2 text-sm">
                    <span className="w-24 text-neutral-400">{state}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-neutral-800">
                      <div
                        className="h-full bg-blue-500"
                        style={{ width: `${(n / liveTotal) * 100}%` }}
                      />
                    </div>
                    <span className="w-14 text-right tabular-nums text-neutral-400">{fmtNum(n)}</span>
                  </div>
                ))}
              <div className="pt-1 text-xs text-neutral-600">{fmtNum(liveTotal)} checked</div>
            </div>
          )}
        </Card>

        <Card title="Top domains">
          <ol className="space-y-1 text-sm">
            {s.topDomains.map((d) => (
              <li key={d.domain} className="flex items-center gap-2">
                <button
                  onClick={() => onPickDomain(d.domain)}
                  className="flex-1 truncate text-left text-neutral-200 hover:text-blue-400"
                >
                  {d.is_private ? "🔒 " : ""}
                  {d.domain}
                </button>
                <span className="tabular-nums text-neutral-500">{fmtNum(d.visits)}</span>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Most-revisited pages">
          <ol className="space-y-1 text-sm">
            {s.topUrls.map((u) => (
              <li key={u.id} className="flex items-center gap-2">
                <a
                  href={u.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 truncate text-neutral-200 hover:text-blue-400"
                  title={u.url}
                >
                  {u.title || u.url}
                </a>
                <span className="tabular-nums text-neutral-500">{fmtNum(u.visit_count)}</span>
              </li>
            ))}
          </ol>
        </Card>

        <Card title={hasHops ? "Deepest rabbit holes" : "Research sessions"}>
          {journeys.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No research sessions yet. Open{" "}
              <button onClick={onOpenJourneys} className="text-blue-400 hover:text-blue-300">
                Research Sessions
              </button>{" "}
              and click Build to detect bursts of browsing.
            </p>
          ) : (
            <ol className="space-y-1 text-sm">
              {journeys.map((j) => (
                <li key={j.id} className="flex items-center gap-2">
                  <button
                    onClick={onOpenJourneys}
                    className="flex-1 truncate text-left text-neutral-200 hover:text-blue-400"
                    title={j.description ?? undefined}
                  >
                    {j.label || "(untitled session)"}
                  </button>
                  <span className="shrink-0 tabular-nums text-neutral-500">
                    {j.link_hops > 0 ? `🐇 ${fmtNum(j.link_hops)}` : `${fmtNum(j.url_count)}p`}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title="Busiest days">
          <ol className="space-y-1 text-sm">
            {s.busiestDays.map((d) => (
              <li key={d.d} className="flex items-center justify-between">
                <span className="text-neutral-300">{d.d}</span>
                <span className="tabular-nums text-neutral-500">{fmtNum(d.n)} visits</span>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Per device — click a name to label it">
          <ol className="space-y-1 text-sm">
            {devices.map((d) => (
              <DeviceLabelRow key={d.client_id} device={d} onSaved={onLabelSaved} />
            ))}
          </ol>
          <p className="mt-2 text-[11px] text-neutral-600">
            Note: this export has no bookmarks or downloads, and transition types aren't preserved.
          </p>
        </Card>
      </div>
    </div>
  );
}
