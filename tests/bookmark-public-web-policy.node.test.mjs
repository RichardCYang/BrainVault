import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isBookmarkFetchHostAllowedByOptionalAllowlist
} from "../src/lib/bookmark-host-policy.ts";
import { isPrivateAddress, isPrivateOrLocalHostname } from "../src/lib/network-address.ts";

const bookmarkSource = readFileSync(new URL("../src/lib/bookmark.ts", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

test("empty bookmark host list enables public-web destinations without manual host registration", () => {
  assert.equal(isBookmarkFetchHostAllowedByOptionalAllowlist("example.com", []), true);
  assert.equal(isBookmarkFetchHostAllowedByOptionalAllowlist("news.example.net", []), true);
});

test("configured bookmark host list remains a backward-compatible optional egress restriction", () => {
  const allowedHosts = ["example.com", "1.1.1.1"];
  assert.equal(isBookmarkFetchHostAllowedByOptionalAllowlist("example.com", allowedHosts), true);
  assert.equal(isBookmarkFetchHostAllowedByOptionalAllowlist("cdn.example.com", allowedHosts), true);
  assert.equal(isBookmarkFetchHostAllowedByOptionalAllowlist("example.com.evil.test", allowedHosts), false);
  assert.equal(isBookmarkFetchHostAllowedByOptionalAllowlist("1.1.1.1", allowedHosts), true);
  assert.equal(isBookmarkFetchHostAllowedByOptionalAllowlist("1.1.1.2", allowedHosts), false);
});

test("public-web mode still rejects local, private, metadata, documentation, multicast, and reserved targets", () => {
  for (const hostname of [
    "localhost",
    "service.internal",
    "printer.local",
    "metadata.google.internal",
    "singlelabel"
  ]) {
    assert.equal(isPrivateOrLocalHostname(hostname), true, hostname);
  }

  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "168.63.129.16",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "64:ff9b::7f00:1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
    "::ffff:127.0.0.1"
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("1.1.1.1"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("bookmark fetch path preserves the SSRF, redirect, port, pinning, deadline, and body guards", () => {
  assert.match(bookmarkSource, /isSelfOrSubdomainBookmarkFetchHost\(url\.hostname\)/);
  assert.match(bookmarkSource, /BOOKMARK_FETCH_ALLOWED_PORTS\.includes\(effectivePort\)/);
  assert.match(bookmarkSource, /const addresses = await resolvePublicAddresses\(url\)/);
  assert.match(bookmarkSource, /addresses\.some[\s\S]*isPrivateAddress\(item\.address\)/);
  assert.match(bookmarkSource, /lookup: createPinnedLookup\(addresses\)/);
  assert.match(bookmarkSource, /fetchHtml\(nextUrl, redirectsLeft - 1, deadline, hostPolicy\)/);
  assert.match(bookmarkSource, /url\.protocol === "https:" && nextUrl\.protocol !== "https:"/);
  assert.match(bookmarkSource, /enforceAbsoluteRequestDeadline\(request, remainingTime\)/);
  assert.match(bookmarkSource, /BOOKMARK_FETCH_MAX_BYTES/);
  assert.match(bookmarkSource, /BOOKMARK_NOT_HTML/);
  assert.match(bookmarkSource, /contentType/);
  assert.match(envExample, /Leave empty to allow any public HTTP\(S\) hostname after SSRF checks/);
});
