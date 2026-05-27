import { useEffect, useState } from "react";
import { api, type DetectedProfile } from "../api.ts";
import { fmtDate, fmtNum } from "../lib/format.ts";

export function ImportView({ onImported }: { onImported: () => void }) {
  const [profiles, setProfiles] = useState<DetectedProfile[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const detect = () => {
    setProfiles(null);
    setStatus(null);
    api.detectProfiles().then((r) => setProfiles(r.profiles)).catch(() => setProfiles([]));
  };
  useEffect(detect, []);

  const toggle = (label: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });

  const run = async () => {
    if (!selected.size) return;
    setRunning(true);
    setStatus(null);
    try {
      const res = await api.runImport([...selected]);
      const errs = res.results.filter((r) => r.error);
      setStatus(
        `Imported ${fmtNum(res.totalInserted)} new visits from ${res.results.length - errs.length} profile(s)` +
          (errs.length ? `; ${errs.length} failed (${errs.map((e) => e.label).join(", ")})` : "") +
          ". Reload other views to see the merged data.",
      );
      setSelected(new Set());
      detect(); // refresh counts
      onImported();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 overflow-auto p-6">
      <div>
        <h2 className="text-base font-semibold text-neutral-100">Import local browser history</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Detected history databases from browsers installed on this machine. Pick the profiles to
          import — visits merge into your existing data and dedupe by URL + time, so re-importing or
          overlapping a Takeout export won't double-count. Reading happens on a copy, so it's safe to
          leave the browser open.
        </p>
      </div>

      {profiles === null && <p className="text-sm text-neutral-500">Scanning for browser profiles…</p>}
      {profiles?.length === 0 && (
        <p className="text-sm text-neutral-500">No local browser profiles found on this machine.</p>
      )}

      {profiles && profiles.length > 0 && (
        <>
          <div className="overflow-hidden rounded-lg border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900/60 text-xs text-neutral-500">
                <tr>
                  <th className="w-8 p-2"></th>
                  <th className="p-2 text-left">Profile</th>
                  <th className="p-2 text-left">Browser</th>
                  <th className="p-2 text-right">Visits</th>
                  <th className="p-2 text-right">Last visit</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr
                    key={p.label}
                    className="cursor-pointer border-t border-neutral-900 hover:bg-neutral-900/50"
                    onClick={() => toggle(p.label)}
                  >
                    <td className="p-2 text-center">
                      <input type="checkbox" checked={selected.has(p.label)} readOnly />
                    </td>
                    <td className="p-2 font-mono text-xs text-neutral-200">{p.label}</td>
                    <td className="p-2 text-neutral-400">{p.browser}</td>
                    <td className="p-2 text-right tabular-nums text-neutral-300">{fmtNum(p.visitCount ?? 0)}</td>
                    <td className="p-2 text-right text-neutral-500">{fmtDate(p.lastVisitMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={run}
              disabled={running || selected.size === 0}
              className="rounded bg-blue-700 px-4 py-1.5 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
            >
              {running ? "Importing…" : `Import ${selected.size || ""} selected`}
            </button>
            <button onClick={detect} disabled={running} className="text-xs text-neutral-400 hover:text-neutral-200">
              rescan
            </button>
          </div>
        </>
      )}

      {status && <p className="text-sm text-green-400">{status}</p>}
    </div>
  );
}
