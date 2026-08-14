import { describe, expect, test } from "bun:test";
import {
  isProfileLabel,
  launchArgs,
  parseSourceLabel,
  pickLaunchableSource,
  resolveLaunchTarget,
} from "../src/server/lib/browsers.ts";

/**
 * Only the environment-independent parts are unit-tested. resolveLaunchTarget's
 * happy path depends on which browsers are installed on the machine running the
 * suite, so it is asserted here only for cases that must be null everywhere;
 * successful resolution is verified manually against a real multi-profile Chrome.
 */

describe("parseSourceLabel", () => {
  test("splits a plain label", () => {
    expect(parseSourceLabel("chrome:Default")).toEqual({ slug: "chrome", profileDir: "Default" });
  });

  test("preserves spaces in the profile directory name", () => {
    expect(parseSourceLabel("chrome:Profile 2")).toEqual({
      slug: "chrome",
      profileDir: "Profile 2",
    });
    expect(parseSourceLabel("chrome:Guest Profile")?.profileDir).toBe("Guest Profile");
  });

  test("recognises other Chromium slugs", () => {
    expect(parseSourceLabel("edge:Default")?.slug).toBe("edge");
    expect(parseSourceLabel("opera-gx:Default")?.slug).toBe("opera-gx");
  });

  test("splits on the FIRST colon only", () => {
    // A profile directory may itself contain a colon; the slug never does.
    expect(parseSourceLabel("chrome:weird:name")).toEqual({
      slug: "chrome",
      profileDir: "weird:name",
    });
  });

  test("lowercases the slug but not the profile directory", () => {
    expect(parseSourceLabel("CHROME:Default")).toEqual({ slug: "chrome", profileDir: "Default" });
  });

  test("rejects labels with no colon, no slug, or no profile", () => {
    expect(parseSourceLabel("safari")).toBeNull();
    expect(parseSourceLabel("takeout")).toBeNull();
    expect(parseSourceLabel(":Default")).toBeNull();
    expect(parseSourceLabel("chrome:")).toBeNull();
    expect(parseSourceLabel("")).toBeNull();
  });
});

describe("resolveLaunchTarget — cases that must be null on every machine", () => {
  test("non-Chromium sources fall back to the OS default browser", () => {
    expect(resolveLaunchTarget("firefox:abc123.default")).toBeNull();
    expect(resolveLaunchTarget("safari")).toBeNull();
    expect(resolveLaunchTarget("takeout")).toBeNull();
  });

  test("unknown slugs fall back", () => {
    expect(resolveLaunchTarget("netscape:Default")).toBeNull();
    expect(resolveLaunchTarget("chrome-canary-typo:Default")).toBeNull();
  });

  test("malformed labels fall back rather than throwing", () => {
    expect(resolveLaunchTarget("")).toBeNull();
    expect(resolveLaunchTarget("::::")).toBeNull();
    expect(() => resolveLaunchTarget("chrome")).not.toThrow();
  });
});

describe("launchArgs", () => {
  const target = { exe: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", profileDir: "Profile 2" };

  test("builds exactly [exe, --profile-directory=<dir>, url]", () => {
    const args = launchArgs(target, "https://example.com/");
    expect(args).toHaveLength(3);
    expect(args[0]).toBe(target.exe);
    expect(args[1]).toBe("--profile-directory=Profile 2");
    expect(args[2]).toBe("https://example.com/");
  });

  test("the profile flag is one argv element, spaces and all", () => {
    // Split into two elements ("--profile-directory=Profile", "2") Chrome would
    // silently open the wrong profile and treat "2" as a URL.
    const args = launchArgs(target, "https://example.com/");
    expect(args.filter((a) => a.startsWith("--profile-directory="))).toHaveLength(1);
  });

  /**
   * THE SECURITY REGRESSION TEST.
   *
   * Passing an argv array to Bun.spawn — never a command string — is what makes a
   * hostile URL harmless: there is no shell to tokenize `&`, `|`, quotes or
   * newlines. If anyone ever "simplifies" launchArgs into a joined string, this
   * fails. See INSIGHTS.md on argv isolation.
   */
  test("a hostile URL survives as one unmodified argv element", () => {
    const hostile = "https://evil.example/?a=1&b=2 & calc.exe|whoami;rm -rf /";
    const args = launchArgs(target, hostile);
    expect(args).toHaveLength(3);
    expect(args[2]).toBe(hostile); // byte-identical: no escaping, no splitting
  });

  test("quotes and newlines in a URL are not escaped or split", () => {
    const nasty = 'https://evil.example/?q="x"\ny';
    const args = launchArgs(target, nasty);
    expect(args).toHaveLength(3);
    expect(args[2]).toBe(nasty);
  });
});

describe("pickLaunchableSource", () => {
  // Stub the launch check so the ranking is asserted the same way everywhere,
  // regardless of which browsers exist on the machine running the suite.
  const canLaunch = (l: string) => l.startsWith("chrome:") || l.startsWith("edge:");

  test("skips a more-frequent source that cannot be launched", () => {
    // The real shape of a merged database: a year of Takeout outranks ~90 days
    // of local Chrome for nearly every URL, but Chrome is what can be launched.
    expect(pickLaunchableSource(["takeout", "chrome:Default"], canLaunch)).toBe("chrome:Default");
  });

  test("respects the caller's ranking among launchable sources", () => {
    expect(pickLaunchableSource(["edge:Default", "chrome:Default"], canLaunch)).toBe("edge:Default");
    expect(pickLaunchableSource(["chrome:Default", "edge:Default"], canLaunch)).toBe("chrome:Default");
  });

  test("returns undefined when nothing is launchable", () => {
    expect(pickLaunchableSource(["takeout", "firefox:abc.default", "safari"], canLaunch)).toBeUndefined();
    expect(pickLaunchableSource([], canLaunch)).toBeUndefined();
  });

  test("defaults to the real resolver when no predicate is given", () => {
    // Environment-independent direction only: these can never be launchable.
    expect(pickLaunchableSource(["takeout", "safari"])).toBeUndefined();
  });
});

describe("isProfileLabel", () => {
  test("accepts real source labels", () => {
    expect(isProfileLabel("chrome:Default")).toBe(true);
    expect(isProfileLabel("chrome:Profile 2")).toBe(true);
    expect(isProfileLabel("opera-gx:Default")).toBe(true);
  });

  test("rejects path traversal, over-long values, and newlines", () => {
    expect(isProfileLabel("../../etc/passwd")).toBe(false);
    expect(isProfileLabel(`chrome:${"a".repeat(300)}`)).toBe(false);
    expect(isProfileLabel("chrome:Default\nchrome:Other")).toBe(false);
  });

  test("bounds the slug as well as the profile", () => {
    // The original pattern bounded only the profile half, so an arbitrarily long
    // slug was accepted and then lowercased before being rejected.
    expect(isProfileLabel(`${"a".repeat(100_000)}:Default`)).toBe(false);
    expect(isProfileLabel(`${"a".repeat(21)}:Default`)).toBe(false);
    expect(isProfileLabel("opera-gx:Default")).toBe(true); // 8 chars, still fine
  });

  test("rejects anything that could escape the user-data directory", () => {
    // The profile half becomes a --profile-directory= argument.
    expect(isProfileLabel("chrome:../../evil")).toBe(false);
    expect(isProfileLabel("chrome:..")).toBe(false);
    expect(isProfileLabel("chrome:a/b")).toBe(false);
    expect(isProfileLabel("chrome:a\\b")).toBe(false);
  });

  test("rejects carriage returns and other control characters", () => {
    // JS `.` already excluded CR and LF, so these held before the pattern was
    // tightened; asserted explicitly so the guarantee is pinned rather than
    // inherited from a regex subtlety nobody remembers.
    expect(isProfileLabel("chrome:Def\rault")).toBe(false);
    expect(isProfileLabel("chrome:Default\r")).toBe(false);
    expect(isProfileLabel("chrome:Def\tault")).toBe(false);
    // ...but a plain space is legitimate and must survive: "Profile 2".
    expect(isProfileLabel("chrome:Guest Profile")).toBe(true);
  });

  test("rejects non-strings and empty profiles", () => {
    expect(isProfileLabel(undefined)).toBe(false);
    expect(isProfileLabel(null)).toBe(false);
    expect(isProfileLabel(42)).toBe(false);
    expect(isProfileLabel({ toString: () => "chrome:Default" })).toBe(false);
    expect(isProfileLabel("chrome:")).toBe(false);
  });
});
