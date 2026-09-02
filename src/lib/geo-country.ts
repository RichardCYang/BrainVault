import net from "node:net";
const countryApiBaseUrl = "https://api.country.is";
const countryApiTimeoutMs = 2_000;
const countryApiBatchSize = 100;
const countryApiInfoMaxBytes = 64 * 1024;
const countryApiBatchMaxBytes = 2 * 1024 * 1024;
const countryInfoCacheMs = 60 * 1_000;

type CountryInfoCache = {
  value: Date | null;
  expiresAt: number;
};

let countryInfoCache: CountryInfoCache | null = null;
let countryInfoInFlight: Promise<Date | null> | null = null;

function normalizeIpv4MappedAddress(ipAddress: string) {
  const withoutZone = ipAddress.trim().split("%")[0];
  return /^::ffff:/i.test(withoutZone) ? withoutZone.slice(7) : withoutZone;
}

export function normalizeCountryLookupIp(ipAddress: string) {
  const normalized = normalizeIpv4MappedAddress(ipAddress);
  return net.isIP(normalized) ? normalized : null;
}

const countryPolicyLocalNetworks = new net.BlockList();
countryPolicyLocalNetworks.addSubnet("127.0.0.0", 8, "ipv4");
countryPolicyLocalNetworks.addSubnet("10.0.0.0", 8, "ipv4");
countryPolicyLocalNetworks.addSubnet("172.16.0.0", 12, "ipv4");
countryPolicyLocalNetworks.addSubnet("192.168.0.0", 16, "ipv4");
countryPolicyLocalNetworks.addAddress("::1", "ipv6");
countryPolicyLocalNetworks.addSubnet("fc00::", 7, "ipv6");

export function isCountryPolicyLocalNetworkIp(ipAddress: string) {
  const normalized = normalizeCountryLookupIp(ipAddress);
  if (!normalized) return false;
  const family = net.isIPv4(normalized) ? "ipv4" : "ipv6";
  return countryPolicyLocalNetworks.check(normalized, family);
}

function isNonPublicIpv4(ipAddress: string) {
  const octets = ipAddress.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && octets[2] === 0) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 192 && b === 88 && octets[2] === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function isNonPublicIpv6(ipAddress: string) {
  const normalized = ipAddress.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized === "2001:db8::"
  );
}

export function isPublicCountryLookupIp(ipAddress: string) {
  const normalized = normalizeCountryLookupIp(ipAddress);
  if (!normalized) return false;
  if (net.isIPv4(normalized)) return !isNonPublicIpv4(normalized);
  return !isNonPublicIpv6(normalized);
}

export function normalizeCountryCode(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

async function readLimitedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const contentLength = Number(declaredLength);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      throw new Error("Country.is response exceeded the configured size limit");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Country.is response did not contain a body");
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Country.is response exceeded the configured size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown;
}

async function fetchCountryApi(pathname: string, init?: RequestInit) {
  return fetch(`${countryApiBaseUrl}${pathname}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...init?.headers
    },
    signal: AbortSignal.timeout(countryApiTimeoutMs)
  });
}

async function refreshCountryDatasetUpdatedAt(now: number) {
  try {
    const response = await fetchCountryApi("/info");
    if (!response.ok) throw new Error(`Country.is info request failed with HTTP ${response.status}`);
    const payload = await readLimitedJson(response, countryApiInfoMaxBytes);
    if (!payload || typeof payload !== "object" || !("lastUpdated" in payload) || typeof payload.lastUpdated !== "string") {
      throw new Error("Country.is info response was invalid");
    }

    const updatedAt = new Date(payload.lastUpdated);
    const value = Number.isNaN(updatedAt.getTime()) ? null : updatedAt;
    countryInfoCache = { value, expiresAt: now + countryInfoCacheMs };
    return value;
  } catch {
    // Keep login history usable during provider outages. Retry metadata soon rather than
    // holding a failed result for the normal one-minute freshness window.
    countryInfoCache = { value: null, expiresAt: now + 15_000 };
    return null;
  }
}

export async function getCountryDatasetUpdatedAt() {
  const now = Date.now();
  if (countryInfoCache && countryInfoCache.expiresAt > now) return countryInfoCache.value;
  if (countryInfoInFlight) return countryInfoInFlight;

  countryInfoInFlight = refreshCountryDatasetUpdatedAt(now);
  try {
    return await countryInfoInFlight;
  } finally {
    countryInfoInFlight = null;
  }
}

async function lookupCountryCodeBatch(ipAddresses: readonly string[]) {
  const result = new Map<string, string | null>();
  if (ipAddresses.length === 0) return result;

  try {
    const response = await fetchCountryApi("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ipAddresses)
    });
    if (!response.ok) return result;

    const payload = await readLimitedJson(response, countryApiBatchMaxBytes);
    if (!Array.isArray(payload)) return result;

    // A successful batch may omit IPs that have no database match. Mark those as
    // resolved-to-unknown so they are retried only when the provider dataset changes.
    for (const ipAddress of ipAddresses) result.set(ipAddress, null);
    for (const item of payload) {
      if (!item || typeof item !== "object" || !("ip" in item) || typeof item.ip !== "string") continue;
      const normalizedIp = normalizeCountryLookupIp(item.ip);
      if (!normalizedIp || !result.has(normalizedIp)) continue;
      const country = "country" in item ? item.country : null;
      result.set(normalizedIp, normalizeCountryCode(country));
    }
  } catch {
    // GeoIP is best-effort metadata. Never make account/security screens fail because
    // the external service is slow or temporarily unavailable.
  }

  return result;
}

export async function lookupCountryCodes(ipAddresses: readonly string[]) {
  const uniquePublicIps = [
    ...new Set(
      ipAddresses
        .map((ipAddress) => normalizeCountryLookupIp(ipAddress))
        .filter((ipAddress): ipAddress is string => Boolean(ipAddress && isPublicCountryLookupIp(ipAddress)))
    )
  ];

  const batches = Array.from(
    { length: Math.ceil(uniquePublicIps.length / countryApiBatchSize) },
    (_, index) => uniquePublicIps.slice(index * countryApiBatchSize, (index + 1) * countryApiBatchSize)
  );

  // The public service allows 10 requests/second per source IP. A login-history page
  // contains at most 500 records, so no more than five batch requests are issued here.
  const batchResults = await Promise.all(batches.map((batch) => lookupCountryCodeBatch(batch)));
  const merged = new Map<string, string | null>();
  for (const batch of batchResults) {
    for (const [ipAddress, countryCode] of batch) merged.set(ipAddress, countryCode);
  }
  return merged;
}

export function resetCountryInfoCacheForTests() {
  countryInfoCache = null;
  countryInfoInFlight = null;
}
