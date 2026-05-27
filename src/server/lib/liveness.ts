/** Liveness checking: classify a URL as live/dead/blocked/etc + Wayback fallback. */

export type LivenessState =
  | "live"
  | "dead"
  | "blocked" // reachable but auth/UA-gated (401/403)
  | "rate-limited" // 429
  | "error"; // 5xx or transient network issue

export interface LivenessResult {
  state: LivenessState;
  status_code: number | null;
  final_url: string | null; // after redirects
  fetched_at: number; // epoch ms
  archived_url?: string;
  archived_timestamp?: string;
  error?: string;
}

const UA = "ChromeHistoryExplorer/0.1 (+local history tool; polite checker)";
const TIMEOUT_MS = 10_000;

/**
 * THE LIVENESS CLASSIFICATION RUBRIC (the meaningful product decision in Phase 4).
 * Maps an HTTP status code to a liveness state. Tweak these buckets to taste:
 *   2xx/3xx         -> live
 *   401 / 403       -> blocked   (the page exists but won't serve a bot/anon)
 *   429             -> rate-limited (we backed off; site is up)
 *   5xx             -> error     (server problem, not necessarily a dead link)
 *   other 4xx (404) -> dead
 */
export function classifyStatus(code: number): LivenessState {
  if (code >= 200 && code < 400) return "live";
  if (code === 401 || code === 403) return "blocked";
  if (code === 429) return "rate-limited";
  if (code >= 500) return "error";
  return "dead"; // 404, 410, and other 4xx
}

/** Network-level failures (DNS, connection refused, timeout) → dead vs error. */
function classifyError(err: unknown): { state: LivenessState; error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  // DNS / refused / cert / unreachable → the resource is effectively gone.
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|certificate|ERR_/i.test(msg)) {
    return { state: "dead", error: msg };
  }
  // Timeout / reset → transient-ish; call it error so a re-check can recover it.
  return { state: "error", error: msg };
}

async function fetchWithTimeout(url: string, method: "HEAD" | "GET"): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": UA,
        // Range keeps GET fallback to ~1-2 KB instead of a full page download.
        ...(method === "GET" ? { range: "bytes=0-1" } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Check one URL. Tries HEAD, falls back to a tiny range-GET if HEAD is rejected. */
export async function checkLiveness(url: string): Promise<LivenessResult> {
  const fetched_at = Date.now();
  let res: Response;
  try {
    res = await fetchWithTimeout(url, "HEAD");
    // Many servers reject HEAD (405/501) or mishandle it (400) — retry with GET.
    if (res.status === 405 || res.status === 501 || res.status === 400) {
      res = await fetchWithTimeout(url, "GET");
    }
  } catch {
    try {
      res = await fetchWithTimeout(url, "GET");
    } catch (err) {
      const { state, error } = classifyError(err);
      return { state, status_code: null, final_url: null, fetched_at, error };
    }
  }

  const state = classifyStatus(res.status);
  const result: LivenessResult = {
    state,
    status_code: res.status,
    final_url: res.url || url,
    fetched_at,
  };

  if (state === "dead") {
    const archive = await queryWayback(url).catch(() => null);
    if (archive) {
      result.archived_url = archive.url;
      result.archived_timestamp = archive.timestamp;
    }
  }
  return result;
}

/** Ask the Wayback Machine for the closest archived snapshot, if any. */
export async function queryWayback(
  url: string,
): Promise<{ url: string; timestamp: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const r = await fetch(api, { signal: ctrl.signal, headers: { "user-agent": UA } });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string } };
    };
    const snap = data.archived_snapshots?.closest;
    if (snap?.available && snap.url) {
      return { url: snap.url, timestamp: snap.timestamp ?? "" };
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
