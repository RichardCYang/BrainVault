import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const vpnSource = readFileSync(new URL("../src/lib/vpn-access-policy.ts", import.meta.url), "utf8");
if (!appSource.includes("const browserTimeZoneCacheMs = 5 * 60_000;")) {
  throw new Error("Browser time-zone cache is not present in public/app.js");
}
if (!vpnSource.includes("const timeZoneOffsetFormatters = new Map<string, Intl.DateTimeFormat>();")) {
  throw new Error("VPN time-zone formatter cache is not present in src/lib/vpn-access-policy.ts");
}

const sampleCount = 5;
const browserCallsPerSample = 4_000;
const serverComparisonsPerSample = 500;
const fixedDate = new Date("2026-09-14T12:00:00.000Z");
const timeZonePairs = [
  ["Asia/Seoul", "Asia/Tokyo"],
  ["America/New_York", "Europe/London"],
  ["Europe/Berlin", "Asia/Kolkata"],
  ["Australia/Sydney", "Pacific/Auckland"]
];

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(work) {
  work();
  const samplesMs = [];
  let checksum = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    checksum = work();
    samplesMs.push(performance.now() - startedAt);
  }
  return {
    medianMs: median(samplesMs),
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
    checksum
  };
}

function runFreshBrowserTimeZone() {
  let checksum = 0;
  for (let index = 0; index < browserCallsPerSample; index += 1) {
    const value = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    checksum += value?.length ?? 0;
  }
  return checksum;
}

let cachedBrowserTimeZone = null;
let cachedBrowserTimeZoneExpiresAt = 0;
let simulatedNow = 1_000_000;
function getCachedBrowserTimeZone() {
  if (simulatedNow < cachedBrowserTimeZoneExpiresAt) return cachedBrowserTimeZone;
  const resolved = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  cachedBrowserTimeZone = typeof resolved === "string" && resolved.length > 0 && resolved.length <= 64 ? resolved : null;
  cachedBrowserTimeZoneExpiresAt = simulatedNow + 5 * 60_000;
  return cachedBrowserTimeZone;
}
function runCachedBrowserTimeZone() {
  let checksum = 0;
  for (let index = 0; index < browserCallsPerSample; index += 1) {
    checksum += getCachedBrowserTimeZone()?.length ?? 0;
    simulatedNow += 1;
  }
  return checksum;
}

function isValidTimeZoneFresh(value) {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(fixedDate);
    return true;
  } catch {
    return false;
  }
}

function getTimeZoneOffsetMinutesFresh(timeZone) {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
      hour: "2-digit"
    }).formatToParts(fixedDate).find((item) => item.type === "timeZoneName")?.value;
    if (!part || part === "GMT" || part === "UTC") return 0;
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part);
    if (!match) return null;
    const total = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return match[1] === "-" ? -total : total;
  } catch {
    return null;
  }
}

function hasTimeZoneMismatchFresh(left, right) {
  if (!isValidTimeZoneFresh(left) || !isValidTimeZoneFresh(right)) return false;
  const leftOffset = getTimeZoneOffsetMinutesFresh(left);
  const rightOffset = getTimeZoneOffsetMinutesFresh(right);
  return leftOffset !== null && rightOffset !== null && Math.abs(leftOffset - rightOffset) >= 180;
}

const cachedOffsetFormatters = new Map();
function getCachedOffsetFormatter(timeZone) {
  let formatter = cachedOffsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
      hour: "2-digit"
    });
    cachedOffsetFormatters.set(timeZone, formatter);
  }
  return formatter;
}
function isValidTimeZoneCached(value) {
  if (!value || value.length > 64) return false;
  try {
    getCachedOffsetFormatter(value);
    return true;
  } catch {
    return false;
  }
}
function getTimeZoneOffsetMinutesCached(timeZone) {
  try {
    const part = getCachedOffsetFormatter(timeZone)
      .formatToParts(fixedDate)
      .find((item) => item.type === "timeZoneName")?.value;
    if (!part || part === "GMT" || part === "UTC") return 0;
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part);
    if (!match) return null;
    const total = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return match[1] === "-" ? -total : total;
  } catch {
    return null;
  }
}
function hasTimeZoneMismatchCached(left, right) {
  if (!isValidTimeZoneCached(left) || !isValidTimeZoneCached(right)) return false;
  const leftOffset = getTimeZoneOffsetMinutesCached(left);
  const rightOffset = getTimeZoneOffsetMinutesCached(right);
  return leftOffset !== null && rightOffset !== null && Math.abs(leftOffset - rightOffset) >= 180;
}

function runServerTimeZoneComparison(compare) {
  let checksum = 0;
  for (let index = 0; index < serverComparisonsPerSample; index += 1) {
    const pair = timeZonePairs[index % timeZonePairs.length];
    if (compare(pair[0], pair[1])) checksum += 1;
  }
  return checksum;
}

const browserFresh = benchmark(runFreshBrowserTimeZone);
const browserCached = benchmark(runCachedBrowserTimeZone);
const serverFresh = benchmark(() => runServerTimeZoneComparison(hasTimeZoneMismatchFresh));
const serverCached = benchmark(() => runServerTimeZoneComparison(hasTimeZoneMismatchCached));

if (browserFresh.checksum !== browserCached.checksum) throw new Error("Browser time-zone checksum mismatch");
if (serverFresh.checksum !== serverCached.checksum) throw new Error("Server time-zone checksum mismatch");

console.log(JSON.stringify({
  node: process.version,
  sampleCount,
  browserCallsPerSample,
  browserFresh,
  browserCached,
  browserSpeedup: browserFresh.medianMs / browserCached.medianMs,
  serverComparisonsPerSample,
  serverFresh,
  serverCached,
  serverSpeedup: serverFresh.medianMs / serverCached.medianMs
}, null, 2));
