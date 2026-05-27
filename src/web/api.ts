export interface UrlRow {
  id: number;
  url: string;
  hostname: string | null;
  domain: string | null;
  title: string | null;
  is_private: number;
  visit_count: number;
  first_visited: number | null;
  last_visited: number | null;
  device_count: number;
  liveness: string | null; // enrichment status
  liveness_json: string | null;
}

export interface DomainRow {
  domain: string | null;
  is_private: number;
  url_count: number;
  visits: number;
  first_visited: number | null;
  last_visited: number | null;
}

export interface DeviceRow {
  client_id: string;
  label: string | null;
  visit_count: number;
  first_seen: number | null;
  last_seen: number | null;
}

export interface Page<T> {
  total: number;
  limit: number;
  offset: number;
  rows: T[];
}

export interface SessionRow {
  id: number;
  session_tag: string;
  window_id: number | null;
  last_active_ms: number | null;
  tab_count: number;
  preview: string | null;
}

export interface NavEntry {
  idx: number;
  title: string | null;
  virtual_url: string | null;
  timestamp_ms: number | null;
  http_status: number | null;
}

export interface SessionTab {
  id: number;
  tab_id: number | null;
  pinned: number;
  current_nav_index: number | null;
  browser_type: string | null;
  current_url: string | null;
  current_title: string | null;
  liveness: string | null;
  liveness_json: string | null;
  navigation: NavEntry[];
}

export interface Filters {
  q?: string;
  domain?: string;
  device?: string;
  from?: number;
  to?: number;
  privacy?: "all" | "public" | "private";
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${path}`);
  return r.json() as Promise<T>;
}

export const api = {
  urls: (
    f: Filters,
    sort: string,
    dir: "asc" | "desc",
    limit: number,
    offset: number,
  ) => getJson<Page<UrlRow>>(`/urls${qs({ ...f, sort, dir, limit, offset })}`),

  domains: (
    f: Filters,
    sort: string,
    dir: "asc" | "desc",
    limit: number,
    offset: number,
  ) => getJson<Page<DomainRow>>(`/domains${qs({ ...f, sort, dir, limit, offset })}`),

  devices: () => getJson<{ rows: DeviceRow[] }>(`/devices`),

  setDeviceLabel: (clientId: string, label: string) =>
    fetch(`/api/devices/${encodeURIComponent(clientId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    }),

  urlVisits: (id: number) =>
    getJson<{ rows: { time_ms: number; client_id: string; device_label: string | null }[] }>(
      `/urls/${id}/visits`,
    ),

  sessions: () => getJson<{ rows: SessionRow[] }>(`/sessions`),

  session: (id: number) => getJson<{ id: number; tabs: SessionTab[] }>(`/sessions/${id}`),

  openUrls: async (urls: string[]): Promise<{ opened: number; rejected: number; error?: string }> => {
    const r = await fetch(`/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    return r.json();
  },

  livenessEnsure: (urlIds: number[]) =>
    fetch(`/api/enrich/liveness/ensure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url_ids: urlIds }),
    }).then((r) => r.json() as Promise<{ queued: number }>),

  livenessBatch: (scope: "top" | "domain" | "recent", opts: { n?: number; domain?: string; days?: number }) =>
    fetch(`/api/enrich/liveness/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, ...opts }),
    }).then((r) => r.json() as Promise<{ candidates: number; queued: number; error?: string }>),

  livenessStatus: () =>
    getJson<{
      active: number;
      counts: Record<string, number>;
      states: Record<string, number>;
      total_public: number;
    }>(`/enrich/liveness/status`),

  livenessFor: (ids: number[]) =>
    getJson<{ rows: { url_id: number; status: string; result_json: string | null }[] }>(
      `/enrich/liveness?ids=${ids.join(",")}`,
    ),

  stats: () => getJson<Stats>(`/stats`),

  tree: (domain: string) =>
    getJson<{ domain: string; children: TreeNode[] }>(`/tree?domain=${encodeURIComponent(domain)}`),

  aiConfig: () =>
    getJson<{
      providers: { id: string; name: string; configured: boolean; canSummarize: boolean; canEmbed: boolean }[];
      summaries: number;
      embeddings: number;
    }>(`/ai/config`),

  summarize: (urlId: number, prefer?: string) =>
    fetch(`/api/ai/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url_id: urlId, prefer }),
    }).then((r) => r.json() as Promise<{ summary?: string; provider?: string; error?: string }>),

  aiSummariesFor: (ids: number[]) =>
    getJson<{ rows: { url_id: number; result_json: string }[] }>(`/ai/summary?ids=${ids.join(",")}`),

  buildEmbeddings: (scope: "top" | "domain", opts: { n?: number; domain?: string }) =>
    fetch(`/api/ai/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, ...opts }),
    }).then((r) => r.json() as Promise<{ embedded?: number; skipped?: number; error?: string }>),

  semanticSearch: (q: string, limit = 30) =>
    fetch(`/api/ai/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q, limit }),
    }).then(
      (r) =>
        r.json() as Promise<{
          rows: (UrlRow & { score: number })[];
          error?: string;
          note?: string;
        }>,
    ),
};

export interface TreeNode {
  label: string;
  visits: number; // aggregate (own + descendants)
  ownVisits: number;
  lastVisited: number | null;
  isPage: boolean;
  urlId?: number;
  url?: string;
  title?: string | null;
  isPrivate?: number;
  liveness?: string | null;
  livenessJson?: string | null;
  pageCount: number;
  children: TreeNode[];
}

export interface Stats {
  totals: {
    visits: number;
    urls: number;
    domains: number;
    devices: number;
    public_urls: number;
    private_urls: number;
    first_visit: number;
    last_visit: number;
  };
  byDay: { d: string; n: number }[];
  byHour: { h: number; n: number }[];
  byDow: { w: number; n: number }[];
  topDomains: { domain: string; is_private: number; url_count: number; visits: number }[];
  topUrls: UrlRow[];
  busiestDays: { d: string; n: number }[];
  devices: DeviceRow[];
  liveness: Record<string, number>;
  liveness_checked: number;
}

export interface LivenessInfo {
  status: string;
  result_json: string | null;
}
