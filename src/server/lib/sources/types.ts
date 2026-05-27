/** Normalized records every history source adapter emits. */

export interface NormalizedVisit {
  url: string;
  title: string | null;
  timeMs: number; // epoch ms (UTC)
  clientId: string | null; // physical device, when the source knows it (Takeout)
  transition: TransitionType | null;
}

export type TransitionType =
  | "link"
  | "typed"
  | "reload"
  | "form"
  | "bookmark"
  | "redirect"
  | "generated"
  | "other";

/** Raw session/tab data — only Takeout provides this. Shape matches ingest's loader. */
export interface SessionData {
  sessionTag: string | null;
  windowId: number | null;
  lastActiveMs: number | null;
  tabs: {
    tabId: number | null;
    tabNodeId: number | null;
    pinned: boolean;
    currentNavIndex: number;
    browserType: string | null;
    lastActiveMs: number | null;
    currentUrl: string | null;
    currentTitle: string | null;
    navigation: {
      idx: number;
      title: string | null;
      virtualUrl: string | null;
      timestampMs: number | null;
      httpStatus: number | null;
      referrer: string | null;
    }[];
  }[];
}

/** A source produces visits (and optionally sessions) for one profile/export. */
export interface HistorySource {
  /** Stable provenance label stored on each visit, e.g. "chrome-local:Default". */
  source: string;
  readVisits(): Iterable<NormalizedVisit>;
  readSessions?(): SessionData[];
}

/** Chromium `transition & 0xff` core type → normalized label. */
export function chromiumTransition(raw: number | null): TransitionType | null {
  if (raw == null) return null;
  switch (raw & 0xff) {
    case 0: return "link";
    case 1: return "typed";
    case 2: return "bookmark";
    case 5: return "generated";
    case 7: return "form";
    case 8: return "reload";
    case 9:
    case 10: return "generated";
    default: return "other"; // subframes, start page, etc.
  }
}

/** Firefox moz_historyvisits.visit_type → normalized label. */
export function firefoxTransition(raw: number | null): TransitionType | null {
  if (raw == null) return null;
  switch (raw) {
    case 1: return "link";
    case 2: return "typed";
    case 3: return "bookmark";
    case 5:
    case 6: return "redirect";
    case 8: return "link";
    case 9: return "reload";
    default: return "other"; // embed, download
  }
}
