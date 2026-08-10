import assert from "node:assert/strict";
import test from "node:test";
import { isCountryPolicyLocalNetworkIp } from "../src/lib/geo-country.ts";

test("country policy local bypass is limited to loopback, RFC1918, and IPv6 ULA", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.10",
    "::1",
    "0:0:0:0:0:0:0:1",
    "fc00::1",
    "fdff:ffff::1",
    "::ffff:192.168.10.20"
  ]) {
    assert.equal(isCountryPolicyLocalNetworkIp(address), true, `${address} should be local`);
  }

  for (const address of [
    "100.64.0.1",
    "169.254.1.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "8.8.8.8",
    "fe80::1",
    "2001:db8::1",
    "::",
    "unknown"
  ]) {
    assert.equal(isCountryPolicyLocalNetworkIp(address), false, `${address} must not bypass country policy`);
  }
});
