export type ParsedUserAgent = {
  browserName: string;
  browserVersion: string | null;
  osName: string;
  deviceType: "desktop" | "mobile" | "tablet" | "other";
};

function firstVersion(userAgent: string, patterns: readonly RegExp[]) {
  for (const pattern of patterns) {
    const match = userAgent.match(pattern);
    if (match?.[1]) return match[1].slice(0, 32);
  }
  return null;
}

export function parseUserAgent(userAgentValue: string | null | undefined): ParsedUserAgent {
  const userAgent = String(userAgentValue ?? "").slice(0, 2048);

  let browserName = "Unknown browser";
  let browserVersion: string | null = null;
  if (/EdgA?\//i.test(userAgent)) {
    browserName = "Microsoft Edge";
    browserVersion = firstVersion(userAgent, [/EdgA?\/([\d.]+)/i]);
  } else if (/EdgiOS\//i.test(userAgent)) {
    browserName = "Microsoft Edge";
    browserVersion = firstVersion(userAgent, [/EdgiOS\/([\d.]+)/i]);
  } else if (/OPR\//i.test(userAgent)) {
    browserName = "Opera";
    browserVersion = firstVersion(userAgent, [/OPR\/([\d.]+)/i]);
  } else if (/SamsungBrowser\//i.test(userAgent)) {
    browserName = "Samsung Internet";
    browserVersion = firstVersion(userAgent, [/SamsungBrowser\/([\d.]+)/i]);
  } else if (/FxiOS\//i.test(userAgent)) {
    browserName = "Firefox";
    browserVersion = firstVersion(userAgent, [/FxiOS\/([\d.]+)/i]);
  } else if (/Firefox\//i.test(userAgent)) {
    browserName = "Firefox";
    browserVersion = firstVersion(userAgent, [/Firefox\/([\d.]+)/i]);
  } else if (/CriOS\//i.test(userAgent)) {
    browserName = "Chrome";
    browserVersion = firstVersion(userAgent, [/CriOS\/([\d.]+)/i]);
  } else if (/Chrome\//i.test(userAgent) && !/(?:Edg|OPR|SamsungBrowser)\//i.test(userAgent)) {
    browserName = "Chrome";
    browserVersion = firstVersion(userAgent, [/Chrome\/([\d.]+)/i]);
  } else if (/Safari\//i.test(userAgent) && /Version\//i.test(userAgent)) {
    browserName = "Safari";
    browserVersion = firstVersion(userAgent, [/Version\/([\d.]+)/i]);
  }

  let osName = "Unknown OS";
  const windowsVersion = firstVersion(userAgent, [/Windows NT ([\d.]+)/i]);
  if (windowsVersion) {
    const windowsNames: Record<string, string> = {
      "10.0": "Windows 10/11",
      "6.3": "Windows 8.1",
      "6.2": "Windows 8",
      "6.1": "Windows 7"
    };
    osName = windowsNames[windowsVersion] ?? "Windows";
  } else if (/CrOS/i.test(userAgent)) {
    osName = "ChromeOS";
  } else if (/Android/i.test(userAgent)) {
    const version = firstVersion(userAgent, [/Android\s+([\d.]+)/i]);
    osName = version ? `Android ${version}` : "Android";
  } else if (/(?:iPhone|iPad|iPod)/i.test(userAgent)) {
    const version = firstVersion(userAgent, [/OS\s+([\d_]+)/i])?.replaceAll("_", ".") ?? null;
    osName = version ? `iOS/iPadOS ${version}` : "iOS/iPadOS";
  } else if (/Macintosh|Mac OS X/i.test(userAgent)) {
    const version = firstVersion(userAgent, [/Mac OS X\s+([\d_]+)/i])?.replaceAll("_", ".") ?? null;
    osName = version ? `macOS ${version}` : "macOS";
  } else if (/Linux/i.test(userAgent)) {
    osName = "Linux";
  }

  let deviceType: ParsedUserAgent["deviceType"] = "desktop";
  if (/iPad|Tablet|PlayBook|Silk/i.test(userAgent) || (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent))) {
    deviceType = "tablet";
  } else if (/Mobile|iPhone|iPod|Android/i.test(userAgent)) {
    deviceType = "mobile";
  } else if (!userAgent) {
    deviceType = "other";
  }

  return { browserName, browserVersion, osName, deviceType };
}
