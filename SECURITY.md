# Security Policy

## Threat model

Chrome History Explorer is a **local-first, single-user** tool. It has no
authentication layer by design — its security model is *network isolation*: it
binds to `127.0.0.1` (loopback) so only processes on your own machine can reach
it. It also holds sensitive data (your full browsing history) and has
side-effecting endpoints (opening browser tabs, importing local browser
profiles, mutating the database), so the guidance below matters if you change
how it's exposed.

### Defaults that keep it safe

- **Loopback binding.** The server listens on `127.0.0.1` only. Set `API_HOST`
  to bind elsewhere — see *Exposing to a LAN* below before you do.
- **Rebinding / CSRF guard.** All `/api` requests are checked: the `Host` header
  must be a trusted (by default loopback) name, and mutating requests with a
  cross-origin `Origin` are rejected. This blocks a malicious website you visit
  from driving the local API (DNS rebinding and CSRF).
- **Privacy gating.** Private/LAN hosts (`localhost`, RFC1918 ranges, `*.local`,
  and your own rules) are never sent to liveness checks, AI providers, or
  ThreadCrumb. Hidden hosts are excluded from every view. Provider/ThreadCrumb
  API keys live only in server-side env vars, never in the browser.

### Known, accepted behaviors (not vulnerabilities)

- **Outbound fetches to private addresses (SSRF-shaped).** Liveness checking and
  "open in browser" intentionally reach LAN/loopback URLs — re-checking your own
  `homeassistant.local` is the point. Because the tool is loopback-only and
  single-user, there is no untrusted caller to weaponize this.
- **No authentication.** Intentional for a loopback single-user tool. If you
  expose it beyond your machine, put it behind your own auth (reverse proxy).

## Exposing to a LAN or remote host

If you set `API_HOST` to a non-loopback address you are widening the trust
boundary. Anyone who can reach that address can read your history and trigger
its actions. If you do this:

1. Add the hostnames/IPs you'll use to `API_ALLOWED_HOSTS` (comma-separated) so
   the rebinding/CSRF guard trusts them.
2. Put an authenticating reverse proxy (or VPN/SSH tunnel) in front of it.
3. Treat the machine as holding your full browsing history — because it does.

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/joshuatownsend/chrome-history-explorer/security/advisories/new)
rather than a public issue. Include reproduction steps and the affected
version/commit. As a small single-maintainer project, expect a best-effort
response within about two weeks.
