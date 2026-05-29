import { useEffect, useState } from "react";
import { api, type SessionRow, type SessionTab } from "../api.ts";
import { fmtDateTime } from "../lib/format.ts";
import { LivenessBadge } from "./LivenessBadge.tsx";

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [expandedTab, setExpandedTab] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    api.sessions().then((s) => setSessions(s.rows)).catch(() => setSessions([]));
  }, []);

  const openSession = async (id: number) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setTabs([]);
    const s = await api.session(id);
    setTabs(s.tabs);
  };

  const reopen = async (urls: string[]) => {
    const valid = urls.filter(Boolean);
    if (valid.length > 10 && !confirm(`Reopen ${valid.length} tabs in your browser?`)) return;
    const res = await api.openUrls(valid);
    setToast(res.error ?? `Opened ${res.opened} tab${res.opened === 1 ? "" : "s"}` +
      (res.rejected ? `, skipped ${res.rejected}` : ""));
    setTimeout(() => setToast(null), 3000);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 py-1.5 text-xs text-neutral-500">
        {sessions.length} saved window{sessions.length === 1 ? "" : "s"} from your last synced session
      </div>

      <div className="flex-1 overflow-auto">
        {sessions.map((s) => (
          <div key={s.id} className="border-b border-neutral-900">
            <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-900/70">
              <button onClick={() => openSession(s.id)} className="flex flex-1 items-center gap-2 truncate text-left">
                <span className="text-neutral-500">{openId === s.id ? "▾" : "▸"}</span>
                <span className="font-medium text-neutral-100">Window</span>
                <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">
                  {s.tab_count} tab{s.tab_count === 1 ? "" : "s"}
                </span>
                <span className="truncate text-xs text-neutral-500">{s.preview}</span>
              </button>
              <span className="shrink-0 text-xs text-neutral-500">{fmtDateTime(s.last_active_ms)}</span>
              {openId === s.id && tabs.length > 0 && (
                <button
                  onClick={() => reopen(tabs.map((t) => t.current_url ?? "").filter(Boolean))}
                  className="shrink-0 rounded-sm bg-blue-700 px-2 py-1 text-xs text-white hover:bg-blue-600"
                >
                  Reopen all
                </button>
              )}
            </div>

            {openId === s.id && (
              <div className="bg-neutral-950/60 pb-2">
                {tabs.length === 0 && <div className="px-10 py-2 text-xs text-neutral-500">loading…</div>}
                {tabs.map((t) => (
                  <div key={t.id} className="px-8">
                    <div className="flex items-center gap-2 py-1">
                      {t.pinned ? <span title="pinned">📌</span> : null}
                      <a
                        href={t.current_url ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 flex-1 truncate text-sm text-neutral-200 hover:text-blue-400"
                        title={t.current_url ?? ""}
                      >
                        {t.current_title || t.current_url || "(untitled)"}
                      </a>
                      <LivenessBadge status={t.liveness} resultJson={t.liveness_json} />
                      {t.navigation.length > 1 && (
                        <button
                          onClick={() => setExpandedTab(expandedTab === t.id ? null : t.id)}
                          className="shrink-0 text-xs text-neutral-500 hover:text-neutral-300"
                        >
                          {t.navigation.length} history
                        </button>
                      )}
                      {t.current_url && (
                        <button
                          onClick={() => reopen([t.current_url!])}
                          className="shrink-0 rounded-sm px-2 py-0.5 text-xs text-blue-400 hover:bg-neutral-800"
                        >
                          open
                        </button>
                      )}
                    </div>
                    {expandedTab === t.id && (
                      <ol className="mb-1 ml-6 border-l border-neutral-800 pl-3 text-xs text-neutral-500">
                        {t.navigation.map((n) => (
                          <li
                            key={n.idx}
                            className={`truncate py-0.5 ${
                              n.idx === t.current_nav_index ? "text-neutral-300" : ""
                            }`}
                            title={n.virtual_url ?? ""}
                          >
                            {n.idx === t.current_nav_index ? "● " : "○ "}
                            {n.title || n.virtual_url}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-neutral-500">
            No saved tab sessions found in this export.
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
