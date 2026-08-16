export function createRecoveryStoragePersistenceGuard(storageManager = globalThis.navigator?.storage) {
  let state = "unknown";
  let pending = null;

  function isPersistent() {
    return state === "persistent";
  }

  async function refresh() {
    if (typeof storageManager?.persisted !== "function") {
      state = "unavailable";
      return false;
    }
    try {
      state = (await storageManager.persisted()) ? "persistent" : "best-effort";
    } catch {
      state = "unavailable";
    }
    return isPersistent();
  }

  async function ensurePersistent() {
    if (isPersistent()) return true;
    if (pending) return pending;

    pending = (async () => {
      if (typeof storageManager?.persisted !== "function" || typeof storageManager?.persist !== "function") {
        state = "unavailable";
        return false;
      }
      try {
        if (await storageManager.persisted()) {
          state = "persistent";
          return true;
        }
        state = (await storageManager.persist()) ? "persistent" : "best-effort";
        return isPersistent();
      } catch {
        state = "unavailable";
        return false;
      }
    })();

    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  return Object.freeze({ ensurePersistent, isPersistent, refresh });
}
