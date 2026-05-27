import { Hono } from "hono";

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
 * Launch a URL in the OS default browser. The URL is passed as a literal argv
 * element (never interpolated into a shell string), so query strings with `&`
 * and other metacharacters cannot inject a command.
 */
function launch(url: string): void {
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
 * POST /api/open  { urls: string[] }
 * Opens up to MAX_BULK validated web URLs in the default browser. Note: the
 * privacy filter intentionally does NOT apply here — reopening a LAN tab like
 * http://homeassistant.local is the whole point of this feature.
 */
open.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { urls?: unknown };
  const list = Array.isArray(body.urls) ? body.urls : [];
  const valid = list.filter(isOpenableUrl);

  if (valid.length === 0) return c.json({ opened: 0, rejected: list.length });
  if (valid.length > MAX_BULK) {
    return c.json({ error: `Refusing to open ${valid.length} tabs (max ${MAX_BULK}).` }, 400);
  }

  for (const url of valid) launch(url);
  return c.json({ opened: valid.length, rejected: list.length - valid.length });
});
