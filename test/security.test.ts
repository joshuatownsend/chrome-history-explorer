import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { localGuard } from "../src/server/lib/security.ts";

/** Build a tiny app guarded like the real one, with a GET and a POST route. */
function app(extraHosts: string[] = []) {
  const a = new Hono();
  a.use("*", localGuard(extraHosts));
  a.get("/", (c) => c.json({ ok: true }));
  a.post("/", (c) => c.json({ ok: true }));
  return a;
}

function req(
  method: string,
  headers: Record<string, string>,
): Request {
  return new Request("http://x/", { method, headers });
}

describe("localGuard", () => {
  test("allows loopback Host (any port) for GET", async () => {
    const r = await app().request(req("GET", { host: "localhost:8787" }));
    expect(r.status).toBe(200);
    const r2 = await app().request(req("GET", { host: "127.0.0.1:8787" }));
    expect(r2.status).toBe(200);
  });

  test("rejects a rebinding Host (attacker domain pointed at loopback)", async () => {
    const r = await app().request(req("GET", { host: "evil.com" }));
    expect(r.status).toBe(403);
  });

  test("rejects a mutating request with a cross-origin Origin (CSRF)", async () => {
    const r = await app().request(
      req("POST", { host: "localhost:8787", origin: "http://evil.com" }),
    );
    expect(r.status).toBe(403);
  });

  test("allows a mutating request with no Origin (same-origin / curl)", async () => {
    const r = await app().request(req("POST", { host: "localhost:8787" }));
    expect(r.status).toBe(200);
  });

  test("allows a same-origin Origin on a mutating request", async () => {
    const r = await app().request(
      req("POST", { host: "localhost:8787", origin: "http://localhost:8787" }),
    );
    expect(r.status).toBe(200);
  });

  test("allows the Vite dev origin (different port, same loopback host)", async () => {
    const r = await app().request(
      req("POST", { host: "localhost:8787", origin: "http://localhost:5173" }),
    );
    expect(r.status).toBe(200);
  });

  test("does not block a cross-origin GET (non-mutating) but still checks Host", async () => {
    // GET with a foreign Origin but local Host: allowed (reads aren't CSRF-able to mutate).
    const ok = await app().request(
      req("GET", { host: "localhost:8787", origin: "http://evil.com" }),
    );
    expect(ok.status).toBe(200);
    // GET with a foreign Host: still rejected (rebinding).
    const bad = await app().request(req("GET", { host: "evil.com" }));
    expect(bad.status).toBe(403);
  });

  test("rejects a missing Host header", async () => {
    const r = await app().request(new Request("http://x/", { method: "GET" }));
    // No trusted Host header present (or a non-loopback one) → rejected.
    expect(r.status).toBe(403);
  });

  test("trusts extra hosts opted in via API_ALLOWED_HOSTS", async () => {
    const a = app(["history.lan"]);
    const r = await a.request(
      req("POST", { host: "history.lan:8787", origin: "http://history.lan:8787" }),
    );
    expect(r.status).toBe(200);
  });
});
