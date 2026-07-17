import path from "node:path";
import process from "node:process";
import open, { apps } from "open";

const SERVER_READY_PATTERN = /BRAINVAULT_DEV_BROWSER_READY=(https?:\/\/[^\s]+)/;
const MAX_OUTPUT_BUFFER_LENGTH = 16_384;
const UNSUPPORTED_BRAVE_DEFAULT_BROWSER_PATTERN =
  /brave(?: browser)?(?: beta| dev| nightly)? is not supported as a default browser/i;

export function createServerOutputInspector(onServerReady) {
  let browserLaunchStarted = false;
  let outputBuffer = "";

  return (chunk) => {
    outputBuffer += chunk.toString();

    const serverReadyMatch = outputBuffer.match(SERVER_READY_PATTERN);
    if (serverReadyMatch && !browserLaunchStarted) {
      browserLaunchStarted = true;
      onServerReady(serverReadyMatch[1]);
    }

    if (outputBuffer.length > MAX_OUTPUT_BUFFER_LENGTH) {
      outputBuffer = outputBuffer.slice(-MAX_OUTPUT_BUFFER_LENGTH);
    }
  };
}

export function isUnsupportedBraveDefaultBrowserError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return UNSUPPORTED_BRAVE_DEFAULT_BROWSER_PATTERN.test(message);
}

function toAppList(app) {
  return Array.isArray(app) ? app : [app];
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function getBraveAppCandidates({
  platform = process.platform,
  env = process.env,
  fallbackApp = apps.brave
} = {}) {
  if (platform !== "win32") {
    return fallbackApp;
  }

  const installationRoots = uniqueNonEmpty([
    env.PROGRAMFILES,
    env["PROGRAMFILES(X86)"],
    env.LOCALAPPDATA,
    String.raw`C:\Program Files`,
    String.raw`C:\Program Files (x86)`
  ]);

  const executableCandidates = installationRoots.map((root) =>
    path.win32.join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
  );

  return uniqueNonEmpty([...executableCandidates, ...toAppList(fallbackApp)]);
}

export async function openPrivateDefaultBrowser(
  url,
  {
    openUrl = open,
    browserApps = apps,
    platform = process.platform,
    env = process.env
  } = {}
) {
  try {
    await openUrl(url, {
      app: {
        name: browserApps.browserPrivate
      }
    });
    return;
  } catch (error) {
    if (!isUnsupportedBraveDefaultBrowserError(error)) {
      throw error;
    }
  }

  // open@11.0.0 incorrectly rejects Brave on Windows because it checks the
  // mixed-case default-browser ID before normalizing it. Launch Brave directly
  // with its official private-window switch instead of opening a normal window.
  await openUrl(url, {
    app: {
      name: getBraveAppCandidates({
        platform,
        env,
        fallbackApp: browserApps.brave
      }),
      arguments: ["--incognito"]
    },
    newInstance: platform === "darwin"
  });
}
