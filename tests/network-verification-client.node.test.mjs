import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { networkMeasurementTranslations } from "../public/network-measurement-i18n.js";
import { translationCatalogs } from "../public/i18n.js";

async function clientHarness({ available = true, path = "/api/network-verification/probe" } = {}) {
  const source = (await readFile(new URL("../public/network-verification.js", import.meta.url), "utf8")).replace(/export /g, "");
  const calls = [];
  let sockets = 0;
  const sandbox = {
    location: { href: "https://notes.example.com/" }, document: { hidden: false, addEventListener() {} }, addEventListener() {},
    URL, Date, AbortSignal,
    setTimeout() { return 1; }, clearTimeout() {},
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ available, path, protocols: ["brainvault.measure.v1", "brainvault.measure.ticket." + "a".repeat(64)] }) };
    },
    WebSocket: class {
      constructor(url, protocols) {
        sockets += 1;
        assert.equal(String(url), "wss://notes.example.com/api/network-verification/probe");
        assert.equal(protocols[0], "brainvault.measure.v1");
        queueMicrotask(() => this.onmessage({ data: JSON.stringify({ receipt: "b".repeat(64) }) }));
      }
      close() {}
    }
  };
  vm.runInNewContext(source + "\nglobalThis.client = { ensureNetworkVerification, invalidateNetworkVerification };", sandbox);
  return { client: sandbox.client, calls, sockets: () => sockets };
}

test("concurrent browser requests share one measurement and submit only its opaque receipt", async () => {
  const h = await clientHarness();
  await Promise.all(Array.from({ length: 20 }, () => h.client.ensureNetworkVerification()));
  assert.equal(h.sockets(), 1); assert.equal(h.calls.length, 2);
  assert.deepEqual(JSON.parse(h.calls[1].options.body), { receipt: "b".repeat(64) });
  assert.equal(h.calls[1].options.credentials, "same-origin");
  await h.client.ensureNetworkVerification(); assert.equal(h.calls.length, 2);
  h.client.invalidateNetworkVerification(); await h.client.ensureNetworkVerification(); assert.equal(h.calls.length, 4);
});

test("unsupported paths back off without interfering with ordinary account requests", async () => {
  const h = await clientHarness({ available: false });
  await h.client.ensureNetworkVerification(); await h.client.ensureNetworkVerification();
  assert.equal(h.sockets(), 0); assert.equal(h.calls.length, 1);
});

test("measurement configuration cannot redirect a browser to an external probe", async () => {
  const h = await clientHarness({ path: "https://attacker.example/probe" });
  await h.client.ensureNetworkVerification(); assert.equal(h.sockets(), 0); assert.equal(h.calls.length, 1);
});

test("all supported locales expose the measurement states and preserve Unicode text", () => {
  for (const [language, catalog] of Object.entries(networkMeasurementTranslations)) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(networkMeasurementTranslations.en).sort());
    for (const key of ["vpnMeasurementTcpProxy", "vpnMeasurementTcpUnavailable", "vpnMeasurementTcpDisabled", "vpnMeasurementTcpMismatch"]) {
      assert.equal(typeof catalog[key], "string");
    }
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, "string"); assert.ok(value.length > 0); assert.doesNotMatch(value, /\?{2,}/);
      assert.equal(translationCatalogs[language].account[key], value);
    }
  }
  assert.match(translationCatalogs.ko.account.vpnMeasurementRefresh, /다시 측정/);
});
