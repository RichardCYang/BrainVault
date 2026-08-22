import net from "node:net";

export function normalizeBookmarkFetchHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isBookmarkFetchHostAllowedByOptionalAllowlist(
  hostname: string,
  allowedHosts: readonly string[]
) {
  // An empty list intentionally means “no hostname allowlist”. The caller must still
  // apply the public-web SSRF gate (scheme/port/self-origin/DNS/IP/redirect checks).
  if (allowedHosts.length === 0) return true;

  const host = normalizeBookmarkFetchHostname(hostname);
  const hostFamily = net.isIP(host);
  return allowedHosts.some((allowedValue) => {
    const allowed = normalizeBookmarkFetchHostname(allowedValue);
    if (host === allowed) return true;
    return hostFamily === 0 && net.isIP(allowed) === 0 && host.endsWith(`.${allowed}`);
  });
}
