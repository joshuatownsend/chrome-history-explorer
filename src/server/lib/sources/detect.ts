import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SourceKind } from "./index.ts";
import { openSqliteCopy } from "./sqlite-open.ts";

export interface DetectedProfile {
  browser: string; // "Chrome", "Edge", "Firefox", …
  kind: SourceKind; // chromium | firefox | safari
  label: string; // stable source label, e.g. "chrome:Default"
  path: string; // absolute path to the history DB
  visitCount: number | null;
  lastVisitMs: number | null;
}

const HOME = homedir();
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? join(HOME, "AppData", "Local");
const APPDATA = process.env.APPDATA ?? join(HOME, "AppData", "Roaming");

interface ChromiumDef {
  browser: string;
  slug: string; // label prefix
  userDataDir: string;
}

/** Chromium-family "User Data" directories per platform. */
function chromiumRoots(): ChromiumDef[] {
  if (process.platform === "win32") {
    return [
      { browser: "Chrome", slug: "chrome", userDataDir: join(LOCALAPPDATA, "Google", "Chrome", "User Data") },
      { browser: "Edge", slug: "edge", userDataDir: join(LOCALAPPDATA, "Microsoft", "Edge", "User Data") },
      { browser: "Brave", slug: "brave", userDataDir: join(LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data") },
      { browser: "Vivaldi", slug: "vivaldi", userDataDir: join(LOCALAPPDATA, "Vivaldi", "User Data") },
      { browser: "Opera", slug: "opera", userDataDir: join(APPDATA, "Opera Software", "Opera Stable") },
      { browser: "Opera GX", slug: "opera-gx", userDataDir: join(APPDATA, "Opera Software", "Opera GX Stable") },
    ];
  }
  if (process.platform === "darwin") {
    const app = join(HOME, "Library", "Application Support");
    return [
      { browser: "Chrome", slug: "chrome", userDataDir: join(app, "Google", "Chrome") },
      { browser: "Edge", slug: "edge", userDataDir: join(app, "Microsoft Edge") },
      { browser: "Brave", slug: "brave", userDataDir: join(app, "BraveSoftware", "Brave-Browser") },
      { browser: "Vivaldi", slug: "vivaldi", userDataDir: join(app, "Vivaldi") },
      { browser: "Opera", slug: "opera", userDataDir: join(app, "com.operasoftware.Opera") },
    ];
  }
  const cfg = join(HOME, ".config");
  return [
    { browser: "Chrome", slug: "chrome", userDataDir: join(cfg, "google-chrome") },
    { browser: "Chromium", slug: "chromium", userDataDir: join(cfg, "chromium") },
    { browser: "Edge", slug: "edge", userDataDir: join(cfg, "microsoft-edge") },
    { browser: "Brave", slug: "brave", userDataDir: join(cfg, "BraveSoftware", "Brave-Browser") },
    { browser: "Vivaldi", slug: "vivaldi", userDataDir: join(cfg, "vivaldi") },
    { browser: "Opera", slug: "opera", userDataDir: join(cfg, "opera") },
  ];
}

function firefoxProfilesDir(): string | null {
  if (process.platform === "win32") return join(APPDATA, "Mozilla", "Firefox", "Profiles");
  if (process.platform === "darwin") return join(HOME, "Library", "Application Support", "Firefox", "Profiles");
  return join(HOME, ".mozilla", "firefox");
}

function safariHistoryDb(): string | null {
  if (process.platform !== "darwin") return null;
  return join(HOME, "Library", "Safari", "History.db");
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Open a history DB copy and read row count + most-recent visit for previewing. */
function probe(kind: SourceKind, path: string): { visitCount: number | null; lastVisitMs: number | null } {
  try {
    const { db, cleanup } = openSqliteCopy(path);
    try {
      if (kind === "chromium") {
        const r = db.query("SELECT COUNT(*) n, MAX(visit_time) t FROM visits").get() as { n: number; t: number };
        return { visitCount: r.n, lastVisitMs: r.t ? Math.floor(r.t / 1000) - 11644473600000 : null };
      }
      if (kind === "firefox") {
        const r = db.query("SELECT COUNT(*) n, MAX(visit_date) t FROM moz_historyvisits").get() as { n: number; t: number };
        return { visitCount: r.n, lastVisitMs: r.t ? Math.floor(r.t / 1000) : null };
      }
      const r = db.query("SELECT COUNT(*) n, MAX(visit_time) t FROM history_visits").get() as { n: number; t: number };
      return { visitCount: r.n, lastVisitMs: r.t ? Math.round((r.t + 978307200) * 1000) : null };
    } finally {
      cleanup();
    }
  } catch {
    return { visitCount: null, lastVisitMs: null };
  }
}

/**
 * Find local browser history databases. Pass probe=true to also read row counts
 * and last-visit dates (opens each DB; slower but lets the user choose).
 */
export function detectProfiles(withProbe = true): DetectedProfile[] {
  const found: DetectedProfile[] = [];

  for (const def of chromiumRoots()) {
    for (const profile of listDirs(def.userDataDir)) {
      // Chromium profiles are "Default" / "Profile N" / "Guest Profile" with a History file.
      const dbPath = join(def.userDataDir, profile, "History");
      if (!existsSync(dbPath)) continue;
      const meta = withProbe ? probe("chromium", dbPath) : { visitCount: null, lastVisitMs: null };
      found.push({
        browser: def.browser,
        kind: "chromium",
        label: `${def.slug}:${profile}`,
        path: dbPath,
        ...meta,
      });
    }
  }

  const ffDir = firefoxProfilesDir();
  if (ffDir) {
    for (const profile of listDirs(ffDir)) {
      const dbPath = join(ffDir, profile, "places.sqlite");
      if (!existsSync(dbPath)) continue;
      const meta = withProbe ? probe("firefox", dbPath) : { visitCount: null, lastVisitMs: null };
      found.push({ browser: "Firefox", kind: "firefox", label: `firefox:${profile}`, path: dbPath, ...meta });
    }
  }

  const safari = safariHistoryDb();
  if (safari && existsSync(safari)) {
    const meta = withProbe ? probe("safari", safari) : { visitCount: null, lastVisitMs: null };
    found.push({ browser: "Safari", kind: "safari", label: "safari", path: safari, ...meta });
  }

  return found.sort((a, b) => (b.visitCount ?? 0) - (a.visitCount ?? 0));
}
