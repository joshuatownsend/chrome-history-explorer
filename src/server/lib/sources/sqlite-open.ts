import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Copy a browser history DB (plus its -wal/-shm) to a throwaway temp file and
 * open it. Reading a copy avoids the lock a running browser holds on the live
 * file; opening read-write on our own copy lets SQLite fold in the WAL so the
 * most recent visits are visible. We only ever SELECT.
 */
export function openSqliteCopy(srcPath: string): { db: Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "che-src-"));
  const dst = join(dir, "history.sqlite");
  copyFileSync(srcPath, dst);
  for (const ext of ["-wal", "-shm"]) {
    try {
      copyFileSync(srcPath + ext, dst + ext);
    } catch {
      /* not all DBs have WAL sidecars */
    }
  }
  const db = new Database(dst);
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
