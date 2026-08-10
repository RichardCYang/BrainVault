# Country Policy Local-Network Access

Date: 2026-08-10

## Problem

Country login policies intentionally fail closed when a public client IP cannot be mapped to a country. Loopback and private LAN addresses cannot have a meaningful public GeoIP country, so the same fail-closed behavior prevented an authenticated user on localhost or a private LAN from saving an enabled country policy and could also reject later authenticated requests from that local network.

## Narrow local exception

Country-policy enforcement now treats only these source ranges as local and therefore outside public-country enforcement:

- IPv4 loopback: `127.0.0.0/8`
- RFC 1918 private IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- IPv6 loopback: `::1/128`
- IPv6 Unique Local Addresses: `fc00::/7`

The exception is used both when enforcing an already-enabled country policy and when checking whether a newly proposed policy would lock out the IP that is changing the setting. The GeoIP resolver itself is unchanged: local addresses still return no country because fabricating a country for a private address would be misleading.

## Ranges deliberately not exempted

The implementation does not equate every non-public or special-purpose address with a trusted local LAN. In particular, CGNAT/shared space (`100.64.0.0/10`), IPv4/IPv6 link-local space, documentation ranges, unspecified addresses, multicast/reserved space, malformed input, and `unknown` do not bypass an enabled country policy. They continue through the normal fail-closed path.

This distinction prevents the local exception from becoming a broad bypass for addresses that merely lack a public-country mapping.

## Proxy trust boundary

The exception is applied only after BrainVault obtains the client address from the existing Express/reverse-proxy trust boundary. In direct mode, the socket peer is used. In proxy mode, `TRUST_PROXY_ADDRESSES` remains an exact trusted-proxy allowlist; arbitrary `X-Forwarded-For` values are not independently trusted by the country-policy code.

Operators should continue to keep the application port private behind the configured reverse proxy and should not broaden the trusted-proxy list merely to make a local client appear trusted.

## Verification

Regression coverage checks that loopback, RFC 1918, IPv6 ULA, and IPv4-mapped private addresses qualify for the country-policy local exception, while CGNAT, link-local, documentation, public, unspecified, malformed, and unknown addresses do not.
