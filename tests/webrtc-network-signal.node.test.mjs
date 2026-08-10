import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWebRtcNetworkSignalHeaders,
  collectWebRtcNetworkSignal,
  webRtcStunServer
} from "../public/webrtc-network-signal.js";

test("WebRTC network signal marks a missing RTCPeerConnection implementation as disabled", async () => {
  const signal = await collectWebRtcNetworkSignal({ RTCPeerConnectionImpl: null, timeoutMs: 10 });
  assert.deepEqual(signal, { state: "disabled", observedIps: [] });
});

test("WebRTC network signal collects only server-reflexive STUN candidate addresses", async () => {
  let receivedConfiguration = null;

  class FakePeerConnection {
    constructor(configuration) {
      receivedConfiguration = configuration;
      this.onicecandidate = null;
    }

    createDataChannel() {}

    async createOffer() {
      return { type: "offer", sdp: "" };
    }

    async setLocalDescription() {
      queueMicrotask(() => this.onicecandidate?.({
        candidate: {
          type: "host",
          address: "192.168.1.10",
          candidate: "candidate:1 1 UDP 1 192.168.1.10 5000 typ host"
        }
      }));
      queueMicrotask(() => this.onicecandidate?.({
        candidate: {
          type: "srflx",
          address: "198.51.100.10",
          candidate: "candidate:2 1 UDP 1 198.51.100.10 62000 typ srflx raddr 192.168.1.10 rport 5000"
        }
      }));
      queueMicrotask(() => this.onicecandidate?.({
        candidate: {
          candidate: "candidate:3 1 UDP 1 2001:db8::10 62001 typ srflx raddr 2001:db8::1 rport 5001"
        }
      }));
      queueMicrotask(() => this.onicecandidate?.({ candidate: null }));
    }

    close() {}
  }

  const signal = await collectWebRtcNetworkSignal({
    RTCPeerConnectionImpl: FakePeerConnection,
    timeoutMs: 100
  });

  assert.deepEqual(signal, {
    state: "available",
    observedIps: ["198.51.100.10", "2001:db8::10"]
  });
  assert.deepEqual(receivedConfiguration, {
    iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
    iceTransportPolicy: "all"
  });
  assert.equal(webRtcStunServer, "stun:stun.cloudflare.com:3478");
});

test("WebRTC network signal headers carry state and observed addresses", () => {
  const headers = new Headers();
  applyWebRtcNetworkSignalHeaders(headers, {
    state: "available",
    observedIps: ["203.0.113.5", "2001:db8::5"]
  });

  assert.equal(headers.get("X-BrainVault-WebRTC-State"), "available");
  assert.equal(headers.get("X-BrainVault-WebRTC-IPs"), "203.0.113.5,2001:db8::5");
});
