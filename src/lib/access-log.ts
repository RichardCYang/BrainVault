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

export const productionAccessLogFormat =
  ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":safe-referrer" ":user-agent"';

export const developmentAccessLogFormat =
  ':method :safe-url :status :response-time ms - :res[content-length]';
