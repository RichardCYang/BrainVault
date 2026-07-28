const defaultMaxPasses = 64;
const defaultStablePasses = 3;

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : fallback;
}

function getSignature(keys) {
  return [...keys].sort().join("\u0000");
}

export function inspectStorageKeys(
  storage,
  { maxPasses = defaultMaxPasses, stablePasses = defaultStablePasses } = {}
) {
  if (!storage) return { keys: [], reliable: false, error: new Error("Storage is unavailable") };

  const observedKeys = new Set();
  const normalizedMaxPasses = normalizePositiveInteger(maxPasses, defaultMaxPasses);
  const normalizedStablePasses = normalizePositiveInteger(stablePasses, defaultStablePasses);
  let previousSignature = null;
  let consecutiveStablePasses = 0;

  try {
    for (let pass = 0; pass < normalizedMaxPasses; pass += 1) {
      const passKeys = new Set();
      const lengthBefore = storage.length;

      for (let index = 0; index < lengthBefore; index += 1) {
        const key = storage.key(index);
        if (typeof key === "string" && key.length > 0) {
          passKeys.add(key);
          observedKeys.add(key);
        }
      }

      // A concurrent removal can shift an unread key to an index already visited
      // by the forward scan. Scanning the current range in reverse captures that
      // survivor without discarding keys observed before the shift.
      const lengthDuring = storage.length;
      for (let index = lengthDuring - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (typeof key === "string" && key.length > 0) {
          passKeys.add(key);
          observedKeys.add(key);
        }
      }

      const lengthAfter = storage.length;
      const signature = getSignature(passKeys);
      const completePass = lengthBefore === lengthAfter && passKeys.size === lengthAfter;

      if (completePass && signature === previousSignature) consecutiveStablePasses += 1;
      else consecutiveStablePasses = completePass ? 1 : 0;

      previousSignature = completePass ? signature : null;
      if (consecutiveStablePasses >= normalizedStablePasses) {
        return { keys: [...observedKeys], reliable: true, error: null };
      }
    }

    return {
      keys: [...observedKeys],
      reliable: false,
      error: new Error("Storage key enumeration did not stabilize")
    };
  } catch (error) {
    return { keys: [...observedKeys], reliable: false, error };
  }
}
