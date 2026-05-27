import { useEffect, useState } from "react";
import type { DeviceRow, Filters } from "../api.ts";
import { dateInputToMs } from "../lib/format.ts";

interface Props {
  filters: Filters;
  devices: DeviceRow[];
  onChange: (f: Filters) => void;
  searchMode?: boolean; // true in the full-text Search view
}

const PRIVACY: { value: NonNullable<Filters["privacy"]>; label: string }[] = [
  { value: "all", label: "All" },
  { value: "public", label: "Public only" },
  { value: "private", label: "Private/LAN" },
];

export function FiltersBar({ filters, devices, onChange, searchMode }: Props) {
  // Debounce the free-text box so we don't refetch on every keystroke.
  const [text, setText] = useState(filters.q ?? "");
  useEffect(() => {
    const t = setTimeout(() => onChange({ ...filters, q: text || undefined }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const deviceName = (d: DeviceRow) =>
    d.label || `${d.client_id.slice(0, 6)}… (${d.visit_count.toLocaleString()})`;

  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-neutral-800 bg-neutral-900/60 px-4 py-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">
          {searchMode ? "Full-text search" : "Filter title / URL"}
        </span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={searchMode ? "search titles & URLs…" : "substring match…"}
          className="w-72 rounded bg-neutral-800 px-2 py-1 outline-none ring-1 ring-neutral-700 focus:ring-blue-600"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">Device</span>
        <select
          value={filters.device ?? ""}
          onChange={(e) => onChange({ ...filters, device: e.target.value || undefined })}
          className="rounded bg-neutral-800 px-2 py-1 ring-1 ring-neutral-700"
        >
          <option value="">All devices</option>
          {devices.map((d) => (
            <option key={d.client_id} value={d.client_id}>
              {deviceName(d)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">Visibility</span>
        <select
          value={filters.privacy ?? "all"}
          onChange={(e) =>
            onChange({ ...filters, privacy: e.target.value as Filters["privacy"] })
          }
          className="rounded bg-neutral-800 px-2 py-1 ring-1 ring-neutral-700"
        >
          {PRIVACY.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">From</span>
        <input
          type="date"
          onChange={(e) => onChange({ ...filters, from: dateInputToMs(e.target.value) })}
          className="rounded bg-neutral-800 px-2 py-1 ring-1 ring-neutral-700"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-500">To</span>
        <input
          type="date"
          onChange={(e) => onChange({ ...filters, to: dateInputToMs(e.target.value, true) })}
          className="rounded bg-neutral-800 px-2 py-1 ring-1 ring-neutral-700"
        />
      </label>

      {filters.domain && (
        <button
          onClick={() => onChange({ ...filters, domain: undefined })}
          className="rounded bg-blue-900/50 px-2 py-1 text-blue-200 ring-1 ring-blue-700 hover:bg-blue-900"
        >
          domain: {filters.domain} ✕
        </button>
      )}
    </div>
  );
}
