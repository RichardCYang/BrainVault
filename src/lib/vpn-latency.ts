import type { TcpRttObservation } from "./network-tcp-info.js";

export type LatencyEvidence = {
  applicationRttMs: readonly number[];
  tcp: TcpRttObservation | null;
  uncertaintyMs: number;
  missingTcpSignal?: string;
};

export type LatencyAssessment = {
  verdict: "CLEAR" | "TUNNEL" | "INCONCLUSIVE" | "UNKNOWN";
  supportingSignals: string[];
  measurement: {
    sampleCount: number;
    applicationRttMs: number | null;
    tcpRttMs: number | null;
    tcpVariationMs: number | null;
    excessRttMs: number | null;
    jitterMs: number | null;
    thresholdMs: number;
    tcpSource: TcpRttObservation["source"] | null;
  };
};

function quantile(sorted: readonly number[], fraction: number) {
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

export function unavailableLatencyAssessment(signal = "MEASUREMENT_UNAVAILABLE", thresholdMs = 50): LatencyAssessment {
  return {
    verdict: "UNKNOWN", supportingSignals: [signal],
    measurement: { sampleCount: 0, applicationRttMs: null, tcpRttMs: null, tcpVariationMs: null,
      excessRttMs: null, jitterMs: null, thresholdMs, tcpSource: null }
  };
}

/**
 * Compare WebSocket round trips with TCP_INFO on the ORIGINAL client TCP
 * connection. A proxy can split TCP while forwarding the WebSocket stream.
 * A layer-3 VPN need not split TCP, so lack of a gap does not rule out a VPN.
 * Two stable application windows must both exceed the conservative TCP bound.
 */
export function evaluateLatencyEvidence(evidence: LatencyEvidence, minimumExcessMs = 50): LatencyAssessment {
  if (!Number.isFinite(minimumExcessMs) || minimumExcessMs < 25 || minimumExcessMs > 2_000) throw new RangeError("Invalid latency threshold");
  const { applicationRttMs: app, tcp, uncertaintyMs } = evidence;
  if (!Array.isArray(app) || app.length < 12 || app.length > 64
    || app.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000)
    || !Number.isFinite(uncertaintyMs) || uncertaintyMs < 0 || uncertaintyMs > 500) {
    return unavailableLatencyAssessment("INSUFFICIENT_SAMPLES", minimumExcessMs);
  }

  const sortedApp = [...app].sort((a, b) => a - b);
  if (!tcp || !Number.isFinite(tcp.rttMs) || tcp.rttMs <= 0 || tcp.rttMs > 10_000
    || !Number.isFinite(tcp.variationMs) || tcp.variationMs < 0 || tcp.variationMs > 10_000
    || !["TRUSTED_PROXY_TCP_INFO", "DIRECT_TCP_INFO"].includes(tcp.source)) {
    const unavailable = unavailableLatencyAssessment(evidence.missingTcpSignal ?? "TCP_INFO_UNAVAILABLE", minimumExcessMs);
    unavailable.measurement.sampleCount = app.length;
    unavailable.measurement.applicationRttMs = quantile(sortedApp, 0.1);
    unavailable.supportingSignals.push("SERVER_MEASURED_WEBSOCKET_RTT");
    return unavailable;
  }

  const appJitter = quantile(sortedApp, 0.9) - quantile(sortedApp, 0.1);
  const threshold = minimumExcessMs + uncertaintyMs + 3 * tcp.variationMs;
  const excess = quantile(sortedApp, 0.1) - tcp.rttMs;
  const measurement = {
    sampleCount: app.length, applicationRttMs: quantile(sortedApp, 0.1), tcpRttMs: tcp.rttMs,
    tcpVariationMs: tcp.variationMs, excessRttMs: excess, jitterMs: appJitter, thresholdMs: threshold, tcpSource: tcp.source
  };
  const supportingSignals = ["SERVER_MEASURED_WEBSOCKET_RTT", tcp.source];
  if (appJitter > Math.max(20, quantile(sortedApp, 0.5) * 0.25)
    || tcp.variationMs > Math.max(15, tcp.rttMs * 0.25)) {
    return { verdict: "INCONCLUSIVE", supportingSignals: [...supportingSignals, "UNSTABLE_NETWORK"], measurement };
  }

  const middle = Math.floor(app.length / 2);
  const windowExcess = [app.slice(0, middle), app.slice(middle)].map((window) => Math.min(...window) - tcp.rttMs);
  if (windowExcess.every((value) => value > threshold)) {
    return { verdict: "TUNNEL", supportingSignals: [...supportingSignals, "REPEATED_CROSS_LAYER_GAP"], measurement };
  }
  if (windowExcess.some((value) => value > threshold) || excess < -Math.max(20, tcp.rttMs * 0.25)) {
    return { verdict: "INCONCLUSIVE", supportingSignals: [...supportingSignals, "TCP_WEBSOCKET_COMPARISON_INCONCLUSIVE"], measurement };
  }
  return { verdict: "CLEAR", supportingSignals: [...supportingSignals, "NO_CROSS_LAYER_GAP_OBSERVED"], measurement };
}
