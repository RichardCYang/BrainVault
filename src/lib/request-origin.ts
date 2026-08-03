export function parseExactHttpOrigin(value: string) {
  const candidate = value.trim();
  if (!candidate || candidate === "null") return null;

  try {
    const parsed = new URL(candidate);
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.origin !== candidate
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function createExactHttpOriginSet(origins: readonly string[]) {
  const result = new Set<string>();
  for (const origin of origins) {
    const parsed = parseExactHttpOrigin(origin);
    if (!parsed) throw new Error(`Invalid exact HTTP(S) origin: ${origin}`);
    result.add(parsed);
  }
  return result;
}
