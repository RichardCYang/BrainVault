# Authenticated idle document-open latency

Date: 2026-08-13

## Symptom

Immediately after login, documents open without a noticeable pause. After the authenticated browser is left idle for several minutes, the next document open can pause before the page payload is returned.

## Root cause

The VPN/proxy access policy intentionally runs on every authenticated HTTP request. A successful clear-risk result is cached for five minutes. The public-relay directory is also refreshed every five minutes and can be as large as 8 MiB with a four-second network timeout.

Before this change, the relay-matching path synchronously awaited the full public-relay directory refresh whenever its five-minute freshness window expired. That means the first authenticated request after an idle period could inherit the bulk threat-intelligence download latency even though BrainVault already had a previously successful directory snapshot that its own safety policy permits retaining for up to fifteen minutes. The same request path also synchronously refreshed the Tor bulk list after its hourly freshness window, despite an existing six-hour stale-safety window.

This matches the observed shape: login warms the risk/directory caches, early document opens are fast, then the first request after the five-minute cache boundary can block on external threat-intelligence I/O.

## Fix

The public-relay directory helper now separates starting a refresh from obtaining the usable directory. When the existing directory is older than five minutes but still inside the existing fifteen-minute safety bound, the request immediately uses that snapshot and starts a de-duplicated refresh in the background. Cold start and snapshots older than the safety bound still await a synchronous refresh.

`src/lib/vpn-access-policy.ts` applies the same pattern to the Tor bulk list: an existing list inside the existing six-hour stale bound is usable immediately while the hourly refresh proceeds in the background. Cold start and over-age data remain synchronous.

The change does not alter block/allow decision rules, provider-response validation, IP matching, cache freshness limits, stale safety limits, account data, document data, database schema, authentication cookies, or collaboration document materialization.

## Regression protection

A dedicated relay-refresh latency regression test reproduces the timing boundary with a controlled clock and a deliberately unresolved second directory fetch. It verifies that after the five-minute freshness window expires:

- the next lookup returns without waiting for the refresh network request;
- a background refresh is still started;
- the existing cached directory remains the request-time source only while it is inside the pre-existing stale-safety window.

The normal VPN-policy source-audit tests continue to verify the provider set, timeouts, stale bounds, enforcement points, block reasons, WebRTC signals, and authenticated/collaboration enforcement coverage.
