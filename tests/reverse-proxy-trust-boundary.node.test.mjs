import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExpressTrustProxySetting,
  forwardedForAddresses,
  forwardedProtocol,
  getClientIpAddressFromTrustedProxyRequest,
  isHttpsRequestFromTrustedProxy
} from "../src/lib/reverse-proxy.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8").replace(/\r\n/g, "\n");

test("numeric hop trust spoofing is reproducible in the retired decision model and rejected now", () => {
  const request = {
    headers: { "x-forwarded-proto": "https" },
    socket: { remoteAddress: "203.0.113.77" }
  };

  const retiredHopTrustDecision = 1 > 0 && forwardedProtocol(request.headers) === "https";
  assert.equal(retiredHopTrustDecision, true);
  assert.equal(isHttpsRequestFromTrustedProxy(request, ["loopback"]), false);
  assert.throws(
    () => createExpressTrustProxySetting(1, []),
    /TRUST_PROXY_HOPS must remain 0/
  );
});

test("forwarded protocol parsing rejects duplicate, comma-delimited, and non-HTTP values", () => {
  assert.equal(forwardedProtocol({ "x-forwarded-proto": "https" }), "https");
  assert.equal(forwardedProtocol({ "x-forwarded-proto": " HTTPS " }), "https");
  assert.equal(forwardedProtocol({ "x-forwarded-proto": "https, http" }), null);
  assert.equal(forwardedProtocol({ "x-forwarded-proto": ["https", "http"] }), null);
  assert.equal(forwardedProtocol({ "x-forwarded-proto": "wss" }), null);
});


test("websocket client IP follows the same explicit trusted-proxy boundary", () => {
  const directSpoof = {
    headers: { "x-forwarded-for": "198.51.100.10" },
    socket: { remoteAddress: "203.0.113.77" }
  };
  assert.equal(getClientIpAddressFromTrustedProxyRequest(directSpoof, ["loopback"]), "203.0.113.77");

  const oneProxy = {
    headers: { "x-forwarded-for": "198.51.100.10" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  assert.equal(getClientIpAddressFromTrustedProxyRequest(oneProxy, ["loopback"]), "198.51.100.10");

  const appendedSpoof = {
    headers: { "x-forwarded-for": "192.0.2.99, 198.51.100.10" },
    socket: { remoteAddress: "127.0.0.1" }
  };
  assert.equal(getClientIpAddressFromTrustedProxyRequest(appendedSpoof, ["loopback"]), "198.51.100.10");
  assert.deepEqual(forwardedForAddresses({ "x-forwarded-for": "192.0.2.99, nope" }), null);
});

test("production wiring requires encrypted transport and exact reverse-proxy peers", () => {
  const envSource = read("src/config/env.ts");
  const middlewareSource = read("src/middleware/https.ts");
  const collaborationSource = read("src/lib/collaboration-server.ts");

  assert.match(envSource, /TRUST_PROXY_HOPS must remain 0/);
  assert.match(envSource, /TRUST_PROXY_ADDRESSES must not trust every address/);
  assert.match(envSource, /HTTPS_MODE must be proxy or posh-acme in production/);
  assert.match(envSource, /HTTPS_MODE=proxy requires TRUST_PROXY_ADDRESSES/);
  assert.match(middlewareSource, /isHttpsRequestFromTrustedProxy\(req, options\.trustedProxyAddresses\)/);
  assert.doesNotMatch(middlewareSource, /req\.secure/);
  assert.match(
    collaborationSource,
    /isHttpsRequestFromTrustedProxy\(request, env\.TRUST_PROXY_ADDRESSES\)/
  );
});
