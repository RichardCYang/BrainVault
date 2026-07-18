import { describe, expect, it, vi } from "vitest";
import {
  createServerOutputInspector,
  getBraveAppCandidates,
  isPrivateBrowserRequested,
  isUnsupportedBraveDefaultBrowserError,
  openDevelopmentBrowser,
  openPrivateDefaultBrowser
} from "../scripts/dev-browser.mjs";

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

  it("uses a durable normal browser profile unless private mode is explicitly requested", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);

    expect(isPrivateBrowserRequested("")).toBe(false);
    expect(isPrivateBrowserRequested("false")).toBe(false);
    expect(isPrivateBrowserRequested("true")).toBe(true);
    expect(isPrivateBrowserRequested("1")).toBe(true);

    await expect(openDevelopmentBrowser("http://localhost:4000", { openUrl })).resolves.toBe("normal");
    expect(openUrl).toHaveBeenCalledWith("http://localhost:4000");
  });

  it("opens private mode only when explicitly requested", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);

    await expect(
      openDevelopmentBrowser("http://localhost:4000", {
        privateMode: true,
        openUrl,
        browserApps: { browserPrivate: "browserPrivate", brave: "brave" }
      })
    ).resolves.toBe("private");

    expect(openUrl).toHaveBeenCalledWith("http://localhost:4000", {
      app: { name: "browserPrivate" }
    });
  });

  it("recognizes the mixed-case Brave default-browser failure", () => {
    expect(
      isUnsupportedBraveDefaultBrowserError(
        new Error("Brave is not supported as a default browser")
      )
    ).toBe(true);
    expect(
      isUnsupportedBraveDefaultBrowserError(
        new Error("Firefox is not supported as a default browser")
      )
    ).toBe(false);
  });

  it("includes common Windows Brave executable locations", () => {
    const candidates = getBraveAppCandidates({
      platform: "win32",
      env: {
        PROGRAMFILES: String.raw`D:\Programs`,
        "PROGRAMFILES(X86)": String.raw`D:\Programs (x86)`,
        LOCALAPPDATA: String.raw`C:\Users\tester\AppData\Local`
      },
      fallbackApp: "brave"
    });

    expect(candidates).toContain(
      String.raw`D:\Programs\BraveSoftware\Brave-Browser\Application\brave.exe`
    );
    expect(candidates).toContain(
      String.raw`C:\Users\tester\AppData\Local\BraveSoftware\Brave-Browser\Application\brave.exe`
    );
    expect(candidates.at(-1)).toBe("brave");
  });

  it("falls back to Brave with --incognito when open misclassifies the default browser", async () => {
    const openUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error("Brave is not supported as a default browser"))
      .mockResolvedValueOnce(undefined);

    await openPrivateDefaultBrowser("http://localhost:4000", {
      openUrl,
      browserApps: {
        browserPrivate: "browserPrivate",
        brave: "brave"
      },
      platform: "win32",
      env: {
        PROGRAMFILES: String.raw`C:\Program Files`
      }
    });

    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenNthCalledWith(1, "http://localhost:4000", {
      app: {
        name: "browserPrivate"
      }
    });

    const fallbackOptions = openUrl.mock.calls[1][1];
    expect(fallbackOptions.app.arguments).toEqual(["--incognito"]);
    expect(fallbackOptions.app.name).toContain(
      String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`
    );
    expect(fallbackOptions.newInstance).toBe(false);
  });

  it("does not use the Brave fallback for unrelated launch failures", async () => {
    const error = new Error("Browser executable could not be started");
    const openUrl = vi.fn().mockRejectedValue(error);

    await expect(
      openPrivateDefaultBrowser("http://localhost:4000", {
        openUrl,
        browserApps: {
          browserPrivate: "browserPrivate",
          brave: "brave"
        }
      })
    ).rejects.toBe(error);

    expect(openUrl).toHaveBeenCalledOnce();
  });
});
