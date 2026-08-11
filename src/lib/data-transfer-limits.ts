export const dataTransferResourceLimits = Object.freeze({
  maxPages: 20_000,
  maxBlocks: 50_000,
  maxTags: 20_000,
  maxPageTags: 100_000,
  maxPageShares: 20_000,
  maxPageVersions: 200_000,
  maxAttachments: 5_000,
  maxPageCovers: 20_000,
  maxCustomIcons: 20_000,
  maxCustomIconLibraryRemovals: 50_000,
  // manifest + uploaded attachment files (active + retained) + page covers + uploaded custom icons
  maxZipEntries: 45_001,
  maxCentralDirectoryBytes: 8 * 1024 * 1024
});

function jsonStringByteLength(value: string) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isOmittedJsonValue(value: unknown) {
  const type = typeof value;
  return type === "undefined" || type === "function" || type === "symbol";
}

/**
 * Measures the exact UTF-8 byte length of JSON-compatible data without first
 * creating one aggregate JSON string. Returns null as soon as the limit is
 * exceeded. BrainVault uses this before serializing a backup manifest so an
 * oversized workspace cannot force a much larger temporary string allocation.
 */
export function measureJsonUtf8BytesWithinLimit(value: unknown, maxBytes: number): number | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("JSON byte limit must be a non-negative safe integer");
  }

  let total = 0;
  const ancestors = new Set<object>();
  const add = (bytes: number) => {
    total += bytes;
    return total <= maxBytes;
  };

  const visit = (current: unknown, arrayItem = false): boolean => {
    if (current === null) return add(4);

    switch (typeof current) {
      case "string":
        return add(jsonStringByteLength(current));
      case "number": {
        const serialized = JSON.stringify(current);
        return add(Buffer.byteLength(serialized ?? "null", "utf8"));
      }
      case "boolean":
        return add(current ? 4 : 5);
      case "bigint":
        throw new TypeError("BigInt values cannot be serialized to JSON");
      case "undefined":
      case "function":
      case "symbol":
        if (arrayItem) return add(4);
        throw new TypeError("Top-level JSON value is not serializable");
      case "object":
        break;
    }

    const objectValue = current as object;
    if (ancestors.has(objectValue)) throw new TypeError("Converting circular structure to JSON");
    ancestors.add(objectValue);
    try {
      if (Array.isArray(current)) {
        if (!add(1)) return false;
        for (let index = 0; index < current.length; index += 1) {
          if (index > 0 && !add(1)) return false;
          const item = current[index];
          if (isOmittedJsonValue(item)) {
            if (!add(4)) return false;
          } else if (!visit(item, true)) {
            return false;
          }
        }
        return add(1);
      }

      if (!add(1)) return false;
      let emitted = false;
      for (const key of Object.keys(current as Record<string, unknown>)) {
        const item = (current as Record<string, unknown>)[key];
        if (isOmittedJsonValue(item)) continue;
        if (emitted && !add(1)) return false;
        if (!add(jsonStringByteLength(key) + 1)) return false;
        if (!visit(item)) return false;
        emitted = true;
      }
      return add(1);
    } finally {
      ancestors.delete(objectValue);
    }
  };

  return visit(value) ? total : null;
}
