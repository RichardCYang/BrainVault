import type { IncomingMessage } from "node:http";
import { canonicalIpAddressKey } from "./network-address.js";
import { isCountryPolicyLocalNetworkIp } from "./geo-country.js";
import { getClientIpAddressFromTrustedProxyRequest, isHttpsRequestFromTrustedProxy, isTrustedProxyRemoteAddress } from "./reverse-proxy.js";

export type TcpRttObservation = {
  rttMs: number;
  variationMs: number;
  source: "TRUSTED_PROXY_TCP_INFO" | "DIRECT_TCP_INFO";
};

export type TcpInfoReadResult = {
  observation: TcpRttObservation | null;
  signal: string;
};

export function normalizeMeasurementIp(value: string): string | null {
  const key = canonicalIpAddressKey(value);
  return key ? key.slice(2) : null;
}

function uniqueHeader(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  if (typeof value !== "string") return null;
  let count = 0;
  for (let index = 0; index < (request.rawHeaders?.length ?? 0); index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count > 1 ? null : value;
}

function microseconds(value: string | null, allowZero: boolean) {
  if (value === null || !/^\d{1,8}$/.test(value)) return null;
  const number = Number(value);
  return number >= (allowZero ? 0 : 1) && number <= 10_000_000 ? number / 1_000 : null;
}

/**
 * These are ingress-generated measurements, never arbitrary request headers.
 * Opt-in is required even for a trusted proxy: an ordinary proxy forwards
 * attacker-supplied headers until explicitly configured to overwrite them.
 */
export function readTrustedProxyTcpInfo(
  request: IncomingMessage,
  expectedClientIp: string,
  options: { enabled: boolean; proxyMode: boolean; trustedAddresses: readonly string[]; allowPrivateClients?: boolean }
): TcpInfoReadResult {
  const missing = (signal: string): TcpInfoReadResult => ({ observation: null, signal });
  if (!options.proxyMode) return missing("DIRECT_TCP_INFO_UNAVAILABLE");
  if (!options.enabled) return missing("PROXY_TCP_INFO_DISABLED");
  const peer = request.socket.remoteAddress ?? "";
  if (!isTrustedProxyRemoteAddress(peer, options.trustedAddresses)
    || !isCountryPolicyLocalNetworkIp(normalizeMeasurementIp(peer) ?? "")
    || !isHttpsRequestFromTrustedProxy(request, options.trustedAddresses)) return missing("UNTRUSTED_TCP_INFO_SOURCE");

  const clientIp = normalizeMeasurementIp(getClientIpAddressFromTrustedProxyRequest(request, options.trustedAddresses, options.allowPrivateClients));
  const transportPeer = uniqueHeader(request, "x-brainvault-tcp-peer-ip");
  if (!clientIp || clientIp !== normalizeMeasurementIp(expectedClientIp)
    || !transportPeer || normalizeMeasurementIp(transportPeer) !== clientIp) return missing("TCP_INFO_CLIENT_MISMATCH");

  const rttMs = microseconds(uniqueHeader(request, "x-brainvault-tcp-rtt-us"), false);
  const variationMs = microseconds(uniqueHeader(request, "x-brainvault-tcp-rttvar-us"), true);
  if (rttMs === null || variationMs === null) return missing("TCP_INFO_UNAVAILABLE");
  return { observation: { rttMs, variationMs, source: "TRUSTED_PROXY_TCP_INFO" }, signal: "TRUSTED_PROXY_TCP_INFO" };
}
