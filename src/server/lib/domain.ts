import { parse } from "tldts";

export interface UrlParts {
  hostname: string | null;
  domain: string | null; // eTLD+1
  path: string; // pathname + search, for FTS tokenizing
  isPrivate: boolean;
}

const RFC1918_PREFIXES = ["10.", "192.168.", "169.254."];

function isPrivateIPv4(host: string): boolean {
  if (RFC1918_PREFIXES.some((p) => host.startsWith(p))) return true;
  // 172.16.0.0 – 172.31.255.255
  const m = host.match(/^172\.(\d{1,3})\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Classify a host as private/non-routable. Drives the default-deny privacy
 * filter: liveness/AI/favicon enrichment never touch these.
 */
export function isPrivateHost(hostname: string | null): boolean {
  if (!hostname) return true; // unknown host -> treat as private (don't leak)
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  if (isPrivateIPv4(h)) return true;
  return false;
}

/** Parse a raw URL into the parts we store/index. Never throws. */
export function parseUrl(raw: string): UrlParts {
  let hostname: string | null = null;
  let path = "";
  let scheme = "";
  try {
    const u = new URL(raw);
    hostname = u.hostname || null;
    path = (u.pathname || "") + (u.search || "");
    scheme = u.protocol.replace(":", "");
  } catch {
    // chrome://, extension ids, malformed — leave hostname null
  }

  const info = hostname ? parse(hostname) : null;
  const domain = info?.domain ?? hostname; // eTLD+1, fall back to host

  // Non-http(s) schemes (chrome://, file://, extension) are inherently private.
  const nonWeb = scheme !== "" && scheme !== "http" && scheme !== "https";
  const isPrivate = nonWeb || isPrivateHost(hostname);

  return { hostname, domain, path, isPrivate };
}
