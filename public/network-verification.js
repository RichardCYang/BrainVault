// The browser only opens a measurement channel and redeems an opaque receipt.
// RTT values, reference addresses and verdicts are never supplied by the client.
let inFlight = null;
let refreshAt = 0;
let refreshTimer = null;
let generation = 0;

export function invalidateNetworkVerification() { refreshAt = 0; generation += 1; }

export async function ensureNetworkVerification({ force = false } = {}) {
  if (typeof globalThis.WebSocket !== "function" || !globalThis.location?.href) return;
  if (!force && Date.now() < refreshAt) return;
  if (inFlight) return inFlight;
  const startedGeneration = generation;
  inFlight = (async () => {
    let delay = 10_000;
    try {
      const response = await fetch("/api/network-verification/", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: "{}", cache: "no-store", signal: AbortSignal.timeout(3_000)
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data.available) { delay = 60_000; return; }
      if (data.path !== "/api/network-verification/probe" || !Array.isArray(data.protocols) || data.protocols.length !== 2
        || data.protocols[0] !== "brainvault.measure.v1" || !/^brainvault\.measure\.ticket\.[a-f0-9]{64}$/.test(data.protocols[1])) return;
      const receipt = await new Promise((resolve, reject) => {
        const url = new URL(data.path, globalThis.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(url, data.protocols);
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          try { socket.close(); } catch { /* A failed handshake is already unusable. */ }
          if (value) resolve(value); else reject(new Error("Connection measurement unavailable"));
        };
        const timer = setTimeout(() => finish(null), 14_000);
        socket.onmessage = (event) => {
          try {
            const value = JSON.parse(event.data)?.receipt;
            finish(typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null);
          } catch { finish(null); }
        };
        socket.onerror = () => finish(null);
        socket.onclose = () => finish(null);
      });
      if (startedGeneration !== generation) return;
      const completed = await fetch("/api/network-verification/complete", {
        method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipt }), signal: AbortSignal.timeout(3_000)
      });
      if (completed.ok) delay = 60_000;
    } catch {
      // Account policy on the server decides what missing evidence means.
      // Failure must not prevent accounts with blocking disabled from logging in.
    } finally {
      if (startedGeneration === generation) refreshAt = Date.now() + delay;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (!globalThis.document?.hidden) void ensureNetworkVerification();
      }, Math.max(delay, 30_000));
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

globalThis.addEventListener?.("online", invalidateNetworkVerification);
globalThis.document?.addEventListener("visibilitychange", () => {
  if (!globalThis.document.hidden) void ensureNetworkVerification();
});
