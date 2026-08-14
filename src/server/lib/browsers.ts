/**
 * Resolving a Chromium-family browser executable + profile from a source label.
 *
 * Visits carry a provenance label like "chrome:Profile 2" (see sources/detect.ts,
 * which builds it as `${slug}:${profileDirName}`). The second half is exactly what
 * Chromium's --profile-directory flag expects, so reopening a URL in the profile it
 * came from is a lookup plus two argv elements.
 *
 * Everything here is best-effort: an unknown slug, a non-Chromium browser, or a
 * browser installed somewhere unusual all return null, and the caller falls back to
 * the OS default browser. Never throws.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { chromiumRoots } from "./sources/detect.ts";

export interface LaunchTarget {
  /** Absolute path to the browser executable. */
  exe: string;
  /** Profile directory name, e.g. "Default" or "Profile 2". */
  profileDir: string;
}

/** Slugs sources/detect.ts emits for Chromium-family browsers. */
type ChromiumSlug = "chrome" | "chromium" | "edge" | "brave" | "vivaldi" | "opera" | "opera-gx";

const CHROMIUM_SLUGS = new Set<string>([
  "chrome",
  "chromium",
  "edge",
  "brave",
  "vivaldi",
  "opera",
  "opera-gx",
]);

const env = (name: string): string | null => process.env[name]?.trim() || null;

/** Candidate absolute paths per slug on Windows, most likely first. */
function windowsCandidates(slug: ChromiumSlug): string[] {
  const pf = env("PROGRAMFILES") ?? "C:\\Program Files";
  // The parenthesised name is the real key; Node/Bun expose process.env
  // case-insensitively on win32, but spell it as Windows does.
  const pf86 = env("ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
  const local = env("LOCALAPPDATA") ?? "";

  switch (slug) {
    case "chrome": {
      const rel = join("Google", "Chrome", "Application", "chrome.exe");
      // Per-user installs under LOCALAPPDATA are common and easy to miss.
      return [join(pf, rel), join(pf86, rel), local ? join(local, rel) : ""];
    }
    case "chromium": {
      const rel = join("Chromium", "Application", "chrome.exe");
      return [local ? join(local, rel) : "", join(pf, rel), join(pf86, rel)];
    }
    case "edge": {
      const rel = join("Microsoft", "Edge", "Application", "msedge.exe");
      return [join(pf86, rel), join(pf, rel)];
    }
    case "brave": {
      const rel = join("BraveSoftware", "Brave-Browser", "Application", "brave.exe");
      return [join(pf, rel), join(pf86, rel), local ? join(local, rel) : ""];
    }
    case "vivaldi": {
      const rel = join("Vivaldi", "Application", "vivaldi.exe");
      return [local ? join(local, rel) : "", join(pf, rel), join(pf86, rel)];
    }
    case "opera":
      return [
        local ? join(local, "Programs", "Opera", "opera.exe") : "",
        join(pf, "Opera", "opera.exe"),
      ];
    case "opera-gx":
      return [
        local ? join(local, "Programs", "Opera GX", "opera.exe") : "",
        join(pf, "Opera GX", "opera.exe"),
      ];
  }
}

/** Candidate absolute paths per slug on macOS. */
function macCandidates(slug: ChromiumSlug): string[] {
  const app = (bundle: string, bin: string) => `/Applications/${bundle}.app/Contents/MacOS/${bin}`;
  switch (slug) {
    case "chrome":
      return [app("Google Chrome", "Google Chrome")];
    case "chromium":
      return [app("Chromium", "Chromium")];
    case "edge":
      return [app("Microsoft Edge", "Microsoft Edge")];
    case "brave":
      return [app("Brave Browser", "Brave Browser")];
    case "vivaldi":
      return [app("Vivaldi", "Vivaldi")];
    case "opera":
      return [app("Opera", "Opera")];
    case "opera-gx":
      return [app("Opera GX", "Opera")];
  }
}

/** Executable base names to look for on PATH, per slug (Linux). */
function linuxNames(slug: ChromiumSlug): string[] {
  switch (slug) {
    case "chrome":
      return ["google-chrome", "google-chrome-stable"];
    case "chromium":
      return ["chromium", "chromium-browser"];
    case "edge":
      return ["microsoft-edge", "microsoft-edge-stable"];
    case "brave":
      return ["brave-browser", "brave"];
    case "vivaldi":
      return ["vivaldi", "vivaldi-stable"];
    case "opera":
      return ["opera"];
    case "opera-gx":
      return []; // Opera GX has no Linux build.
  }
}

/** First name on PATH that resolves to an existing file, or null. */
function whichInPath(names: string[]): string | null {
  const paths = (env("PATH") ?? "").split(delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of paths) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * A source label shaped like a launch profile, e.g. "chrome:Profile 2".
 *
 * Both halves are bounded. The profile half excludes path separators and control
 * characters but still allows spaces and colons, which real Chromium profile
 * directory names may contain ("Guest Profile").
 */
const PROFILE_LABEL = /^[A-Za-z-]{1,20}:[^\\/\x00-\x1f\x7f]{1,64}$/;

/**
 * Is this a syntactically acceptable profile label? Sanity-checks values before
 * they reach the resolver — over HTTP, or out of the database.
 *
 * The profile half becomes a `--profile-directory=` argument, so it must not be
 * able to walk out of the user-data directory: separators are excluded by the
 * pattern and `..` is rejected outright.
 */
export function isProfileLabel(value: unknown): value is string {
  return typeof value === "string" && PROFILE_LABEL.test(value) && !value.includes("..");
}

/**
 * The first label in a preference-ordered list that can actually be launched.
 *
 * Callers rank candidates by their own criteria (visit count, recency); this
 * filters that ranking down to what is installed. Without it, a URL visited
 * mostly via a Takeout export loses to its own Chrome profile — the common case
 * when a long-term export is merged with a fresher local import.
 *
 * `canLaunch` is injectable so the ranking can be tested without depending on
 * which browsers happen to be installed on the machine running the suite.
 */
export function pickLaunchableSource(
  orderedLabels: string[],
  canLaunch: (label: string) => boolean = (l) => resolveLaunchTarget(l) !== null,
): string | undefined {
  return orderedLabels.find(canLaunch);
}

/**
 * Split a source label on its FIRST colon. Slugs never contain a colon; profile
 * directory names may contain spaces (e.g. "chrome:Guest Profile"). Exported for
 * testing: resolveLaunchTarget itself touches the filesystem, so parsing is the
 * only part that can be asserted the same way on every machine.
 */
export function parseSourceLabel(sourceLabel: string): { slug: string; profileDir: string } | null {
  if (typeof sourceLabel !== "string") return null;
  const i = sourceLabel.indexOf(":");
  if (i <= 0) return null; // no colon, or an empty slug
  const slug = sourceLabel.slice(0, i).toLowerCase();
  const profileDir = sourceLabel.slice(i + 1);
  if (!profileDir) return null;
  return { slug, profileDir };
}

/**
 * Resolve a source label like "chrome:Profile 2" to an executable + profile dir.
 * Returns null for non-Chromium sources (firefox/safari/takeout), unknown slugs,
 * and browsers that aren't installed where we look — all of which mean
 * "fall back to the OS default browser", never an error.
 */
export function resolveLaunchTarget(sourceLabel: string): LaunchTarget | null {
  // Gate every caller, not just the HTTP one: source labels also arrive from the
  // database, and the profile half ends up in an argv element either way.
  if (!isProfileLabel(sourceLabel)) return null;
  const parts = parseSourceLabel(sourceLabel);
  if (!parts) return null;
  if (!CHROMIUM_SLUGS.has(parts.slug)) return null;
  const slug = parts.slug as ChromiumSlug;

  const exe =
    process.platform === "win32"
      ? windowsCandidates(slug).find((p) => p && existsSync(p))
      : process.platform === "darwin"
        ? macCandidates(slug).find((p) => p && existsSync(p))
        : whichInPath(linuxNames(slug));
  if (!exe) return null;

  // An installed browser is not enough: the profile directory must still exist.
  // A stale label (profile since deleted, or from a different installation) would
  // otherwise launch Chromium with an unknown --profile-directory, which creates a
  // fresh blank profile rather than falling back to the default browser as promised.
  const root = chromiumRoots().find((d) => d.slug === slug);
  if (!root || !existsSync(join(root.userDataDir, parts.profileDir))) return null;

  return { exe, profileDir: parts.profileDir };
}

/**
 * Build the argument vector for launching one URL in one profile.
 *
 * Returns an ARRAY on purpose: the caller hands it straight to Bun.spawn, so the
 * URL is a single argv element and can never be tokenized by a shell. Do not add a
 * variant that returns a command string — argv isolation is the injection defence
 * here, not URL validation.
 */
export function launchArgs(target: LaunchTarget, url: string): string[] {
  return [target.exe, `--profile-directory=${target.profileDir}`, url];
}
