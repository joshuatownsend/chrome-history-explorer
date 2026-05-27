/**
 * History ingest CLI.
 *
 *   bun run ingest                          # Takeout ./History.json (default)
 *   bun run ingest path/to/History.json     # Takeout at a path
 *   bun run ingest --list                   # detect local browser profiles
 *   bun run ingest --profile chrome:Default # import a detected profile
 *   bun run ingest --source chromium --path "…/History" [--label chrome:Work]
 *   bun run ingest --source firefox  --path "…/places.sqlite"
 *
 * Multiple sources can be loaded into the same DB; visits dedupe on (url, time).
 */
import { join } from "node:path";
import { getDb } from "./db.ts";
import { createLoader, finalize } from "./lib/load.ts";
import { createSource, type SourceKind } from "./lib/sources/index.ts";
import { detectProfiles, type DetectedProfile } from "./lib/sources/detect.ts";
import { TakeoutSource } from "./lib/sources/takeout.ts";

function parseFlags(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function fmtDate(ms: number | null): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "—";
}

function printProfiles(profiles: DetectedProfile[]) {
  if (!profiles.length) {
    console.log("No local browser profiles found.");
    return;
  }
  console.log(`Found ${profiles.length} local browser profile(s):\n`);
  console.log("  LABEL                          BROWSER    VISITS   LAST VISIT");
  for (const p of profiles) {
    console.log(
      `  ${p.label.padEnd(30)} ${p.browser.padEnd(10)} ${String(p.visitCount ?? "?").padStart(7)}   ${fmtDate(p.lastVisitMs)}`,
    );
  }
  console.log("\nImport one with:  bun run ingest --profile <LABEL>");
}

function reportCounts(db: ReturnType<typeof getDb>, inserted: number, secs: string) {
  const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
  console.log(`\nIngest complete in ${secs}s (${inserted} new visits)`);
  console.log("  visits  :", one("SELECT COUNT(*) n FROM visits"));
  console.log("  urls    :", one("SELECT COUNT(*) n FROM urls"));
  console.log("  domains :", one("SELECT COUNT(DISTINCT domain) n FROM urls"));
  console.log("  private :", one("SELECT COUNT(*) n FROM urls WHERE is_private=1"));
  console.log("  by source:");
  for (const r of db.query("SELECT source, COUNT(*) n FROM visits GROUP BY source ORDER BY n DESC").all() as {
    source: string;
    n: number;
  }[])
    console.log(`    ${r.source.padEnd(28)} ${r.n}`);
}

function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));

  if (flags.list || flags.detect) {
    printProfiles(detectProfiles());
    return;
  }

  const db = getDb();
  const loader = createLoader(db);
  const t0 = Date.now();
  let inserted = 0;

  // Resolve which source to load.
  if (flags.profile) {
    const label = String(flags.profile);
    const match = detectProfiles(false).find((p) => p.label === label);
    if (!match) {
      console.error(`No detected profile labeled "${label}". Run --list to see options.`);
      process.exit(1);
    }
    console.log(`Importing ${match.browser} profile "${match.label}"…`);
    const source = createSource(match.kind, match.path, match.label);
    inserted = loader.loadVisits(source.source, source.readVisits());
  } else if (flags.source) {
    const kind = String(flags.source) as SourceKind;
    const path = flags.path ? String(flags.path) : null;
    if (!path) {
      console.error(`--source ${kind} requires --path <file>.`);
      process.exit(1);
    }
    const label = flags.label ? String(flags.label) : kind;
    const source = createSource(kind, path, label);
    inserted = loader.loadVisits(source.source, source.readVisits());
    if (source.readSessions) loader.loadSessions(source.readSessions());
  } else {
    // Default: Takeout export.
    const path = positional[0] ?? join(process.cwd(), "History.json");
    console.log(`Reading Takeout export: ${path}`);
    const source = new TakeoutSource(path);
    inserted = loader.loadVisits(source.source, source.readVisits());
    loader.loadSessions(source.readSessions());
  }

  finalize(db);
  reportCounts(db, inserted, ((Date.now() - t0) / 1000).toFixed(1));
}

main();
