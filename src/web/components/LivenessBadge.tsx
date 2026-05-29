interface Props {
  status: string | null; // enrichments.status for kind='liveness'
  resultJson: string | null;
}

/** Compact live/dead/skipped indicator. Populated by the Phase 4 liveness job. */
export function LivenessBadge({ status, resultJson }: Props) {
  if (!status) return <span className="text-neutral-600">—</span>;

  let state = status;
  let archived: string | undefined;
  let code: number | undefined;
  try {
    if (resultJson) {
      const r = JSON.parse(resultJson);
      state = r.state ?? status;
      archived = r.archived_url;
      code = r.status_code;
    }
  } catch {
    /* ignore */
  }

  const map: Record<string, string> = {
    live: "bg-green-900/60 text-green-300 ring-green-700",
    dead: "bg-red-900/60 text-red-300 ring-red-700",
    blocked: "bg-purple-900/50 text-purple-300 ring-purple-700",
    "rate-limited": "bg-amber-900/50 text-amber-300 ring-amber-700",
    error: "bg-orange-900/50 text-orange-300 ring-orange-700",
    skipped: "bg-neutral-800 text-neutral-400 ring-neutral-700",
    pending: "bg-yellow-900/50 text-yellow-300 ring-yellow-700",
    running: "bg-blue-900/50 text-blue-300 ring-blue-700",
    failed: "bg-orange-900/50 text-orange-300 ring-orange-700",
  };
  const cls = map[state] ?? map.skipped;

  return (
    <span className="inline-flex items-center gap-1">
      <span className={`rounded-sm px-1.5 py-0.5 text-xs ring-1 ${cls}`} title={code ? `HTTP ${code}` : state}>
        {state}
      </span>
      {state === "dead" && archived && (
        <a
          href={archived}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-400 underline hover:text-blue-300"
          onClick={(e) => e.stopPropagation()}
        >
          archived
        </a>
      )}
    </span>
  );
}
