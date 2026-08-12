import type { Request } from "express";
import { db, type DbClient } from "./db.js";
import { normalizeIsoCountryCode, type IsoCountryCode } from "./country-codes.js";
import { isPublicCountryLookupIp, normalizeCountryLookupIp } from "./geo-country.js";
import { ApiError } from "./http.js";
import { matchVpnGateRelay, resetVpnGateRelayCacheForTests } from "./vpngate-relays.js";
import {
  recordCountryLoginBlock,
  resolveCountryLoginLocation,
  type CountryLoginBlockReason
} from "./country-login-policy.js";

export type VpnRiskVerdict = "CLEAR" | "VPN" | "VPN_GATE" | "PROXY" | "TOR" | "UNKNOWN";
export type VpnBlockReason = Extract<
  CountryLoginBlockReason,
  "VPN_DETECTED" | "VPN_GATE_DETECTED" | "PROXY_DETECTED" | "TOR_DETECTED"
>;

export type VpnProviderSignal = {
  provider: "ipquery" | "ipapi";
  available: boolean;
  vpn: boolean;
  proxy: boolean;
  tor: boolean;
  datacenter: boolean;
  riskScore: number | null;
  countryCode: IsoCountryCode | null;
  timezone: string | null;
  organization: string | null;
  asn: string | null;
};

export type ClientWebRtcState = "ABSENT" | "AVAILABLE" | "DISABLED" | "UNAVAILABLE";

export type ClientWebRtcSignal = {
  state: ClientWebRtcState;
  observedIps: string[];
};

export type VpnRiskResolution = {
  ipAddress: string;
  countryCode: IsoCountryCode | null;
  verdict: VpnRiskVerdict;
  blocked: boolean;
  reason: VpnBlockReason | null;
  confidence: number;
  datacenter: boolean;
  timezoneMismatch: boolean;
  providerCount: number;
  webRtcState: ClientWebRtcState;
  webRtcObservedIps: string[];
  webRtcIpMismatch: boolean;
  supportingSignals: string[];
};

type VpnRiskCacheEntry = {
  resolution: VpnRiskResolution;
  expiresAt: number;
};

const ipQueryEndpoint = "https://api.ipquery.io";
const ipApiEndpoint = "https://api.ipapi.is/";
const torExitListEndpoint = "https://check.torproject.org/exit-addresses";
const providerTimeoutMs = 2_500;
const providerMaxBytes = 128 * 1024;
const torListTimeoutMs = 4_000;
const torListMaxBytes = 4 * 1024 * 1024;
const torListRefreshMs = 60 * 60_000;
const torListStaleMs = 6 * 60 * 60_000;
const positiveRiskCacheMs = 10 * 60_000;
const vpnGatePositiveRiskCacheMs = 2 * 60_000;
const clearRiskCacheMs = 5 * 60_000;
const unknownRiskCacheMs = 60_000;
const maxRiskCacheEntries = 4_096;
const timezoneMismatchThresholdMinutes = 180;
const maxClientWebRtcHeaderLength = 256;
const maxClientWebRtcObservedIps = 4;

const absentClientWebRtcSignal: ClientWebRtcSignal = Object.freeze({
  state: "ABSENT",
  observedIps: []
});

const riskCache = new Map<string, VpnRiskCacheEntry>();
let torExitAddresses = new Set<string>();
let torExitListFetchedAt = 0;
let torExitListInFlight: Promise<Set<string>> | null = null;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanField(object: Record<string, unknown>, key: string) {
  return object[key] === true;
}

function stringField(object: Record<string, unknown>, key: string) {
  const value = object[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(object: Record<string, unknown>, key: string) {
  const value = Number(object[key]);
  return Number.isFinite(value) ? value : null;
}

function emptyProviderSignal(provider: VpnProviderSignal["provider"]): VpnProviderSignal {
  return {
    provider,
    available: false,
    vpn: false,
    proxy: false,
    tor: false,
    datacenter: false,
    riskScore: null,
    countryCode: null,
    timezone: null,
    organization: null,
    asn: null
  };
}

async function fetchLimitedText(url: string, timeoutMs: number, maxBytes: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain;q=0.9",
        "User-Agent": "BrainVault/1.0 VPN-access-policy"
      },
      redirect: "error"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("Response exceeded the configured size limit");
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("Response exceeded the configured size limit");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonObject(url: string) {
  const text = await fetchLimitedText(url, providerTimeoutMs, providerMaxBytes);
  const payload: unknown = JSON.parse(text);
  if (!isObject(payload)) throw new Error("Provider response was not an object");
  return payload;
}

function normalizeProviderIp(value: unknown) {
  return typeof value === "string" ? normalizeCountryLookupIp(value) : null;
}

async function queryIpQuery(ipAddress: string): Promise<VpnProviderSignal> {
  try {
    const payload = await fetchJsonObject(`${ipQueryEndpoint}/${encodeURIComponent(ipAddress)}`);
    if (normalizeProviderIp(payload.ip) !== ipAddress) throw new Error("Provider IP mismatch");
    const risk = isObject(payload.risk) ? payload.risk : {};
    const location = isObject(payload.location) ? payload.location : {};
    const isp = isObject(payload.isp) ? payload.isp : {};
    return {
      provider: "ipquery",
      available: true,
      vpn: booleanField(risk, "is_vpn"),
      proxy: booleanField(risk, "is_proxy"),
      tor: booleanField(risk, "is_tor"),
      datacenter: booleanField(risk, "is_datacenter"),
      riskScore: numberField(risk, "risk_score"),
      countryCode: normalizeIsoCountryCode(stringField(location, "country_code")),
      timezone: stringField(location, "timezone"),
      organization: stringField(isp, "org") ?? stringField(isp, "isp"),
      asn: stringField(isp, "asn")
    };
  } catch {
    return emptyProviderSignal("ipquery");
  }
}

async function queryIpApi(ipAddress: string): Promise<VpnProviderSignal> {
  try {
    const payload = await fetchJsonObject(`${ipApiEndpoint}?q=${encodeURIComponent(ipAddress)}`);
    if (normalizeProviderIp(payload.ip) !== ipAddress) throw new Error("Provider IP mismatch");
    const asn = isObject(payload.asn) ? payload.asn : {};
    const company = isObject(payload.company) ? payload.company : {};
    const location = isObject(payload.location) ? payload.location : {};
    return {
      provider: "ipapi",
      available: true,
      vpn: booleanField(payload, "is_vpn"),
      proxy: booleanField(payload, "is_proxy"),
      tor: booleanField(payload, "is_tor"),
      datacenter: booleanField(payload, "is_datacenter"),
      riskScore: null,
      countryCode: normalizeIsoCountryCode(stringField(payload, "cc") ?? stringField(location, "country_code")),
      timezone: stringField(location, "timezone"),
      organization:
        stringField(payload, "company_name")
        ?? stringField(payload, "asn_org")
        ?? stringField(company, "name")
        ?? stringField(asn, "org")
        ?? stringField(asn, "description"),
      asn: stringField(payload, "asn_num") ?? stringField(asn, "asn")
    };
  } catch {
    return emptyProviderSignal("ipapi");
  }
}

async function refreshTorExitAddresses() {
  const now = Date.now();
  if (torExitAddresses.size > 0 && now - torExitListFetchedAt < torListRefreshMs) {
    return torExitAddresses;
  }
  if (torExitListInFlight) return torExitListInFlight;

  torExitListInFlight = (async () => {
    try {
      const text = await fetchLimitedText(torExitListEndpoint, torListTimeoutMs, torListMaxBytes);
      const next = new Set<string>();
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("ExitAddress ")) continue;
        const rawIp = line.split(/\s+/)[1] ?? "";
        const normalizedIp = normalizeCountryLookupIp(rawIp);
        if (normalizedIp && isPublicCountryLookupIp(normalizedIp)) next.add(normalizedIp);
      }
      if (!next.size) throw new Error("Tor exit list was empty");
      torExitAddresses = next;
      torExitListFetchedAt = Date.now();
    } catch {
      if (Date.now() - torExitListFetchedAt > torListStaleMs) {
        torExitAddresses = new Set<string>();
      }
    } finally {
      torExitListInFlight = null;
    }
    return torExitAddresses;
  })();

  return torExitListInFlight;
}

function isValidTimeZone(value: string | null | undefined): value is string {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getTimeZoneOffsetMinutes(timeZone: string, date = new Date()) {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
      hour: "2-digit"
    }).formatToParts(date).find((item) => item.type === "timeZoneName")?.value;
    if (!part || part === "GMT" || part === "UTC") return 0;
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part);
    if (!match) return null;
    const hours = Number(match[2]);
    const minutes = Number(match[3] ?? 0);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return null;
    const total = hours * 60 + minutes;
    return match[1] === "-" ? -total : total;
  } catch {
    return null;
  }
}

export function getClientTimeZone(req: Request) {
  const raw = req.get("x-brainvault-timezone")?.trim() ?? "";
  return isValidTimeZone(raw) ? raw : null;
}

function normalizeClientWebRtcSignal(signal: ClientWebRtcSignal | null | undefined): ClientWebRtcSignal {
  if (!signal) return absentClientWebRtcSignal;
  const observedIps = Array.from(new Set(
    (Array.isArray(signal.observedIps) ? signal.observedIps : [])
      .map((value) => normalizeCountryLookupIp(String(value)))
      .filter((value): value is string => Boolean(value && isPublicCountryLookupIp(value)))
  )).slice(0, maxClientWebRtcObservedIps);

  if (signal.state === "AVAILABLE" && observedIps.length > 0) {
    return { state: "AVAILABLE", observedIps };
  }
  if (signal.state === "DISABLED") return { state: "DISABLED", observedIps: [] };
  if (signal.state === "UNAVAILABLE") return { state: "UNAVAILABLE", observedIps: [] };
  return absentClientWebRtcSignal;
}

export function getClientWebRtcSignal(req: Request): ClientWebRtcSignal {
  const rawState = req.get("x-brainvault-webrtc-state")?.trim().toLowerCase() ?? "";
  if (rawState === "disabled") return { state: "DISABLED", observedIps: [] };
  if (rawState === "unavailable") return { state: "UNAVAILABLE", observedIps: [] };
  if (rawState !== "available") return absentClientWebRtcSignal;

  const rawIps = req.get("x-brainvault-webrtc-ips")?.trim() ?? "";
  if (!rawIps || rawIps.length > maxClientWebRtcHeaderLength) return absentClientWebRtcSignal;
  return normalizeClientWebRtcSignal({
    state: "AVAILABLE",
    observedIps: rawIps.split(",").map((value) => value.trim()).filter(Boolean)
  });
}

function hasTimezoneMismatch(ipTimeZone: string | null, clientTimeZone: string | null) {
  if (!isValidTimeZone(ipTimeZone) || !isValidTimeZone(clientTimeZone)) return false;
  const ipOffset = getTimeZoneOffsetMinutes(ipTimeZone);
  const clientOffset = getTimeZoneOffsetMinutes(clientTimeZone);
  return ipOffset !== null
    && clientOffset !== null
    && Math.abs(ipOffset - clientOffset) >= timezoneMismatchThresholdMinutes;
}

function chooseCountryCode(signals: readonly VpnProviderSignal[]) {
  for (const signal of signals) {
    if (signal.countryCode) return signal.countryCode;
  }
  return null;
}

export function evaluateVpnSignals(
  signals: readonly VpnProviderSignal[],
  {
    torListMatch = false,
    timezoneMismatch = false,
    vpnGateListed = false,
    vpnGateDnsVerified = false,
    webRtcState = "ABSENT",
    webRtcIpMismatch = false
  }: {
    torListMatch?: boolean;
    timezoneMismatch?: boolean;
    vpnGateListed?: boolean;
    vpnGateDnsVerified?: boolean;
    webRtcState?: ClientWebRtcState;
    webRtcIpMismatch?: boolean;
  } = {}
): Omit<VpnRiskResolution, "ipAddress" | "countryCode" | "webRtcObservedIps" | "webRtcState" | "webRtcIpMismatch"> {
  const available = signals.filter((signal) => signal.available);
  const datacenter = available.some((signal) => signal.datacenter);
  const supportingSignals: string[] = [];
  if (datacenter) supportingSignals.push("DATACENTER_NETWORK");
  if (timezoneMismatch) supportingSignals.push("TIMEZONE_OFFSET_MISMATCH");
  if (vpnGateListed) supportingSignals.push("VPN_GATE_PUBLIC_RELAY_DIRECTORY");
  if (available.some((signal) => (signal.riskScore ?? 0) >= 75)) supportingSignals.push("HIGH_PROVIDER_RISK_SCORE");
  if (webRtcState === "AVAILABLE") {
    supportingSignals.push(webRtcIpMismatch ? "WEBRTC_HTTP_IP_MISMATCH" : "WEBRTC_HTTP_IP_MATCH");
  } else if (webRtcState === "DISABLED") {
    supportingSignals.push("WEBRTC_DISABLED");
  } else if (webRtcState === "UNAVAILABLE") {
    supportingSignals.push("WEBRTC_STUN_UNAVAILABLE");
  }

  if (torListMatch) {
    return {
      verdict: "TOR",
      blocked: true,
      reason: "TOR_DETECTED",
      confidence: 100,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals: ["TOR_AUTHORITATIVE_EXIT_LIST", ...supportingSignals]
    };
  }

  const torVotes = available.filter((signal) => signal.tor).length;
  const vpnVotes = available.filter((signal) => signal.vpn).length;
  const proxyVotes = available.filter((signal) => signal.proxy).length;
  const suspiciousVotes = available.filter((signal) => signal.vpn || signal.proxy || signal.tor).length;

  if (torVotes >= 2 || (torVotes === 1 && available.length === 1)) {
    return {
      verdict: "TOR",
      blocked: true,
      reason: "TOR_DETECTED",
      confidence: torVotes >= 2 ? 99 : 96,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals: ["TOR_PROVIDER_SIGNAL", ...supportingSignals]
    };
  }

  if (vpnGateDnsVerified) {
    return {
      verdict: "VPN_GATE",
      blocked: true,
      reason: "VPN_GATE_DETECTED",
      confidence: 100,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals: ["VPN_GATE_DIRECTORY_DDNS_VERIFIED", ...supportingSignals]
    };
  }

  if (vpnGateListed && suspiciousVotes > 0) {
    return {
      verdict: "VPN_GATE",
      blocked: true,
      reason: "VPN_GATE_DETECTED",
      confidence: 99,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals: ["VPN_GATE_DIRECTORY_PROVIDER_CORROBORATED", ...supportingSignals]
    };
  }

  if (vpnVotes >= 2 || (vpnVotes === 1 && proxyVotes + torVotes >= 1)) {
    return {
      verdict: "VPN",
      blocked: true,
      reason: "VPN_DETECTED",
      confidence: vpnVotes >= 2 ? 99 : 97,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals: ["MULTI_PROVIDER_VPN_SIGNAL", ...supportingSignals]
    };
  }

  if (vpnVotes === 1 && available.length === 1) {
    return {
      verdict: "VPN",
      blocked: true,
      reason: "VPN_DETECTED",
      confidence: 94,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals: ["DIRECT_VPN_PROVIDER_SIGNAL", ...supportingSignals]
    };
  }

  if (proxyVotes >= 2 || (proxyVotes === 1 && torVotes + vpnVotes >= 1)) {
    return {
      verdict: "PROXY",
      blocked: true,
      reason: "PROXY_DETECTED",
      confidence: proxyVotes >= 2 ? 98 : 96,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals: ["MULTI_PROVIDER_PROXY_SIGNAL", ...supportingSignals]
    };
  }

  if (proxyVotes === 1 && available.length === 1) {
    return {
      verdict: "PROXY",
      blocked: true,
      reason: "PROXY_DETECTED",
      confidence: 92,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals: ["DIRECT_PROXY_PROVIDER_SIGNAL", ...supportingSignals]
    };
  }

  if (!available.length) {
    return {
      verdict: "UNKNOWN",
      blocked: false,
      reason: null,
      confidence: 0,
      datacenter: false,
      timezoneMismatch,
      providerCount: 0,
      supportingSignals: ["VPN_VERIFICATION_UNAVAILABLE", ...supportingSignals]
    };
  }

  if (vpnGateListed) {
    return {
      verdict: "UNKNOWN",
      blocked: false,
      reason: null,
      confidence: 0,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals: ["VPN_GATE_DIRECTORY_UNVERIFIED", ...supportingSignals]
    };
  }

  if (suspiciousVotes > 0) {
    return {
      verdict: "UNKNOWN",
      blocked: false,
      reason: null,
      confidence: 0,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals: ["PROVIDER_DISAGREEMENT", ...supportingSignals]
    };
  }

  if (webRtcIpMismatch) {
    return {
      verdict: "UNKNOWN",
      blocked: false,
      reason: null,
      confidence: 0,
      datacenter,
      timezoneMismatch,
      providerCount: available.length,
      supportingSignals
    };
  }

  const baseClearConfidence = available.length >= 2 ? 90 : 82;
  const clearConfidence = webRtcState === "DISABLED"
    ? Math.min(baseClearConfidence, 70)
    : webRtcState === "UNAVAILABLE"
      ? Math.min(baseClearConfidence, 76)
      : baseClearConfidence;
  return {
    verdict: "CLEAR",
    blocked: false,
    reason: null,
    confidence: clearConfidence,
    datacenter,
    timezoneMismatch,
    providerCount: available.length,
    supportingSignals
  };
}

function rememberRiskResolution(cacheKey: string, resolution: VpnRiskResolution) {
  const ttl = resolution.blocked
    ? resolution.verdict === "VPN_GATE"
      ? vpnGatePositiveRiskCacheMs
      : positiveRiskCacheMs
    : resolution.verdict === "UNKNOWN"
      ? unknownRiskCacheMs
      : clearRiskCacheMs;
  riskCache.delete(cacheKey);
  riskCache.set(cacheKey, { resolution, expiresAt: Date.now() + ttl });
  while (riskCache.size > maxRiskCacheEntries) {
    const oldestKey = riskCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    riskCache.delete(oldestKey);
  }
}

function shouldCrossCheck(primary: VpnProviderSignal, timezoneMismatch: boolean, webRtcAuxiliaryRisk: boolean) {
  return primary.available && (
    primary.vpn
    || primary.proxy
    || primary.tor
    || primary.datacenter
    || (primary.riskScore ?? 0) >= 50
    || timezoneMismatch
    || webRtcAuxiliaryRisk
  );
}

function createRiskCacheKey(
  ipAddress: string,
  clientTimeZone: string | null,
  webRtcSignal: ClientWebRtcSignal,
  webRtcIpMismatch: boolean
) {
  const webRtcCacheState = webRtcSignal.state === "AVAILABLE"
    ? `AVAILABLE:${webRtcIpMismatch ? "MISMATCH" : "MATCH"}`
    : webRtcSignal.state;
  return [
    ipAddress,
    isValidTimeZone(clientTimeZone) ? clientTimeZone : "",
    webRtcCacheState
  ].join("|");
}

export async function resolveVpnAccessRisk(
  ipAddress: string,
  clientTimeZone: string | null = null,
  clientWebRtcSignal: ClientWebRtcSignal | null = null
): Promise<VpnRiskResolution> {
  const normalizedIp = normalizeCountryLookupIp(ipAddress);
  const webRtcSignal = normalizeClientWebRtcSignal(clientWebRtcSignal);
  if (!normalizedIp || !isPublicCountryLookupIp(normalizedIp)) {
    return {
      ipAddress: (normalizedIp ?? ipAddress) || "unknown",
      countryCode: null,
      verdict: "UNKNOWN",
      blocked: false,
      reason: null,
      confidence: 0,
      datacenter: false,
      timezoneMismatch: false,
      providerCount: 0,
      webRtcState: webRtcSignal.state,
      webRtcObservedIps: webRtcSignal.observedIps,
      webRtcIpMismatch: false,
      supportingSignals: webRtcSignal.state === "DISABLED"
        ? ["WEBRTC_DISABLED"]
        : webRtcSignal.state === "UNAVAILABLE"
          ? ["WEBRTC_STUN_UNAVAILABLE"]
          : []
    };
  }

  const webRtcIpMismatch = webRtcSignal.state === "AVAILABLE"
    && !webRtcSignal.observedIps.includes(normalizedIp);
  const webRtcAuxiliaryRisk = webRtcIpMismatch
    || webRtcSignal.state === "DISABLED"
    || webRtcSignal.state === "UNAVAILABLE";
  const cacheKey = createRiskCacheKey(normalizedIp, clientTimeZone, webRtcSignal, webRtcIpMismatch);
  const cached = riskCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.resolution,
      webRtcObservedIps: webRtcSignal.observedIps
    };
  }

  const [torExits, vpnGate, primary] = await Promise.all([
    refreshTorExitAddresses(),
    matchVpnGateRelay(normalizedIp),
    queryIpQuery(normalizedIp)
  ]);
  const torListMatch = torExits.has(normalizedIp);
  const primaryTimezoneMismatch = hasTimezoneMismatch(primary.timezone, clientTimeZone);
  const secondary = !vpnGate.dnsVerified
    && (!primary.available || torListMatch || vpnGate.listed || webRtcAuxiliaryRisk
      || shouldCrossCheck(primary, primaryTimezoneMismatch, webRtcAuxiliaryRisk))
      ? await queryIpApi(normalizedIp)
      : emptyProviderSignal("ipapi");
  const timezoneMismatch = primaryTimezoneMismatch || hasTimezoneMismatch(secondary.timezone, clientTimeZone);
  const signals = [primary, secondary];
  const decision = evaluateVpnSignals(signals, {
    torListMatch,
    timezoneMismatch,
    vpnGateListed: vpnGate.listed,
    vpnGateDnsVerified: vpnGate.dnsVerified,
    webRtcState: webRtcSignal.state,
    webRtcIpMismatch
  });
  let countryCode = chooseCountryCode(signals) ?? vpnGate.countryCode;

  if (!countryCode && decision.blocked) {
    const location = await resolveCountryLoginLocation(normalizedIp);
    countryCode = location.countryCode;
  }

  const resolution: VpnRiskResolution = {
    ipAddress: normalizedIp,
    countryCode,
    webRtcState: webRtcSignal.state,
    webRtcObservedIps: webRtcSignal.observedIps,
    webRtcIpMismatch,
    ...decision
  };
  rememberRiskResolution(cacheKey, resolution);
  return resolution;
}

export function normalizeVpnBlockEnabled(value: unknown) {
  if (value === undefined || value === null || value === false || value === 0 || value === "0") return false;
  if (value === true || value === 1 || value === "1") return true;
  throw new ApiError(500, "VPN_POLICY_INVALID", "Stored VPN access policy is invalid");
}

async function getVpnBlockEnabled(userId: string, enabledHint: unknown, client: DbClient) {
  if (enabledHint !== undefined && enabledHint !== null) return normalizeVpnBlockEnabled(enabledHint);
  const row = await client.queryOne<{ vpn_block_enabled: unknown }>(
    "SELECT vpn_block_enabled FROM users WHERE id = ?",
    [userId]
  );
  return normalizeVpnBlockEnabled(row?.vpn_block_enabled);
}

export async function enforceVpnAccessPolicy(
  userId: string,
  enabledHint: unknown,
  ipAddress: string,
  clientTimeZone: string | null = null,
  clientWebRtcSignal: ClientWebRtcSignal | null = null,
  client: DbClient = db
) {
  const enabled = await getVpnBlockEnabled(userId, enabledHint, client);
  if (!enabled) return null;

  const resolution = await resolveVpnAccessRisk(ipAddress, clientTimeZone, clientWebRtcSignal);
  if (resolution.supportingSignals.includes("VPN_VERIFICATION_UNAVAILABLE")) {
    throw new ApiError(
      503,
      "VPN_VERIFICATION_UNAVAILABLE",
      "VPN access policy could not be verified because the risk providers are unavailable"
    );
  }
  if (!resolution.blocked || !resolution.reason) return resolution;

  await recordCountryLoginBlock(
    userId,
    resolution.ipAddress || ipAddress || "unknown",
    resolution.countryCode,
    resolution.reason,
    client
  );
  throw new ApiError(
    403,
    "VPN_ACCESS_BLOCKED",
    "Access from a VPN, proxy, or Tor exit is blocked by the account security policy",
    {
      countryCode: resolution.countryCode,
      reason: resolution.reason,
      confidence: resolution.confidence
    }
  );
}

export async function assertVpnPolicyAllowsCurrentConnection(
  enabled: boolean,
  ipAddress: string,
  clientTimeZone: string | null = null,
  clientWebRtcSignal: ClientWebRtcSignal | null = null
) {
  const resolution = await resolveVpnAccessRisk(ipAddress, clientTimeZone, clientWebRtcSignal);
  if (enabled && resolution.blocked) {
    throw new ApiError(
      400,
      "VPN_POLICY_WOULD_BLOCK_CURRENT_IP",
      "The VPN access policy would immediately block the IP address changing this setting",
      {
        countryCode: resolution.countryCode,
        reason: resolution.reason,
        confidence: resolution.confidence
      }
    );
  }
  return resolution;
}

export function resetVpnAccessPolicyCachesForTests() {
  riskCache.clear();
  torExitAddresses = new Set<string>();
  torExitListFetchedAt = 0;
  torExitListInFlight = null;
  resetVpnGateRelayCacheForTests();
}
