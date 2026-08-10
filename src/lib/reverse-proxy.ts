import net from "node:net";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

export type ExpressTrustProxySetting = false | string[];

export function createExpressTrustProxySetting(
  trustedProxyHops: number,
  trustedProxyAddresses: readonly string[]
): ExpressTrustProxySetting {
  if (trustedProxyHops !== 0) {
    throw new Error("TRUST_PROXY_HOPS must remain 0; configure TRUST_PROXY_ADDRESSES with exact proxy peers");
  }
  return trustedProxyAddresses.length > 0 ? [...trustedProxyAddresses] : false;
}

export function describeExpressTrustProxySetting(setting: ExpressTrustProxySetting) {
  if (setting === false) return "disabled";
  return setting.join(", ");
}

type ParsedAddress = {
  family: 4 | 6;
  bits: number;
  value: bigint;
};

function normalizeRemoteAddress(address: string) {
  const withoutZone = address.split("%")[0].toLowerCase();
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(withoutZone);
  return mappedIpv4 ? mappedIpv4[1] : withoutZone;
}

function parseIpv4(address: string): ParsedAddress | null {
  if (!net.isIPv4(address)) return null;
  const value = address
    .split(".")
    .reduce((result, part) => (result << 8n) | BigInt(Number(part)), 0n);
  return { family: 4, bits: 32, value };
}

function expandIpv6Parts(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  const sides = normalized.split("::");
  if (sides.length > 2) return null;

  const expandSide = (side: string) => {
    if (!side) return [];
    const parts = side.split(":");
    const last = parts.at(-1);
    if (last?.includes(".")) {
      const ipv4 = parseIpv4(last);
      if (!ipv4) return null;
      parts.splice(
        parts.length - 1,
        1,
        Number((ipv4.value >> 16n) & 0xffffn).toString(16),
        Number(ipv4.value & 0xffffn).toString(16)
      );
    }
    return parts;
  };

  const left = expandSide(sides[0]);
  const right = expandSide(sides[1] ?? "");
  if (!left || !right) return null;

  const hasCompression = sides.length === 2;
  const missing = 8 - left.length - right.length;
  if ((!hasCompression && missing !== 0) || (hasCompression && missing < 1)) return null;
  return [...left, ...Array.from({ length: missing }, () => "0"), ...right];
}

function parseIpv6(address: string): ParsedAddress | null {
  if (!net.isIPv6(address)) return null;
  const parts = expandIpv6Parts(address);
  if (!parts || parts.length !== 8) return null;

  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(part, 16));
  }
  return { family: 6, bits: 128, value };
}

function parseAddress(address: string) {
  const normalized = normalizeRemoteAddress(address);
  return parseIpv4(normalized) ?? parseIpv6(normalized);
}

function addressMatchesCidr(address: ParsedAddress, cidr: string) {
  const slashIndex = cidr.lastIndexOf("/");
  const baseText = slashIndex === -1 ? cidr : cidr.slice(0, slashIndex);
  const base = parseAddress(baseText);
  if (!base || base.family !== address.family) return false;

  const prefix = slashIndex === -1 ? base.bits : Number(cidr.slice(slashIndex + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > base.bits) return false;
  if (prefix === 0) return true;

  const shift = BigInt(base.bits - prefix);
  return (address.value >> shift) === (base.value >> shift);
}

const namedProxyRanges: Record<string, string[]> = {
  loopback: ["127.0.0.0/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]
};

export function isTrustedProxyRemoteAddress(
  remoteAddress: string | undefined,
  trustedProxyAddresses: readonly string[]
) {
  if (!remoteAddress) return false;
  const address = parseAddress(remoteAddress);
  if (!address) return false;

  return trustedProxyAddresses.some((rule) => {
    const namedRanges = namedProxyRanges[rule.toLowerCase()];
    if (namedRanges) return namedRanges.some((cidr) => addressMatchesCidr(address, cidr));
    return addressMatchesCidr(address, rule);
  });
}

function normalizeNetworkIpAddress(value: string | undefined) {
  if (!value) return null;
  const normalized = normalizeRemoteAddress(value.trim());
  return net.isIP(normalized) ? normalized : null;
}

export function forwardedForAddresses(headers: IncomingHttpHeaders) {
  const value = headers["x-forwarded-for"];
  if (Array.isArray(value) && value.length !== 1) return null;
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string" || !candidate.trim()) return [];

  const addresses = candidate
    .split(",")
    .map((part) => normalizeNetworkIpAddress(part.trim()));
  return addresses.every((address): address is string => Boolean(address)) ? addresses : null;
}

export function getClientIpAddressFromTrustedProxyRequest(
  request: Pick<IncomingMessage, "headers" | "socket">,
  trustedProxyAddresses: readonly string[]
) {
  const remoteAddress = normalizeNetworkIpAddress(request.socket.remoteAddress);
  if (!remoteAddress) return "unknown";
  if (!isTrustedProxyRemoteAddress(remoteAddress, trustedProxyAddresses)) return remoteAddress;

  const forwardedAddresses = forwardedForAddresses(request.headers);
  if (!forwardedAddresses?.length) return remoteAddress;

  // Match Express/proxy-addr's right-to-left trust boundary: only walk farther
  // into X-Forwarded-For while the immediately closer hop is explicitly trusted.
  // A client-supplied leftmost value is therefore never selected through an
  // untrusted hop. Malformed chains fall back to the socket peer above.
  let selectedAddress = remoteAddress;
  let closerHop = remoteAddress;
  for (let index = forwardedAddresses.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxyRemoteAddress(closerHop, trustedProxyAddresses)) break;
    selectedAddress = forwardedAddresses[index];
    closerHop = selectedAddress;
  }
  return selectedAddress;
}

export function forwardedProtocol(headers: IncomingHttpHeaders) {
  const value = headers["x-forwarded-proto"];
  if (Array.isArray(value) && value.length !== 1) return null;

  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string") return null;

  const protocol = candidate.trim().toLowerCase();
  return protocol === "http" || protocol === "https" ? protocol : null;
}

export function isHttpsRequestFromTrustedProxy(
  request: Pick<IncomingMessage, "headers" | "socket">,
  trustedProxyAddresses: readonly string[]
) {
  return (
    isTrustedProxyRemoteAddress(request.socket.remoteAddress, trustedProxyAddresses) &&
    forwardedProtocol(request.headers) === "https"
  );
}
