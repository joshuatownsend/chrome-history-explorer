import type { Statement } from "bun:sqlite";
import { Hono } from "hono";
import { getDb } from "../db.ts";
import {
  isProfileLabel,
  launchArgs,
  pickLaunchableSource,
  resolveLaunchTarget,
} from "../lib/browsers.ts";

export const open = new Hono();

const MAX_BULK = 50;

/** Only real web URLs may be opened. Rejects file:, chrome:, javascript:, etc. */
function isOpenableUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

/**
 * Prepared once and reused. bun:sqlite does cache statements by SQL text, so this
 * is not a recompile per call — but the cache lookup is still ~4x the cost of a
 * hoisted handle, and this runs up to MAX_BULK times per request. Lazy because the
 * database is opened after this module is imported.
 */
let sourcesForUrl: Statement<{ source: string }, [string]> | undefined;

function sourcesQuery(): Statement<{ source: string }, [string]> {
  sourcesForUrl ??= getDb().query<{ source: string }, [string]>(
    `SELECT v.source
       FROM visits v JOIN urls u ON u.id = v.url_id
      WHERE u.url = ?
      GROUP BY v.source
      ORDER BY COUNT(*) DESC`,
  );
  return sourcesForUrl;
}

/**
 * The browser profile to reopen a URL in, inferred from where it was visited.
 *
 * Saved sessions come only from Takeout, which knows nothing about local profiles,
 * so the URL's own provenance is the only signal available. Sources are ranked by
 * visit count but filtered to those that can actually be launched — picking the
 * single most frequent source would hand "takeout" back for almost every URL in a
 * merged database (a Takeout export spans a year; local Chrome expires at ~90
 * days), losing the Chrome profile that is sitting right behind it.
 *
 * Returns undefined (→ OS default browser) when nothing launchable is on record.
 *
 * KNOWN CEILING: visits dedupe on (url_id, time_ms) with INSERT OR IGNORE, so when
 * a Takeout export is imported before a local profile, the overlapping local rows
 * are dropped and their `source` with them. Only URLs that kept at least one
 * Chromium-labelled visit can be inferred — measured at ~7.5% on a database where
 * Takeout landed first. Everything else falls back to the OS default browser, as
 * it did before profile targeting existed. Fixing this needs per-URL provenance
 * stored outside the deduplicated visit row; see ideas/README.md.
 */
function inferredProfile(url: string): string | undefined {
  try {
    const rows = sourcesQuery().all(url);
    return pickLaunchableSource(rows.map((r) => r.source));
  } catch {
    return undefined; // never let a lookup failure block opening a tab
  }
}

/**
 * Launch a URL, preferring the browser profile it came from. The URL is passed as
 * a literal argv element (never interpolated into a shell string), so query
 * strings with `&` and other metacharacters cannot inject a command — that holds
 * for both the profile-targeted path and the OS-default fallback below.
 *
 * `sourceLabel` is a visit's provenance label ("chrome:Profile 2"). Anything that
 * doesn't resolve to an installed Chromium-family browser falls through to the OS
 * default browser rather than failing: reopening a tab in the wrong profile is
 * annoying, not reopening it at all is worse.
 */
function launch(url: string, sourceLabel?: string): void {
  if (sourceLabel) {
    const target = resolveLaunchTarget(sourceLabel);
    if (target) {
      try {
        Bun.spawn(launchArgs(target, url), { stdout: "ignore", stderr: "ignore" });
        return;
      } catch {
        // Executable vanished between resolution and spawn — fall through.
      }
    }
  }

  if (process.platform === "win32") {
    // rundll32 hands the URL straight to the default protocol handler.
    Bun.spawn(["rundll32", "url.dll,FileProtocolHandler", url], { stdout: "ignore", stderr: "ignore" });
  } else if (process.platform === "darwin") {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  } else {
    Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  }
}

/**
 * POST /api/open  { urls: string[], profile?: string }
 * Opens up to MAX_BULK validated web URLs. With `profile` (a source label such as
 * "chrome:Profile 2") the tabs land in that browser profile; without it, or if it
 * can't be resolved, they go to the OS default browser. Note: the privacy filter
 * intentionally does NOT apply here — reopening a LAN tab like
 * http://homeassistant.local is the whole point of this feature.
 */
open.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { urls?: unknown; profile?: unknown };
  const list = Array.isArray(body.urls) ? body.urls : [];
  const valid = list.filter(isOpenableUrl);
  // A malformed profile is ignored, not rejected — it degrades to the default browser.
  const profile = isProfileLabel(body.profile) ? body.profile : undefined;

  if (valid.length === 0) return c.json({ opened: 0, rejected: list.length });
  if (valid.length > MAX_BULK) {
    return c.json({ error: `Refusing to open ${valid.length} tabs (max ${MAX_BULK}).` }, 400);
  }

  // An explicit profile wins; otherwise infer each URL's own provenance.
  for (const url of valid) launch(url, profile ?? inferredProfile(url));
  return c.json({ opened: valid.length, rejected: list.length - valid.length });
});
