/**
 * Convert a Unicode emoji sequence into the Twemoji SVG asset filename key.
 * Returns null for non-string or empty input, matching the JavaScript runtime implementation.
 */
export function getTwemojiAssetKey(value: unknown): string | null;
