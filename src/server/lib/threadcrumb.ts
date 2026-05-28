/**
 * ThreadCrumb integration. Sends a history link to a ThreadCrumb "Intent Inbox"
 * via its discovery-events ingest endpoint — the same contract the ThreadCrumb
 * browser extension uses. The Bearer token lives only on this server (never the
 * browser), so requests don't hit CORS and the key isn't exposed to the client.
 */
const DEFAULT_BASE = "https://threadcrumb.io";

export interface ThreadcrumbConfig {
  configured: boolean;
  baseUrl: string;
}

function baseUrl(): string {
  return (process.env.THREADCRUMB_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
}

export function threadcrumbConfig(): ThreadcrumbConfig {
  return { configured: Boolean(process.env.THREADCRUMB_TOKEN), baseUrl: baseUrl() };
}

export interface CaptureInput {
  url: string;
  title?: string | null;
  capturedAt?: string; // ISO 8601; defaults to now() on ThreadCrumb's side
  captureContext?: Record<string, unknown>;
}

/** POST a single capture to ThreadCrumb. Throws with ThreadCrumb's error text on failure. */
export async function sendToThreadcrumb(input: CaptureInput): Promise<{ id: string; status: string }> {
  const token = process.env.THREADCRUMB_TOKEN;
  if (!token) throw new Error("ThreadCrumb not configured (set THREADCRUMB_TOKEN)");

  const res = await fetch(`${baseUrl()}/api/discovery-events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      sourceType: "chrome_history",
      sourcePlatform: "chrome_history_explorer",
      captureChannel: "chrome_history",
      originalUrl: input.url,
      pageTitle: input.title ?? undefined,
      capturedAt: input.capturedAt,
      captureContext: input.captureContext,
    }),
  });

  if (!res.ok) {
    const msg = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(msg?.error ?? `ThreadCrumb HTTP ${res.status}`);
  }
  return res.json() as Promise<{ id: string; status: string }>;
}
