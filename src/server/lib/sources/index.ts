import type { HistorySource } from "./types.ts";
import { TakeoutSource } from "./takeout.ts";
import { ChromiumSource } from "./chromium.ts";
import { FirefoxSource } from "./firefox.ts";
import { SafariSource } from "./safari.ts";

export type SourceKind = "takeout" | "chromium" | "firefox" | "safari";

export const SOURCE_KINDS: SourceKind[] = ["takeout", "chromium", "firefox", "safari"];

/** Build an adapter for a given source kind + file path. */
export function createSource(kind: SourceKind, filePath: string, label: string): HistorySource {
  switch (kind) {
    case "takeout":
      return new TakeoutSource(filePath);
    case "chromium":
      return new ChromiumSource(filePath, label);
    case "firefox":
      return new FirefoxSource(filePath, label);
    case "safari":
      return new SafariSource(filePath, label);
  }
}
