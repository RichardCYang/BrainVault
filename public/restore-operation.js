import { createMutationId } from "./mutation-id.js";

// Pending operations survive a reload. Never expire an ambiguous restore or
// silently replace its id: the server may already have committed it.
export function createRestoreOperationStore(getStorage, newId = createMutationId) {
  const keyFor = (accountId, sourceKey) => `brainvault:restore:v1:${JSON.stringify([accountId, sourceKey])}`;
  const parse = (raw) => {
    if (raw === null) return null;
    const record = JSON.parse(raw);
    if (record?.version !== 1 || typeof record.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(record.operationId)) {
      throw new Error("Invalid pending restore operation");
    }
    return record;
  };
  return {
    begin(accountId, sourceKey) {
      const storage = getStorage();
      const key = keyFor(accountId, sourceKey);
      const existing = parse(storage.getItem(key));
      if (existing) return existing.operationId;
      const operationId = newId();
      storage.setItem(key, JSON.stringify({ version: 1, operationId }));
      if (parse(storage.getItem(key))?.operationId !== operationId) {
        throw new Error("Pending restore operation could not be persisted");
      }
      return operationId;
    },
    complete(accountId, sourceKey, operationId) {
      const storage = getStorage();
      const key = keyFor(accountId, sourceKey);
      if (parse(storage.getItem(key))?.operationId === operationId) storage.removeItem(key);
    }
  };
}
