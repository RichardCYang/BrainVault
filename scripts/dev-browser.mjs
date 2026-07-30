import path from "node:path";
import process from "node:process";
import open, { apps } from "open";

const SERVER_READY_PATTERN = /BRAINVAULT_DEV_BROWSER_READY=(https?:\/\/[^\s]+)/;
const MAX_OUTPUT_BUFFER_LENGTH = 16_384;

const PRIVATE_BROWSER_DEFINITIONS = Object.freeze([
  {
    id: "chrome",
    displayName: "Chrome/Chromium",
    appKey: "chrome",
    privateArguments: ["--incognito"],
    namePattern: /\b(?:google\s+)?chrome\b|\bchromium\b/i
  },
  {
    id: "edge",
    displayName: "Microsoft Edge",
    appKey: "edge",
    privateArguments: ["--inprivate"],
    namePattern: /\b(?:microsoft\s+)?edge\b/i
  },
  {
    id: "firefox",
    displayName: "Firefox",
    appKey: "firefox",
    privateArguments: ["--private-window"],
    namePattern: /\bfirefox\b/i
  },
  {
    id: "brave",
    displayName: "Brave",
    appKey: "brave",
    privateArguments: ["--incognito"],
    namePattern: /\bbrave(?:\s+browser)?\b/i
  }
]);

const PLATFORM_APP_NAMES = Object.freeze({
  darwin: {
    chrome: [
      "google chrome",
      "Google Chrome",
      "Google Chrome Beta",
      "Google Chrome Dev",
      "Google Chrome Canary",
      "chromium",
      "Chromium"
    ],
    edge: ["microsoft edge", "Microsoft Edge", "Microsoft Edge Beta", "Microsoft Edge Dev", "Microsoft Edge Canary"],
    firefox: ["firefox", "Firefox", "Firefox Developer Edition", "Firefox Nightly"],
    brave: ["brave browser", "Brave Browser", "Brave Browser Beta", "Brave Browser Dev", "Brave Browser Nightly"]
  },
  linux: {
    chrome: [
      "google-chrome",
      "google-chrome-stable",
      "google-chrome-beta",
      "google-chrome-unstable",
      "chromium",
      "chromium-browser"
    ],
    edge: ["microsoft-edge", "microsoft-edge-stable", "microsoft-edge-beta", "microsoft-edge-dev"],
    firefox: ["firefox", "firefox-developer-edition", "firefox-nightly"],
    brave: ["brave-browser", "brave-browser-stable", "brave-browser-beta", "brave-browser-dev", "brave-browser-nightly", "brave"]
  },
  win32: {
    chrome: ["chrome", "chrome.exe"],
    edge: ["msedge", "msedge.exe"],
    firefox: ["firefox", "firefox.exe"],
    brave: ["brave", "brave.exe"]
  }
});

const WINDOWS_BROWSER_RELATIVE_PATHS = Object.freeze({
  chrome: [
    ["Google", "Chrome", "Application", "chrome.exe"],
    ["Google", "Chrome Beta", "Application", "chrome.exe"],
    ["Google", "Chrome Dev", "Application", "chrome.exe"],
    ["Google", "Chrome SxS", "Application", "chrome.exe"]
  ],
  edge: [
    ["Microsoft", "Edge", "Application", "msedge.exe"],
    ["Microsoft", "Edge Beta", "Application", "msedge.exe"],
    ["Microsoft", "Edge Dev", "Application", "msedge.exe"],
    ["Microsoft", "Edge SxS", "Application", "msedge.exe"]
  ],
  firefox: [
    ["Mozilla Firefox", "firefox.exe"],
    ["Firefox Developer Edition", "firefox.exe"],
    ["Firefox Nightly", "firefox.exe"]
  ],
  brave: [
    ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    ["BraveSoftware", "Brave-Browser-Beta", "Application", "brave.exe"],
    ["BraveSoftware", "Brave-Browser-Dev", "Application", "brave.exe"],
    ["BraveSoftware", "Brave-Browser-Nightly", "Application", "brave.exe"]
  ]
});

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

function toAppList(app) {
  if (Array.isArray(app)) {
    return app;
  }

  return app === undefined || app === null ? [] : [app];
}

function uniqueNonEmpty(values) {
  return [
    ...new Set(
      values
        .flatMap((value) => toAppList(value))
        .filter((value) => typeof value === "string" && value.trim().length > 0)
    )
  ];
}

function getWindowsInstallationRoots(env) {
  return uniqueNonEmpty([
    env.LOCALAPPDATA,
    env.ProgramW6432,
    env.PROGRAMFILES,
    env["PROGRAMFILES(X86)"],
    String.raw`C:\Program Files`,
    String.raw`C:\Program Files (x86)`
  ]);
}

export function getBrowserAppCandidates(
  browserId,
  {
    platform = process.platform,
    env = process.env,
    browserApps = apps
  } = {}
) {
  const definition = PRIVATE_BROWSER_DEFINITIONS.find(({ id }) => id === browserId);
  if (!definition) {
    throw new Error(`Unsupported private browser identifier: ${browserId}`);
  }

  const detectedApp = browserApps?.[definition.appKey];
  const platformNames = PLATFORM_APP_NAMES[platform]?.[browserId] ?? [];

  if (platform !== "win32") {
    return uniqueNonEmpty([detectedApp, platformNames]);
  }

  const relativePaths = WINDOWS_BROWSER_RELATIVE_PATHS[browserId] ?? [];
  const executablePaths = getWindowsInstallationRoots(env).flatMap((root) =>
    relativePaths.map((segments) => path.win32.join(root, ...segments))
  );

  return uniqueNonEmpty([executablePaths, detectedApp, platformNames]);
}

function identifyBrowserFromError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return PRIVATE_BROWSER_DEFINITIONS.find(({ namePattern }) => namePattern.test(message))?.id;
}

export function getPrivateBrowserLaunchCandidates({
  preferredBrowser,
  platform = process.platform,
  env = process.env,
  browserApps = apps
} = {}) {
  const orderedDefinitions = [...PRIVATE_BROWSER_DEFINITIONS].sort((left, right) => {
    if (left.id === preferredBrowser) {
      return -1;
    }

    if (right.id === preferredBrowser) {
      return 1;
    }

    return 0;
  });

  return orderedDefinitions.map((definition) => ({
    id: definition.id,
    displayName: definition.displayName,
    app: {
      name: getBrowserAppCandidates(definition.id, { platform, env, browserApps }),
      arguments: [...definition.privateArguments]
    }
  }));
}

function withMacNewInstance(options, platform) {
  if (platform !== "darwin") {
    return options;
  }

  return {
    ...options,
    newInstance: true
  };
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function wrapLaunchError(label, error) {
  return new Error(`${label}: ${describeError(error)}`, { cause: error });
}

// Fail closed: every openUrl call below either uses open's browserPrivate
// launcher or supplies a browser-specific private-mode switch. Never add an
// ordinary openUrl(url) fallback here.
export async function openPrivateDefaultBrowser(
  url,
  {
    openUrl = open,
    browserApps = apps,
    platform = process.platform,
    env = process.env
  } = {}
) {
  const launchErrors = [];
  let preferredBrowser;
  const defaultPrivateAppNames = uniqueNonEmpty([browserApps?.browserPrivate]);

  if (defaultPrivateAppNames.length > 0) {
    const defaultPrivateApp = defaultPrivateAppNames.length === 1
      ? defaultPrivateAppNames[0]
      : defaultPrivateAppNames;

    try {
      await openUrl(
        url,
        withMacNewInstance(
          {
            app: {
              name: defaultPrivateApp
            }
          },
          platform
        )
      );
      return "default";
    } catch (error) {
      launchErrors.push(wrapLaunchError("Default browser private-mode launch failed", error));
      preferredBrowser = identifyBrowserFromError(error);
    }
  } else {
    launchErrors.push(
      new Error("Default browser private-mode launcher is unavailable; ordinary default-browser launch was skipped")
    );
  }

  const fallbackCandidates = getPrivateBrowserLaunchCandidates({
    preferredBrowser,
    platform,
    env,
    browserApps
  });

  for (const candidate of fallbackCandidates) {
    if (candidate.app.name.length === 0) {
      continue;
    }

    try {
      await openUrl(url, withMacNewInstance({ app: candidate.app }, platform));
      return candidate.id;
    } catch (error) {
      launchErrors.push(wrapLaunchError(`${candidate.displayName} private-mode launch failed`, error));
    }
  }

  throw new AggregateError(
    launchErrors,
    "Unable to open BrainVault in a private/incognito browser. Normal-profile fallback is disabled."
  );
}

export async function openDevelopmentBrowser(
  url,
  {
    openUrl = open,
    browserApps = apps,
    platform = process.platform,
    env = process.env
  } = {}
) {
  await openPrivateDefaultBrowser(url, { openUrl, browserApps, platform, env });
  return "private";
}
