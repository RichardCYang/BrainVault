import { resolve4, resolve6 } from "node:dns/promises";
import { normalizeIsoCountryCode, type IsoCountryCode } from "./country-codes.js";
import { isPublicCountryLookupIp, normalizeCountryLookupIp } from "./geo-country.js";

export type VpnGateRelayRecord = {
  ipAddress: string;
  countryCode: IsoCountryCode | null;
  hostnames: string[];
};

export type VpnGateRelayMatch = {
  listed: boolean;
  dnsVerified: boolean;
  countryCode: IsoCountryCode | null;
  hostname: string | null;
};

const vpnGateCsvEndpoint = "https://www.vpngate.net/api/iphone/";
const vpnGateFetchTimeoutMs = 4_000;
const vpnGateDnsTimeoutMs = 1_500;
const vpnGateMaxBytes = 8 * 1024 * 1024;
const vpnGateRefreshMs = 5 * 60_000;
const vpnGateStaleMs = 15 * 60_000;
const vpnGateMaxRows = 20_000;
const vpnGateMaxHostnamesPerIp = 4;

let vpnGateRelays = new Map<string, VpnGateRelayRecord>();
let vpnGateRelaysFetchedAt = 0;
let vpnGateRelaysInFlight: Promise<Map<string, VpnGateRelayRecord>> | null = null;

function parseCsvRow(line: string) {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      fields.push(field);
      field = "";
      continue;
    }
    field += char;
  }
  fields.push(field);
  return quoted ? null : fields;
}

function normalizeVpnGateHostname(value: unknown) {
  if (typeof value !== "string") return null;
  let hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (!hostname) return null;
  if (!hostname.includes(".")) hostname = `${hostname}.opengw.net`;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*opengw\.net$/.test(hostname)) return null;
  if (hostname.length > 253) return null;
  return hostname;
}

function createVpnGateCsvParser() {
  const relays = new Map<string, VpnGateRelayRecord>();
  let parserState: "SEARCHING_HEADER" | "READING_ROWS" | "DONE" = "SEARCHING_HEADER";
  let hostnameIndex = -1;
  let ipIndex = -1;
  let countryIndex = -1;
  let acceptedRows = 0;

  return {
    relays,
    get done() {
      return parserState === "DONE";
    },
    pushLine(line: string) {
      if (parserState === "DONE") return;

      if (parserState === "SEARCHING_HEADER") {
        if (!line.startsWith("#HostName,")) return;
        const header = parseCsvRow(line.slice(1));
        if (!header) {
          parserState = "DONE";
          return;
        }
        hostnameIndex = header.indexOf("HostName");
        ipIndex = header.indexOf("IP");
        countryIndex = header.indexOf("CountryShort");
        if (hostnameIndex < 0 || ipIndex < 0 || countryIndex < 0) {
          parserState = "DONE";
          return;
        }
        parserState = "READING_ROWS";
        return;
      }

      if (!line || line.startsWith("*")) return;
      const fields = parseCsvRow(line);
      if (!fields) return;
      const rawIp = fields[ipIndex] ?? "";
      const ipAddress = normalizeCountryLookupIp(rawIp);
      if (!ipAddress || !isPublicCountryLookupIp(ipAddress)) return;

      const hostname = normalizeVpnGateHostname(fields[hostnameIndex]);
      if (!hostname) return;
      const countryCode = normalizeIsoCountryCode(fields[countryIndex]);
      const existing = relays.get(ipAddress);
      if (existing) {
        if (!existing.hostnames.includes(hostname) && existing.hostnames.length < vpnGateMaxHostnamesPerIp) {
          existing.hostnames.push(hostname);
        }
        if (!existing.countryCode && countryCode) existing.countryCode = countryCode;
      } else {
        relays.set(ipAddress, { ipAddress, countryCode, hostnames: [hostname] });
      }

      acceptedRows += 1;
      if (acceptedRows >= vpnGateMaxRows) parserState = "DONE";
    }
  };
}

function pushVpnGateCsvText(parser: ReturnType<typeof createVpnGateCsvParser>, text: string) {
  let lineStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    const lineEnd = index > lineStart && text.charCodeAt(index - 1) === 13 ? index - 1 : index;
    parser.pushLine(text.slice(lineStart, lineEnd));
    if (parser.done) return;
    lineStart = index + 1;
  }
  parser.pushLine(text.slice(lineStart));
}

export function parseVpnGateCsv(text: string) {
  const parser = createVpnGateCsvParser();
  pushVpnGateCsvText(parser, text);
  return parser.relays;
}

function pushVpnGateCsvDecodedChunk(
  parser: ReturnType<typeof createVpnGateCsvParser>,
  pendingText: string,
  decodedText: string
) {
  const text = pendingText + decodedText;
  let lineStart = 0;
  while (!parser.done) {
    const newlineIndex = text.indexOf("\n", lineStart);
    if (newlineIndex < 0) break;
    const lineEnd = newlineIndex > lineStart && text.charCodeAt(newlineIndex - 1) === 13
      ? newlineIndex - 1
      : newlineIndex;
    parser.pushLine(text.slice(lineStart, lineEnd));
    lineStart = newlineIndex + 1;
  }
  return parser.done ? "" : text.slice(lineStart);
}

async function fetchVpnGateRelays() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), vpnGateFetchTimeoutMs);
  try {
    const response = await fetch(vpnGateCsvEndpoint, {
      signal: controller.signal,
      headers: {
        Accept: "text/csv, text/plain;q=0.9",
        "User-Agent": "BrainVault/1.0 VPNGate-access-policy"
      },
      redirect: "error"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const contentLength = Number(declaredLength);
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > vpnGateMaxBytes) {
        throw new Error("VPN Gate directory exceeded the configured size limit");
      }
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("VPN Gate directory did not contain a body");

    const parser = createVpnGateCsvParser();
    const decoder = new TextDecoder();
    let pendingText = "";
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        totalBytes += value.byteLength;
        if (totalBytes > vpnGateMaxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error("VPN Gate directory exceeded the configured size limit");
        }
        if (!parser.done) {
          pendingText = pushVpnGateCsvDecodedChunk(
            parser,
            pendingText,
            decoder.decode(value, { stream: true })
          );
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!parser.done) {
      pendingText = pushVpnGateCsvDecodedChunk(parser, pendingText, decoder.decode());
      if (!parser.done) parser.pushLine(pendingText);
    }
    return parser.relays;
  } finally {
    clearTimeout(timer);
  }
}

function startVpnGateRelayRefresh() {
  if (vpnGateRelaysInFlight) return vpnGateRelaysInFlight;

  vpnGateRelaysInFlight = (async () => {
    try {
      const next = await fetchVpnGateRelays();
      if (!next.size) throw new Error("VPN Gate directory was empty or invalid");
      vpnGateRelays = next;
      vpnGateRelaysFetchedAt = Date.now();
    } catch {
      // Public relay endpoints are frequently residential/dynamic. Do not retain a failed
      // refresh for long enough that an old relay address could be reassigned.
      if (Date.now() - vpnGateRelaysFetchedAt > vpnGateStaleMs) {
        vpnGateRelays = new Map<string, VpnGateRelayRecord>();
      }
    } finally {
      vpnGateRelaysInFlight = null;
    }
    return vpnGateRelays;
  })();

  return vpnGateRelaysInFlight;
}

async function refreshVpnGateRelays() {
  const now = Date.now();
  const cacheAgeMs = now - vpnGateRelaysFetchedAt;
  if (vpnGateRelays.size > 0 && cacheAgeMs < vpnGateRefreshMs) return vpnGateRelays;

  // The directory is large (up to 8 MiB) and its refresh timeout is deliberately
  // several seconds. Once a successfully fetched directory exists, do not put that
  // network refresh on the critical path of the next authenticated document request.
  // Serve the still-allowed stale snapshot immediately and refresh it in the
  // background. A cold start, or data older than the existing stale-safety window,
  // remains fail-closed on the synchronous refresh path.
  if (vpnGateRelays.size > 0 && cacheAgeMs <= vpnGateStaleMs) {
    void startVpnGateRelayRefresh();
    return vpnGateRelays;
  }

  return startVpnGateRelayRefresh();
}

async function withDnsTimeout<T>(promise: Promise<T>) {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("VPN Gate DDNS lookup timed out")), vpnGateDnsTimeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function hostnameResolvesToIp(hostname: string, ipAddress: string) {
  try {
    const results = await withDnsTimeout(Promise.allSettled([resolve4(hostname), resolve6(hostname)]));
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const address of result.value) {
        if (normalizeCountryLookupIp(address) === ipAddress) return true;
      }
    }
  } catch {
    // Directory membership remains a supporting signal when DDNS is unavailable.
  }
  return false;
}

export async function matchVpnGateRelay(ipAddress: string): Promise<VpnGateRelayMatch> {
  const normalizedIp = normalizeCountryLookupIp(ipAddress);
  if (!normalizedIp || !isPublicCountryLookupIp(normalizedIp)) {
    return { listed: false, dnsVerified: false, countryCode: null, hostname: null };
  }

  const directory = await refreshVpnGateRelays();
  const record = directory.get(normalizedIp);
  if (!record) return { listed: false, dnsVerified: false, countryCode: null, hostname: null };

  const verificationResults = await Promise.all(
    record.hostnames.map(async (hostname) => ({
      hostname,
      verified: await hostnameResolvesToIp(hostname, normalizedIp)
    }))
  );
  const verified = verificationResults.find((result) => result.verified);
  if (verified) {
    return {
      listed: true,
      dnsVerified: true,
      countryCode: record.countryCode,
      hostname: verified.hostname
    };
  }

  return {
    listed: true,
    dnsVerified: false,
    countryCode: record.countryCode,
    hostname: record.hostnames[0] ?? null
  };
}

export function resetVpnGateRelayCacheForTests() {
  vpnGateRelays = new Map<string, VpnGateRelayRecord>();
  vpnGateRelaysFetchedAt = 0;
  vpnGateRelaysInFlight = null;
}
