/** Remove request-target and referrer query/fragment data before access logging. */
export function stripUrlQueryAndFragment(value: unknown, fallback = "-") {
  if (typeof value !== "string" || !value) return fallback;
  const queryIndex = value.indexOf("?");
  const fragmentIndex = value.indexOf("#");
  const cutAt = [queryIndex, fragmentIndex]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), value.length);
  const stripped = value.slice(0, cutAt);
  return stripped || fallback;
}

const accessLogControlCharacters = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Keep untrusted header/request values on one bounded, terminal-safe log line. */
export function sanitizeAccessLogValue(value: unknown, fallback = "-", maxLength = 512) {
  const source = typeof value === "string" ? value : fallback;
  const sanitized = source.replace(accessLogControlCharacters, " ").trim();
  return (sanitized || fallback).slice(0, maxLength);
}

export const productionAccessLogFormat =
  ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":safe-referrer" ":safe-user-agent"';

export const developmentAccessLogFormat =
  ':method :safe-url :status :response-time ms - :res[content-length]';
