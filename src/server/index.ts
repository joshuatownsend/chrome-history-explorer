import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./db.ts";
import { urls } from "./routes/urls.ts";
import { domains } from "./routes/domains.ts";
import { devices } from "./routes/devices.ts";
import { search } from "./routes/search.ts";
import { sessions } from "./routes/sessions.ts";
import { open } from "./routes/open.ts";
import { enrich } from "./routes/enrich.ts";
import { stats } from "./routes/stats.ts";
import { ai } from "./routes/ai.ts";
import { tree } from "./routes/tree.ts";
import { journeys } from "./routes/journeys.ts";
import { settings } from "./routes/settings.ts";
import { importRoutes, sourcesRoute } from "./routes/import.ts";
import { threadcrumb } from "./routes/threadcrumb.ts";
import { resetStuckJobs } from "./lib/jobs.ts";

const PORT = Number(process.env.API_PORT ?? 8787);

// Fail fast with a helpful message if the DB hasn't been built yet.
const db = getDb();
const urlCount = (db.query("SELECT COUNT(*) n FROM urls").get() as { n: number }).n;
if (urlCount === 0) {
  console.warn("⚠  urls table is empty — run `bun run ingest` first.");
}
resetStuckJobs(db); // recover any liveness jobs interrupted by a previous shutdown

const app = new Hono();

const api = new Hono();
api.route("/urls", urls);
api.route("/domains", domains);
api.route("/devices", devices);
api.route("/search", search);
api.route("/sessions", sessions);
api.route("/open", open);
api.route("/enrich", enrich);
api.route("/stats", stats);
api.route("/ai", ai);
api.route("/tree", tree);
api.route("/journeys", journeys); // GET /api/journeys (+ /:id), POST /build, /:id/label
api.route("/settings", settings);
api.route("/sources", sourcesRoute); // GET /api/sources
api.route("/import", importRoutes); // GET /api/import/detect, POST /api/import/run
api.route("/threadcrumb", threadcrumb); // GET /api/threadcrumb/config, POST /api/threadcrumb/send
api.get("/health", (c) => c.json({ ok: true, urls: urlCount }));

app.route("/api", api);

// In production, serve the built SPA from dist/web with history fallback.
const DIST = join(process.cwd(), "dist", "web");
if (existsSync(DIST)) {
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.get("/*", serveStatic({ path: "./dist/web/index.html" }));
}

console.log(`API listening on http://localhost:${PORT}`);
export default { port: PORT, fetch: app.fetch, idleTimeout: 60 };
