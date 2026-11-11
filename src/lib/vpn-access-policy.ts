import { env } from "../config/env.js";
import { db, type DbClient } from "./db.js";
import { isCountryPolicyLocalNetworkIp } from "./geo-country.js";
import { normalizeMeasurementIp } from "./network-tcp-info.js";
import { ApiError } from "./http.js";
import { recordCountryLoginBlock } from "./country-login-policy.js";
import { getNetworkAssessment } from "./network-verification.js";
import { unavailableLatencyAssessment, type LatencyAssessment } from "./vpn-latency.js";

export type VpnRiskVerdict = LatencyAssessment["verdict"];
export type VpnRiskResolution = LatencyAssessment & {
  ipAddress: string;
  countryCode: null;
  blocked: boolean;
  reason: "VPN_DETECTED" | "VPN_VERIFICATION_UNAVAILABLE" | null;
};

export async function resolveVpnAccessRisk(ipAddress: string, measurementContext: string | null = null): Promise<VpnRiskResolution> {
  const normalizedIp = normalizeMeasurementIp(ipAddress);
  const localAllowed = normalizedIp !== null && env.VPN_ALLOW_PRIVATE_NETWORK && isCountryPolicyLocalNetworkIp(normalizedIp);
  const assessment = localAllowed
    ? { ...unavailableLatencyAssessment("PRIVATE_NETWORK_EXEMPT", env.VPN_MIN_EXCESS_RTT_MS), verdict: "CLEAR" as const }
    : getNetworkAssessment(normalizedIp ?? "unknown", measurementContext);
  const blocked = assessment.verdict === "TUNNEL" || assessment.verdict === "UNKNOWN" && env.VPN_POLICY_FAIL_CLOSED;
  return { ...assessment, ipAddress: normalizedIp ?? "unknown", countryCode: null, blocked,
    // Preserve historical database reasons. Latency detects a tunnel, and does
    // not identify the operator, protocol, or whether a connection is Tor.
    reason: blocked ? assessment.verdict === "TUNNEL" ? "VPN_DETECTED" : "VPN_VERIFICATION_UNAVAILABLE" : null };
}

export function normalizeVpnBlockEnabled(value: unknown) {
  if (value === undefined || value === null || value === false || value === 0 || value === "0") return false;
  if (value === true || value === 1 || value === "1") return true;
  throw new ApiError(500, "VPN_POLICY_INVALID", "Stored VPN access policy is invalid");
}

export async function enforceVpnAccessPolicy(userId: string, enabledHint: unknown, ipAddress: string,
  measurementContext: string | null = null, client: DbClient = db) {
  const enabled = enabledHint === undefined || enabledHint === null
    ? normalizeVpnBlockEnabled((await client.queryOne<{ vpn_block_enabled: unknown }>("SELECT vpn_block_enabled FROM users WHERE id = ?", [userId]))?.vpn_block_enabled)
    : normalizeVpnBlockEnabled(enabledHint);
  if (!enabled) return null;
  const resolution = await resolveVpnAccessRisk(ipAddress, measurementContext);
  if (!resolution.blocked || !resolution.reason) return resolution;
  await recordCountryLoginBlock(userId, resolution.ipAddress, null, resolution.reason, client);
  throw new ApiError(resolution.reason === "VPN_VERIFICATION_UNAVAILABLE" ? 503 : 403, "VPN_ACCESS_BLOCKED",
    resolution.reason === "VPN_VERIFICATION_UNAVAILABLE"
      ? "Connection measurement is unavailable; retry network verification"
      : "Repeated network measurements indicate an additional tunnel path blocked by this account policy",
    { reason: resolution.reason, verdict: resolution.verdict });
}

export async function assertVpnPolicyAllowsCurrentConnection(enabled: boolean, ipAddress: string, measurementContext: string | null = null) {
  const resolution = await resolveVpnAccessRisk(ipAddress, measurementContext);
  if (enabled && resolution.blocked) {
    throw new ApiError(400, "VPN_POLICY_WOULD_BLOCK_CURRENT_IP", "The policy would block this connection; complete network verification before enabling it",
      { reason: resolution.reason, verdict: resolution.verdict });
  }
  return resolution;
}
