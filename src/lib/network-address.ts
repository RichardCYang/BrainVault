import net from "node:net";

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export const rfc6052Nat64PrefixLengths = [32, 40, 48, 56, 64, 96] as const;
export type Nat64PrefixLength = (typeof rfc6052Nat64PrefixLengths)[number];
export type Nat64Prefix = {
  base: string;
  prefixLength: Nat64PrefixLength;
};

function ipv4ToNumber(address: string) {
  return address.split(".").reduce((total, part) => (total << 8) + Number(part), 0) >>> 0;
}

function isIpv4InRange(address: string, base: string, prefix: number) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

function isPrivateIpv4(address: string) {
  const ranges: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["168.63.129.16", 32],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ];
  return ranges.some(([base, prefix]) => isIpv4InRange(address, base, prefix));
}

function expandIpv6(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);
    if (net.isIPv4(ipv4)) {
      const number = ipv4ToNumber(ipv4);
      address = `${normalized.slice(0, lastColon)}:${((number >>> 16) & 0xffff).toString(16)}:${(number & 0xffff).toString(16)}`;
    }
  }

  const [left, right = ""] = address.toLowerCase().split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const missing = Math.max(0, 8 - leftParts.length - rightParts.length);
  return [...leftParts, ...Array.from({ length: missing }, () => "0"), ...rightParts]
    .map((part) => part.padStart(4, "0"))
    .slice(0, 8);
}

function ipv6PartsToBytes(parts: string[]) {
  return Uint8Array.from(parts.flatMap((part) => {
    const value = Number.parseInt(part, 16);
    return [value >>> 8, value & 0xff];
  }));
}

function ipv6BytesToAddress(bytes: Uint8Array) {
  const parts: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    parts.push(((bytes[index] << 8) | bytes[index + 1]).toString(16).padStart(4, "0"));
  }
  return parts.join(":");
}

const rfc6052Ipv4BytePositions: Record<Nat64PrefixLength, readonly number[]> = {
  32: [4, 5, 6, 7],
  40: [5, 6, 7, 9],
  48: [6, 7, 9, 10],
  56: [7, 9, 10, 11],
  64: [9, 10, 11, 12],
  96: [12, 13, 14, 15]
};

function canonicalNat64PrefixBase(address: string, prefixLength: Nat64PrefixLength) {
  const parts = expandIpv6(address);
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{4}$/i.test(part))) return "";
  const bytes = ipv6PartsToBytes(parts);
  const prefixBytes = prefixLength / 8;
  bytes.fill(0, prefixBytes);
  return ipv6BytesToAddress(bytes);
}

export function parseNat64Prefix(value: string): Nat64Prefix | null {
  const match = value.trim().toLowerCase().match(/^(.+)\/(32|40|48|56|64|96)$/);
  if (!match) return null;
  const address = match[1].replace(/^\[|\]$/g, "");
  if (net.isIP(address) !== 6) return null;
  const prefixLength = Number(match[2]) as Nat64PrefixLength;
  const base = canonicalNat64PrefixBase(address, prefixLength);
  if (!base) return null;
  const canonicalInput = canonicalIpAddressKey(address);
  const canonicalBase = canonicalIpAddressKey(base);
  if (!canonicalInput || canonicalInput !== canonicalBase) return null;
  return { base, prefixLength };
}

function extractRfc6052Ipv4(address: string, prefix: Nat64Prefix) {
  if (net.isIP(address) !== 6) return null;
  const parts = expandIpv6(address);
  const baseParts = expandIpv6(prefix.base);
  if (parts.length !== 8 || baseParts.length !== 8) return null;
  const bytes = ipv6PartsToBytes(parts);
  const baseBytes = ipv6PartsToBytes(baseParts);
  const prefixBytes = prefix.prefixLength / 8;
  for (let index = 0; index < prefixBytes; index += 1) {
    if (bytes[index] !== baseBytes[index]) return null;
  }
  if (prefix.prefixLength < 96 && bytes[8] !== 0) return null;
  const positions = rfc6052Ipv4BytePositions[prefix.prefixLength];
  return positions.map((index) => bytes[index]).join(".");
}

function hasZeroRfc6052DiscoverySuffix(bytes: Uint8Array, prefixLength: Nat64PrefixLength) {
  if (prefixLength === 96) return true;
  const suffixStart = ({ 32: 9, 40: 10, 48: 11, 56: 12, 64: 13 } as const)[prefixLength as 32 | 40 | 48 | 56 | 64];
  for (let index = suffixStart; index < 16; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

export function inferNat64PrefixFromIpv4OnlyAddress(address: string): Nat64Prefix | null {
  if (net.isIP(address) !== 6) return null;
  const parts = expandIpv6(address);
  if (parts.length !== 8) return null;
  const bytes = ipv6PartsToBytes(parts);
  for (const prefixLength of [...rfc6052Nat64PrefixLengths].reverse()) {
    if (prefixLength < 96 && bytes[8] !== 0) continue;
    if (!hasZeroRfc6052DiscoverySuffix(bytes, prefixLength)) continue;
    const positions = rfc6052Ipv4BytePositions[prefixLength];
    const embedded = positions.map((index) => bytes[index]).join(".");
    if (embedded !== "192.0.0.170" && embedded !== "192.0.0.171") continue;
    return {
      base: canonicalNat64PrefixBase(address, prefixLength),
      prefixLength
    };
  }
  return null;
}

export function isPrivateOrNat64TranslatedAddress(address: string, prefixes: readonly Nat64Prefix[] = []) {
  if (isPrivateAddress(address)) return true;
  for (const prefix of prefixes) {
    const embedded = extractRfc6052Ipv4(address, prefix);
    if (embedded && isPrivateIpv4(embedded)) return true;
  }
  return false;
}

function ipv6PartsToBigInt(parts: string[]) {
  return parts.reduce((value, part) => (value << 16n) | BigInt(Number.parseInt(part, 16)), 0n);
}

function isIpv6InRange(parts: string[], base: string, prefix: number) {
  const addressValue = ipv6PartsToBigInt(parts);
  const baseValue = ipv6PartsToBigInt(expandIpv6(base));
  const shift = BigInt(128 - prefix);
  return (addressValue >> shift) === (baseValue >> shift);
}

function embeddedIpv4(parts: string[]) {
  const high = Number.parseInt(parts[6], 16);
  const low = Number.parseInt(parts[7], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

function embeddedIpv4Translation(parts: string[]) {
  const isMappedIpv4 = parts.slice(0, 5).every((part) => part === "0000") && parts[5] === "ffff";
  const isTranslatedIpv4 = parts.slice(0, 4).every((part) => part === "0000")
    && parts[4] === "ffff"
    && parts[5] === "0000";
  return isMappedIpv4 || isTranslatedIpv4 ? embeddedIpv4(parts) : null;
}

export function canonicalIpAddressKey(value: string) {
  const address = value.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0];
  const family = net.isIP(address);
  if (family === 4) return `4:${address}`;
  if (family !== 6) return "";

  const parts = expandIpv6(address);
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{4}$/i.test(part))) return "";
  const translated = embeddedIpv4Translation(parts);
  if (translated) return `4:${translated}`;
  return `6:${parts.join(":")}`;
}

function isPrivateIpv6(address: string) {
  const parts = expandIpv6(address);
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{4}$/i.test(part))) return true;

  // Keep private/special-use classification and self-origin comparison on the
  // same canonical interpretation of mapped and translated IPv4 forms.
  const translated = embeddedIpv4Translation(parts);
  if (translated) return isPrivateIpv4(translated);

  const specialUseRanges: Array<[string, number]> = [
    ["::", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["100:0:0:1::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8]
  ];
  return specialUseRanges.some(([base, prefix]) => isIpv6InRange(parts, base, prefix));
}

export function isPrivateAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export function isPrivateOrLocalHostname(hostname: string) {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (!normalized) return true;

  const family = net.isIP(normalized);
  if (family === 4 || family === 6) return isPrivateAddress(normalized);

  // Single-label names are resolved through local DNS/search domains and are
  // overwhelmingly intranet targets. The suffixes below cover common local,
  // mDNS, and split-horizon naming conventions (including cloud metadata).
  if (!normalized.includes(".")) return true;
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
    || normalized.endsWith(".lan")
    || normalized.endsWith(".home")
    || normalized.endsWith(".home.arpa");
}

export function prioritizeResolvedAddresses(addresses: Array<{ address: string; family: number }>) {
  const unique = new Map<string, ResolvedAddress>();
  for (const item of addresses) {
    const family = net.isIP(item.address);
    if ((family !== 4 && family !== 6) || isPrivateAddress(item.address)) continue;
    unique.set(`${family}:${item.address}`, { address: item.address, family });
  }

  return [...unique.values()].sort((left, right) => left.family - right.family);
}
