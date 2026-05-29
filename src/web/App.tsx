import { useCallback, useEffect, useState } from "react";
import { api, type DeviceRow, type Filters, type SourceRow } from "./api.ts";
import { FiltersBar } from "./components/Filters.tsx";
import { HistoryTable } from "./components/HistoryTable.tsx";
import { DomainView } from "./components/DomainView.tsx";
import { SearchView } from "./components/SearchView.tsx";
import { SessionsView } from "./components/SessionsView.tsx";
import { JourneysView } from "./components/JourneysView.tsx";
import { LivenessControls } from "./components/LivenessControls.tsx";
import { Dashboard } from "./components/Dashboard.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { ImportView } from "./components/ImportView.tsx";

type View = "dashboard" | "search" | "list" | "domains" | "journeys" | "sessions" | "settings" | "import";

export function App() {
  const [view, setView] = useState<View>("dashboard");
  const [filters, setFilters] = useState<Filters>({ privacy: "all" });
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [aiSummarize, setAiSummarize] = useState(false);
  const [aiSemantic, setAiSemantic] = useState(false);
  const [threadcrumbEnabled, setThreadcrumbEnabled] = useState(false);

  const refreshDevices = useCallback(
    () => api.devices().then((d) => setDevices(d.rows)).catch(() => setDevices([])),
    [],
  );
  const refreshSources = useCallback(
    () => api.sources().then((s) => setSources(s.rows)).catch(() => setSources([])),
    [],
  );

  useEffect(() => {
    void refreshSources();
    void refreshDevices();
    api
      .aiConfig()
      .then((cfg) => {
        setAiSummarize(cfg.providers.some((p) => p.configured && p.canSummarize));
        setAiSemantic(cfg.providers.some((p) => p.configured && p.canEmbed));
      })
      .catch(() => {});
    api
      .threadcrumbConfig()
      .then((cfg) => setThreadcrumbEnabled(cfg.configured))
      .catch(() => {});
  }, [refreshDevices, refreshSources]);

  const pickDomain = (domain: string) => {
    setFilters((f) => ({ ...f, domain }));
    setView("list");
  };

  const VIEWS: { id: View; label: string }[] = [
    { id: "dashboard", label: "Dashboard" },
    { id: "search", label: "Search" },
    { id: "domains", label: "By domain" },
    { id: "list", label: "All URLs" },
    { id: "journeys", label: "Research Sessions" },
    { id: "sessions", label: "Sessions" },
    { id: "import", label: "Import" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-neutral-800 bg-neutral-900 px-4 py-2.5">
        <h1 className="text-sm font-semibold tracking-tight text-neutral-100">
          Chrome History Explorer
        </h1>
        <nav className="flex gap-1 rounded bg-neutral-800 p-0.5 text-sm">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className={`rounded px-3 py-1 ${
                view === v.id ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </header>

      {(view === "search" || view === "list" || view === "domains") && (
        <FiltersBar
          filters={filters}
          devices={devices}
          sources={sources}
          onChange={setFilters}
          searchMode={view === "search"}
        />
      )}

      {(view === "list" || view === "search") && <LivenessControls filters={filters} />}

      <main className="min-h-0 flex-1">
        {view === "dashboard" && (
          <Dashboard
            onPickDomain={pickDomain}
            onOpenJourneys={() => setView("journeys")}
            devices={devices}
            onLabelSaved={refreshDevices}
          />
        )}
        {view === "search" && (
          <SearchView
            filters={filters}
            onPickDomain={pickDomain}
            aiSummarize={aiSummarize}
            aiSemantic={aiSemantic}
            threadcrumbEnabled={threadcrumbEnabled}
          />
        )}
        {view === "list" && (
          <HistoryTable filters={filters} onPickDomain={pickDomain} threadcrumbEnabled={threadcrumbEnabled} />
        )}
        {view === "domains" && <DomainView filters={filters} onPickDomain={pickDomain} />}
        {view === "journeys" && (
          <JourneysView aiEnabled={aiSummarize} threadcrumbEnabled={threadcrumbEnabled} />
        )}
        {view === "sessions" && <SessionsView />}
        {view === "import" && <ImportView onImported={refreshSources} />}
        {view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}
