export const legacyAuthSessionCookieName = "brainvault_session";
export const secureAuthSessionCookieName = "__Host-brainvault_session";

export function getAuthSessionCookieName(secure: boolean) {
  return secure ? secureAuthSessionCookieName : legacyAuthSessionCookieName;
}

/**
 * Return a cookie only when exactly one value with the requested name is
 * present. Duplicate cookies are ambiguous because user agents may order
 * host-only and parent-domain cookies differently; fail closed instead of
 * accepting an attacker-controlled first value.
 */
export function readUniqueCookieValue(cookieHeader: string | null | undefined, cookieName: string) {
  if (!cookieHeader) return null;

  let encodedValue: string | null = null;
  let matches = 0;
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (name !== cookieName) continue;
    matches += 1;
    const value = entry.slice(separator + 1).trim();
    if (!value) return null;
    encodedValue = value;
  }

  if (matches !== 1 || encodedValue === null) return null;
  try {
    return decodeURIComponent(encodedValue);
  } catch {
    return null;
  }
}
