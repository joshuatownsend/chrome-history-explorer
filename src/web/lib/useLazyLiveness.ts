import { useEffect, useRef, useState } from "react";
import { api, type LivenessInfo, type UrlRow } from "../api.ts";

/**
 * Lazy on-view liveness: for the URLs currently rendered, enqueue any that lack
 * a liveness result, then poll until they resolve. Returns a map of overrides
 * (url_id -> {status, result_json}) for the UI to merge over the row's own data.
 */
export function useLazyLiveness(rows: UrlRow[]): Map<number, LivenessInfo> {
  const [overrides, setOverrides] = useState<Map<number, LivenessInfo>>(new Map());
  const requested = useRef<Set<number>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // URLs we haven't already handled and that arrived without a liveness status.
    const pending = rows
      .filter((r) => !r.is_private && r.liveness == null && !requested.current.has(r.id))
      .map((r) => r.id);
    if (!pending.length) return;
    pending.forEach((id) => requested.current.add(id));

    let stopped = false;
    void api.livenessEnsure(pending);

    const poll = async (attempt: number) => {
      if (stopped) return;
      const { rows: live } = await api.livenessFor(pending);
      setOverrides((prev) => {
        const next = new Map(prev);
        for (const l of live) next.set(l.url_id, { status: l.status, result_json: l.result_json });
        return next;
      });
      const settled = live.filter((l) => l.status === "done" || l.status === "skipped" || l.status === "failed");
      if (settled.length < pending.length && attempt < 15) {
        timer.current = setTimeout(() => void poll(attempt + 1), 1500);
      }
    };
    timer.current = setTimeout(() => void poll(0), 800);

    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [rows]);

  return overrides;
}
