import assert from "node:assert/strict";
import test from "node:test";
import { readFile, access } from "node:fs/promises";
import { evaluateLatencyEvidence } from "../src/lib/vpn-latency.ts";
import { normalizeMeasurementIp, readTrustedProxyTcpInfo } from "../src/lib/network-tcp-info.ts";

const tcp = { rttMs: 20, variationMs: 1, source: "TRUSTED_PROXY_TCP_INFO" };
const evidence = (app = Array(12).fill(21), transport = tcp, overrides = {}) => ({ applicationRttMs: app, tcp: transport, uncertaintyMs: 0, ...overrides });

test("a stable connection with matching TCP and WebSocket RTT has no cross-layer gap", () => {
  const result = evaluateLatencyEvidence(evidence());
  assert.equal(result.verdict, "CLEAR");
  assert.equal(result.measurement.tcpSource, "TRUSTED_PROXY_TCP_INFO");
  assert.equal(result.measurement.tcpRttMs, 20);
});
test("a long TCP and WebSocket RTT alone does not detect a tunnel", () => {
  assert.equal(evaluateLatencyEvidence(evidence(Array(12).fill(400), { ...tcp, rttMs: 398 })).verdict, "CLEAR");
});
test("both stable WebSocket windows must exceed TCP RTT and its uncertainty", () => {
  const result = evaluateLatencyEvidence(evidence(Array(12).fill(120)));
  assert.equal(result.verdict, "TUNNEL");
  assert.ok(result.measurement.excessRttMs > result.measurement.thresholdMs);
  assert.equal("confidence" in result, false);
});
test("unstable WebSocket timing and uncertain TCP RTT remain inconclusive", () => {
  assert.equal(evaluateLatencyEvidence(evidence([...Array(6).fill(20), ...Array(6).fill(120)])).verdict, "INCONCLUSIVE");
  assert.equal(evaluateLatencyEvidence(evidence(Array(12).fill(200), { ...tcp, variationMs: 40 })).verdict, "INCONCLUSIVE");
});
test("WebSocket samples without genuine transport evidence never produce CLEAR", () => {
  const result = evaluateLatencyEvidence(evidence(Array(12).fill(20), null, { missingTcpSignal: "PROXY_TCP_INFO_DISABLED" }));
  assert.equal(result.verdict, "UNKNOWN");
  assert.equal(result.measurement.sampleCount, 12);
  assert.equal(result.measurement.tcpRttMs, null);
  assert.ok(result.supportingSignals.includes("PROXY_TCP_INFO_DISABLED"));
});
test("incomplete or malformed evidence cannot become a valid comparison", () => {
  for (const input of [evidence([]), evidence(Array(11).fill(100)), evidence(Array(12).fill(NaN)), evidence(Array(65).fill(100)),
    evidence(undefined, { ...tcp, rttMs: 0 }), evidence(undefined, { ...tcp, rttMs: Infinity }),
    evidence(undefined, { ...tcp, variationMs: -1 }), evidence(undefined, { ...tcp, source: "BROWSER_HEADER" }),
    evidence(undefined, undefined, { uncertaintyMs: -1 })]) {
    assert.equal(evaluateLatencyEvidence(input).verdict, "UNKNOWN");
  }
});
test("a TCP estimate much slower than WebSocket timing remains inconclusive", () => {
  assert.equal(evaluateLatencyEvidence(evidence(Array(12).fill(10), { ...tcp, rttMs: 200 })).verdict, "INCONCLUSIVE");
});
test("a local proxy margin makes the comparison more conservative", () => {
  assert.equal(evaluateLatencyEvidence(evidence(Array(12).fill(85))).verdict, "TUNNEL");
  assert.equal(evaluateLatencyEvidence(evidence(Array(12).fill(85), tcp, { uncertaintyMs: 20 })).verdict, "CLEAR");
});
test("network address normalization preserves literal IPv4 and canonical IPv6 identities", () => {
  assert.equal(normalizeMeasurementIp("::ffff:8.8.8.8"), "8.8.8.8");
  assert.equal(normalizeMeasurementIp("2001:4860:4860::8888"), "2001:4860:4860:0000:0000:0000:0000:8888");
  assert.equal(normalizeMeasurementIp("junk"), null);
});

const trusted = { enabled: true, proxyMode: true, trustedAddresses: ["172.18.0.1"] };
function request(headers = {}, peer = "172.18.0.1") {
  const all = { "x-forwarded-for": "8.8.8.8", "x-forwarded-proto": "https", "x-brainvault-tcp-peer-ip": "8.8.8.8",
    "x-brainvault-tcp-rtt-us": "12500", "x-brainvault-tcp-rttvar-us": "500", ...headers };
  return { headers: all, rawHeaders: Object.entries(all).flat(), socket: { remoteAddress: peer } };
}
test("explicitly trusted ingress TCP_INFO is converted from microseconds to milliseconds", () => {
  const result = readTrustedProxyTcpInfo(request(), "::ffff:8.8.8.8", trusted);
  assert.deepEqual(result.observation, { rttMs: 12.5, variationMs: 0.5, source: "TRUSTED_PROXY_TCP_INFO" });
});
test("forwarded timing headers require explicit opt-in and never apply to direct connections", () => {
  assert.equal(readTrustedProxyTcpInfo(request(), "8.8.8.8", { ...trusted, enabled: false }).signal, "PROXY_TCP_INFO_DISABLED");
  assert.equal(readTrustedProxyTcpInfo(request(), "8.8.8.8", { ...trusted, proxyMode: false }).signal, "DIRECT_TCP_INFO_UNAVAILABLE");
});
test("untrusted peers, non-HTTPS forwarding and a missing forwarding chain cannot supply transport evidence", () => {
  for (const req of [request({}, "172.18.0.2"), request({}, "8.8.8.8"), request({ "x-forwarded-proto": "http" }), request({ "x-forwarded-for": "" })]) {
    assert.equal(readTrustedProxyTcpInfo(req, "8.8.8.8", trusted).observation, null);
  }
});
test("TCP observations must describe the actual public client, not a NAS/container/CDN hop", () => {
  for (const peer of ["172.18.0.1", "192.168.1.1", "1.1.1.1"]) {
    assert.equal(readTrustedProxyTcpInfo(request({ "x-brainvault-tcp-peer-ip": peer }), "8.8.8.8", trusted).signal, "TCP_INFO_CLIENT_MISMATCH");
  }
  assert.equal(readTrustedProxyTcpInfo(request(), "1.1.1.1", trusted).observation, null);
});
test("duplicate, missing, negative, nonnumeric, zero and unbounded timing headers are rejected", () => {
  for (const value of ["", "-1", "NaN", "Infinity", "1,2", "0", "10000001", "$tcpinfo_rtt", "1e3"]) {
    assert.equal(readTrustedProxyTcpInfo(request({ "x-brainvault-tcp-rtt-us": value }), "8.8.8.8", trusted).observation, null, value);
  }
  assert.equal(readTrustedProxyTcpInfo(request({ "x-brainvault-tcp-rttvar-us": undefined }), "8.8.8.8", trusted).observation, null);
  const duplicate = request(); duplicate.rawHeaders.push("X-BrainVault-TCP-RTT-US", "1");
  assert.equal(readTrustedProxyTcpInfo(duplicate, "8.8.8.8", trusted).observation, null);
});
test("the network measurement path has no external probes, process execution or landmark configuration", async () => {
  for (const path of ["src/lib/network-verification.ts", "src/lib/network-tcp-info.ts", "src/lib/vpn-latency.ts"]) {
    const source = await readFile(new URL("../" + path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /node:child_process|execFile\(|spawn\(|probeIpRtt|EXIT_ICMP|LANDMARK|fetch\(/);
  }
  await assert.rejects(access(new URL("../src/lib/vpn-reference-probes.ts", import.meta.url)));
});
