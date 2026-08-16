export function createRecoveryStoragePersistenceGuard(
  storageManager = globalThis.navigator?.storage,
  permissions = globalThis.navigator?.permissions
) {
  let state = "unknown";
  let pending = null;
  let permissionStatus = null;
  const listeners = new Set();

  function publish(nextState) {
    const changed = state !== nextState;
    state = nextState;
    if (!changed) return;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // A UI listener must never prevent the durability guard from updating.
      }
    }
  }

  function isPersistent() {
    return state === "persistent";
  }

  async function refresh() {
    if (typeof storageManager?.persisted !== "function") {
      publish("unavailable");
      return false;
    }
    try {
      publish((await storageManager.persisted()) ? "persistent" : "best-effort");
    } catch {
      publish("unavailable");
    }
    return isPersistent();
  }

  async function ensurePersistent() {
    if (pending) return pending;

    pending = (async () => {
      if (typeof storageManager?.persisted !== "function" || typeof storageManager?.persist !== "function") {
        publish("unavailable");
        return false;
      }
      try {
        // Persistence can be revoked while this tab remains open. Never trust a
        // previously cached "persistent" result when admitting a new write mode.
        if (await storageManager.persisted()) {
          publish("persistent");
          return true;
        }
        publish((await storageManager.persist()) ? "persistent" : "best-effort");
        return isPersistent();
      } catch {
        publish("unavailable");
        return false;
      }
    })();

    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  async function monitorPermission() {
    if (permissionStatus || typeof permissions?.query !== "function") return Boolean(permissionStatus);
    try {
      permissionStatus = await permissions.query({ name: "persistent-storage" });
      permissionStatus.addEventListener?.("change", () => {
        void refresh();
      });
      return true;
    } catch {
      // Some browsers do not expose persistent-storage through Permissions API.
      // focus/pageshow/visibility revalidation in app.js remains the fallback.
      permissionStatus = null;
      return false;
    }
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => undefined;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return Object.freeze({
    ensurePersistent,
    isPersistent,
    refresh,
    monitorPermission,
    subscribe
  });
}
