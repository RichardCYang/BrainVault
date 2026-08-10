const defaultStunServer = "stun:stun.cloudflare.com:3478";
const defaultTimeoutMs = 1_800;
const signalCacheMs = 60_000;
const maxObservedIps = 4;

let cachedSignal = null;
let cachedAt = 0;
let inFlightSignal = null;

function createSignal(state, observedIps = []) {
  return Object.freeze({ state, observedIps: Object.freeze([...observedIps]) });
}

function normalizeCandidateAddress(value) {
  const address = typeof value === "string" ? value.trim() : "";
  if (!address || address.length > 64 || !/^[0-9a-f:.]+$/i.test(address)) return null;
  return address;
}

function readServerReflexiveAddress(candidate) {
  if (!candidate) return null;
  const candidateLine = typeof candidate.candidate === "string" ? candidate.candidate.trim() : "";
  const parts = candidateLine ? candidateLine.split(/\s+/) : [];
  const typeIndex = parts.findIndex((part) => part.toLowerCase() === "typ");
  const parsedType = typeIndex >= 0 ? parts[typeIndex + 1]?.toLowerCase() : null;
  const type = typeof candidate.type === "string" ? candidate.type.toLowerCase() : parsedType;
  if (type !== "srflx") return null;
  return normalizeCandidateAddress(candidate.address) ?? normalizeCandidateAddress(parts[4]);
}

function isWebRtcDisabledError(error) {
  return ["NotAllowedError", "NotSupportedError", "SecurityError"].includes(error?.name);
}

export async function collectWebRtcNetworkSignal({
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  stunServer = defaultStunServer,
  timeoutMs = defaultTimeoutMs
} = {}) {
  if (typeof RTCPeerConnectionImpl !== "function") return createSignal("disabled");

  let peerConnection;
  try {
    peerConnection = new RTCPeerConnectionImpl({
      iceServers: [{ urls: [stunServer] }],
      iceTransportPolicy: "all"
    });
  } catch (error) {
    return createSignal(isWebRtcDisabledError(error) ? "disabled" : "unavailable");
  }

  return new Promise((resolve) => {
    const observedIps = [];
    let settled = false;
    let timer = null;

    const finish = (fallbackState = "unavailable") => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        peerConnection.onicecandidate = null;
        peerConnection.close();
      } catch {
        // Closing a failed/disabled peer connection is best effort only.
      }
      resolve(observedIps.length ? createSignal("available", observedIps) : createSignal(fallbackState));
    };

    peerConnection.onicecandidate = (event) => {
      if (!event?.candidate) {
        finish();
        return;
      }
      const address = readServerReflexiveAddress(event.candidate);
      if (address && !observedIps.includes(address) && observedIps.length < maxObservedIps) observedIps.push(address);
    };

    timer = setTimeout(() => finish(), Math.max(250, Number(timeoutMs) || defaultTimeoutMs));

    Promise.resolve()
      .then(() => peerConnection.createDataChannel("brainvault-network-check", { ordered: false, maxRetransmits: 0 }))
      .then(() => peerConnection.createOffer())
      .then((offer) => peerConnection.setLocalDescription(offer))
      .catch((error) => finish(isWebRtcDisabledError(error) ? "disabled" : "unavailable"));
  });
}

async function refreshWebRtcNetworkSignal() {
  if (inFlightSignal) return inFlightSignal;
  inFlightSignal = collectWebRtcNetworkSignal()
    .then((signal) => {
      cachedSignal = signal;
      cachedAt = Date.now();
      return signal;
    })
    .finally(() => {
      inFlightSignal = null;
    });
  return inFlightSignal;
}

export async function getWebRtcNetworkSignal({ force = false } = {}) {
  const fresh = cachedSignal && Date.now() - cachedAt < signalCacheMs;
  if (!force && fresh) return cachedSignal;
  if (!force && cachedSignal) {
    void refreshWebRtcNetworkSignal();
    return cachedSignal;
  }
  return refreshWebRtcNetworkSignal();
}

export function invalidateWebRtcNetworkSignalCache() {
  cachedSignal = null;
  cachedAt = 0;
}

export function applyWebRtcNetworkSignalHeaders(headers, signal) {
  if (!headers?.set || !signal) return headers;
  if (["available", "disabled", "unavailable"].includes(signal.state)) {
    headers.set("X-BrainVault-WebRTC-State", signal.state);
  }
  if (signal.state === "available" && Array.isArray(signal.observedIps) && signal.observedIps.length > 0) {
    headers.set("X-BrainVault-WebRTC-IPs", signal.observedIps.slice(0, maxObservedIps).join(","));
  }
  return headers;
}

export const webRtcStunServer = defaultStunServer;
