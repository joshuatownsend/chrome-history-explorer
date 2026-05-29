import type { MiddlewareHandler } from "hono";

/**
 * Browser-attack guard for a localhost-only service that has side effects
 * (opening tabs, importing local profiles, mutating the DB). It closes two
 * vectors that a malicious *website* the user visits could otherwise exploit:
 *
 *  - DNS rebinding — the attacker re-points their own domain at 127.0.0.1, but
 *    the browser still sends that domain in the `Host` header. We allowlist
 *    `Host` to known-local names, so a rebinding request is rejected.
 *  - CSRF — a cross-origin POST carries an `Origin` header naming the attacker
 *    page. We reject mutating requests whose `Origin` isn't local.
 *
 * Checks are on hostname only (port-agnostic), so the Vite dev proxy
 * (browser :5173 → backend :8787, both `localhost`) and same-origin production
 * requests pass. Non-browser clients (curl, scripts) send no `Origin` and a
 * local `Host`, so they pass too.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Extract the bare hostname from a `Host`/`Origin` header value, or null. */
function hostnameOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * @param extraHosts additional hostnames to trust (e.g. a LAN IP/name the user
 *   opted into via API_HOST / API_ALLOWED_HOSTS). Empty for the default
 *   loopback deployment.
 */
export function localGuard(extraHosts: string[] = []): MiddlewareHandler {
  const allowed = new Set(LOCAL_HOSTS);
  for (const h of extraHosts) {
    const name = hostnameOf(h);
    if (name) allowed.add(name);
  }

  return async (c, next) => {
    const host = hostnameOf(c.req.header("host"));
    if (!host || !allowed.has(host)) return c.json({ error: "forbidden host" }, 403);

    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      const origin = c.req.header("origin");
      // A missing Origin means same-origin or a non-browser client — allowed.
      if (origin && !allowed.has(hostnameOf(origin) ?? "")) {
        return c.json({ error: "forbidden origin" }, 403);
      }
    }
    return next();
  };
}
