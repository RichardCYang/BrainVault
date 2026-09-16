// @ts-check

/**
 * Return the existing search-summary prefix without joining the discarded tail.
 * Inputs are already-normalized strings. This is NOT a validator or sanitizer:
 * callers must finish normalization/validation before yielding summary fields.
 * Length and slicing intentionally use UTF-16 code units, including lone surrogates.
 * No input, iterator, or result is cached across calls/pages/accounts.
 * @param {Iterable<string>} lines
 * @param {{separator?: string, skipEmpty?: boolean, maxLength?: number}} [options]
 */
export function joinSummaryPrefix(lines, { separator = "\n", skipEmpty = true, maxLength = 20_000 } = {}) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) throw new RangeError("Invalid summary length");
  if (maxLength === 0) return "";
  const parts = [];
  let remaining = maxLength;
  let first = true;
  for (const line of lines) {
    if (skipEmpty && !line) continue;
    if (!first) {
      const delimiter = separator.slice(0, remaining);
      parts.push(delimiter);
      remaining -= delimiter.length;
    }
    const part = line.slice(0, remaining);
    parts.push(part);
    remaining -= part.length;
    first = false;
    if (remaining === 0) break;
  }
  return parts.join("");
}
