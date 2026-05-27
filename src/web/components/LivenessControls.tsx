import { useEffect, useRef, useState } from "react";
import { api, type Filters } from "../api.ts";
import { fmtNum } from "../lib/format.ts";

type Status = Awaited<ReturnType<typeof api.livenessStatus>>;

export function LivenessControls({ filters }: { filters: Filters }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refresh = () => api.livenessStatus().then(setStatus).catch(() => {});

  useEffect(() => {
    void refresh();
    poll.current = setInterval(refresh, 2000);
    return () => clearInterval(poll.current);
  }, []);

  const run = async (scope: "top" | "recent" | "domain", opts: object) => {
    setBusy(true);
    try {
      await api.livenessBatch(scope, opts);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const inFlight = (status?.counts.pending ?? 0) + (status?.counts.running ?? 0);
  const s = status?.states ?? {};

  const Btn = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
    <button
      onClick={onClick}
      disabled={busy}
      className="rounded bg-neutral-800 px-2 py-1 text-xs ring-1 ring-neutral-700 hover:bg-neutral-700 disabled:opacity-50"
    >
      {children}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-neutral-900 bg-neutral-950/60 px-4 py-1.5 text-xs">
      <span className="text-neutral-500">Liveness:</span>
      <Btn onClick={() => run("top", { n: 500 })}>Check top 500</Btn>
      <Btn onClick={() => run("recent", { days: 30 })}>Last 30 days</Btn>
      {filters.domain && (
        <Btn onClick={() => run("domain", { domain: filters.domain })}>
          Check {filters.domain}
        </Btn>
      )}

      <span className="ml-auto flex items-center gap-2 text-neutral-400">
        {inFlight > 0 && <span className="text-blue-400">checking {fmtNum(inFlight)}…</span>}
        {s.live ? <span className="text-green-400">{fmtNum(s.live)} live</span> : null}
        {s.dead ? <span className="text-red-400">{fmtNum(s.dead)} dead</span> : null}
        {s.blocked ? <span className="text-purple-400">{fmtNum(s.blocked)} blocked</span> : null}
        {s.error ? <span className="text-orange-400">{fmtNum(s.error)} err</span> : null}
        <span className="text-neutral-600">/ {fmtNum(status?.total_public ?? 0)} public</span>
      </span>
    </div>
  );
}
