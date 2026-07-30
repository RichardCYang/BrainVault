import { describe, expect, it, vi } from "vitest";
import {
  createServerOutputInspector,
  getBrowserAppCandidates,
  getPrivateBrowserLaunchCandidates,
  openDevelopmentBrowser,
  openPrivateDefaultBrowser
} from "../scripts/dev-browser.mjs";

const TEST_BROWSER_APPS = Object.freeze({
  browserPrivate: "browserPrivate",
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  brave: "brave"
});

describe("development browser launcher", () => {
  it("waits for the explicit post-database server-ready signal", () => {
    const onServerReady = vi.fn();
    const inspect = createServerOutputInspector(onServerReady);

    inspect("MariaDB ready: database=brainvault\n");
    inspect("BrainVault API listening on http://localhost:4000\n");

    expect(onServerReady).not.toHaveBeenCalled();

    inspect("BRAINVAULT_DEV_BROWSER_READY=http://localhost:4000\n");

    expect(onServerReady).toHaveBeenCalledOnce();
    expect(onServerReady).toHaveBeenCalledWith("http://localhost:4000");
  });

  it("handles a ready signal split across output chunks and launches only once", () => {
    const onServerReady = vi.fn();
    const inspect = createServerOutputInspector(onServerReady);

    inspect("BRAINVAULT_DEV_BROWSER_");
    inspect("READY=http://localhost:4567\n");
    inspect("BRAINVAULT_DEV_BROWSER_READY=http://localhost:4567\n");

    expect(onServerReady).toHaveBeenCalledOnce();
    expect(onServerReady).toHaveBeenCalledWith("http://localhost:4567");
  });

  it("always requests private mode, even when a legacy false option is supplied", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);

    await expect(
      openDevelopmentBrowser("http://localhost:4000", {
        privateMode: false,
        openUrl,
        browserApps: TEST_BROWSER_APPS,
        platform: "linux",
        env: {
          BRAINVAULT_DEV_BROWSER_PRIVATE: "false"
        }
      })
    ).resolves.toBe("private");

    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("http://localhost:4000", {
      app: { name: "browserPrivate" }
    });
  });

  it("forces a new app instance on macOS so private arguments are not lost", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);

    await openDevelopmentBrowser("http://localhost:4000", {
      openUrl,
      browserApps: TEST_BROWSER_APPS,
      platform: "darwin"
    });

    expect(openUrl).toHaveBeenCalledWith("http://localhost:4000", {
      app: { name: "browserPrivate" },
      newInstance: true
    });
  });

  it("includes common Windows executable locations for every supported browser", () => {
    const env = {
      LOCALAPPDATA: String.raw`C:\Users\tester\AppData\Local`,
      PROGRAMFILES: String.raw`D:\Programs`,
      "PROGRAMFILES(X86)": String.raw`D:\Programs (x86)`
    };

    expect(getBrowserAppCandidates("chrome", { platform: "win32", env, browserApps: TEST_BROWSER_APPS }))
      .toContain(String.raw`C:\Users\tester\AppData\Local\Google\Chrome\Application\chrome.exe`);
    expect(getBrowserAppCandidates("edge", { platform: "win32", env, browserApps: TEST_BROWSER_APPS }))
      .toContain(String.raw`D:\Programs (x86)\Microsoft\Edge\Application\msedge.exe`);
    expect(getBrowserAppCandidates("firefox", { platform: "win32", env, browserApps: TEST_BROWSER_APPS }))
      .toContain(String.raw`D:\Programs\Mozilla Firefox\firefox.exe`);
    expect(getBrowserAppCandidates("brave", { platform: "win32", env, browserApps: TEST_BROWSER_APPS }))
      .toContain(String.raw`C:\Users\tester\AppData\Local\BraveSoftware\Brave-Browser\Application\brave.exe`);
  });

  it("uses only browser-specific private arguments for direct fallbacks", () => {
    const candidates = getPrivateBrowserLaunchCandidates({
      platform: "linux",
      browserApps: TEST_BROWSER_APPS
    });

    expect(candidates.map(({ id, app }) => [id, app.arguments])).toEqual([
      ["chrome", ["--incognito"]],
      ["edge", ["--inprivate"]],
      ["firefox", ["--private-window"]],
      ["brave", ["--incognito"]]
    ]);
  });

  it("prioritizes Brave and retries with --incognito when default detection rejects its mixed-case ID", async () => {
    const openUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error("Brave is not supported as a default browser"))
      .mockResolvedValueOnce(undefined);

    await expect(
      openPrivateDefaultBrowser("http://localhost:4000", {
        openUrl,
        browserApps: TEST_BROWSER_APPS,
        platform: "win32",
        env: {
          PROGRAMFILES: String.raw`C:\Program Files`
        }
      })
    ).resolves.toBe("brave");

    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenNthCalledWith(1, "http://localhost:4000", {
      app: { name: "browserPrivate" }
    });

    const fallbackOptions = openUrl.mock.calls[1][1];
    expect(fallbackOptions.app.arguments).toEqual(["--incognito"]);
    expect(fallbackOptions.app.name).toContain(
      String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`
    );
  });

  it("skips the ordinary default browser when the private launcher identifier is unavailable", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);

    await expect(
      openPrivateDefaultBrowser("http://localhost:4000", {
        openUrl,
        browserApps: {
          chrome: "chrome",
          edge: "edge",
          firefox: "firefox",
          brave: "brave"
        },
        platform: "linux"
      })
    ).resolves.toBe("chrome");

    expect(openUrl).toHaveBeenCalledOnce();
    expect(openUrl.mock.calls[0][1].app.arguments).toEqual(["--incognito"]);
  });

  it("never falls back to an ordinary browser launch", async () => {
    const openUrl = vi.fn().mockRejectedValue(new Error("not installed"));

    await expect(
      openPrivateDefaultBrowser("http://localhost:4000", {
        openUrl,
        browserApps: TEST_BROWSER_APPS,
        platform: "linux"
      })
    ).rejects.toThrow("Normal-profile fallback is disabled");

    expect(openUrl).toHaveBeenCalledTimes(5);
    for (const call of openUrl.mock.calls) {
      expect(call).toHaveLength(2);
      expect(call[1].app).toBeDefined();
      if (call[1].app.name !== "browserPrivate") {
        expect(call[1].app.arguments).toHaveLength(1);
      }
    }
  });
});
