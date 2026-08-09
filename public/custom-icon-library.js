const customIconLibraryDbName = "brainvault.customIconLibrary";
const customIconLibraryStoreName = "icons";
const customIconLibraryDbVersion = 1;
export const customIconLibraryLimit = 36;

let databasePromise = null;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("INDEXEDDB_REQUEST_FAILED")), { once: true });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("INDEXEDDB_TRANSACTION_ABORTED")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("INDEXEDDB_TRANSACTION_FAILED")), { once: true });
  });
}

function openCustomIconLibraryDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(customIconLibraryDbName, customIconLibraryDbVersion);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (database.objectStoreNames.contains(customIconLibraryStoreName)) return;
      const store = database.createObjectStore(customIconLibraryStoreName, { keyPath: "key" });
      store.createIndex("userId", "userId", { unique: false });
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => {
      databasePromise = null;
      reject(request.error ?? new Error("INDEXEDDB_OPEN_FAILED"));
    }, { once: true });
    request.addEventListener("blocked", () => {
      databasePromise = null;
      reject(new Error("INDEXEDDB_OPEN_BLOCKED"));
    }, { once: true });
  });

  return databasePromise;
}

function fallbackFingerprint(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}-${value.length}`;
}

async function fingerprintCustomIcon(value) {
  try {
    if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
      const bytes = new TextEncoder().encode(value);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // A deterministic fallback still gives stable keys on restricted contexts.
  }
  return fallbackFingerprint(value);
}

function normalizeTimestamp(value, fallback = 0) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function normalizeStoredRecord(record) {
  if (
    !record ||
    typeof record !== "object" ||
    typeof record.value !== "string" ||
    !record.value.startsWith("image:")
  ) return null;

  return {
    value: record.value,
    lastUsedAt: normalizeTimestamp(record.lastUsedAt)
  };
}

async function getUserRecords(database, userId) {
  const transaction = database.transaction(customIconLibraryStoreName, "readonly");
  const index = transaction.objectStore(customIconLibraryStoreName).index("userId");
  const records = await requestResult(index.getAll(userId));
  await transactionComplete(transaction);
  return Array.isArray(records) ? records : [];
}

async function pruneUserRecords(database, userId, limit = customIconLibraryLimit) {
  const records = await getUserRecords(database, userId);
  if (records.length <= limit) return;

  records.sort((a, b) => normalizeTimestamp(b.lastUsedAt) - normalizeTimestamp(a.lastUsedAt));
  const stale = records.slice(limit);
  const transaction = database.transaction(customIconLibraryStoreName, "readwrite");
  const store = transaction.objectStore(customIconLibraryStoreName);
  for (const record of stale) {
    if (typeof record?.key === "string") store.delete(record.key);
  }
  await transactionComplete(transaction);
}

export async function listCustomIconLibrary(userId) {
  if (typeof userId !== "string" || !userId) return [];
  const database = await openCustomIconLibraryDatabase();
  if (!database) return [];

  const records = await getUserRecords(database, userId);
  return records
    .map(normalizeStoredRecord)
    .filter(Boolean)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, customIconLibraryLimit);
}

export async function rememberCustomIconLibraryEntry(userId, value, lastUsedAt = Date.now()) {
  if (
    typeof userId !== "string" ||
    !userId ||
    typeof value !== "string" ||
    !value.startsWith("image:")
  ) return;

  const database = await openCustomIconLibraryDatabase();
  if (!database) return;

  const fingerprint = await fingerprintCustomIcon(value);
  const key = `${userId}:${fingerprint}`;
  const transaction = database.transaction(customIconLibraryStoreName, "readwrite");
  transaction.objectStore(customIconLibraryStoreName).put({
    key,
    userId,
    value,
    lastUsedAt: normalizeTimestamp(lastUsedAt, Date.now())
  });
  await transactionComplete(transaction);
  await pruneUserRecords(database, userId);
}

export async function rememberCustomIconLibraryEntries(userId, entries) {
  if (typeof userId !== "string" || !userId || !Array.isArray(entries) || !entries.length) return;

  const normalized = [];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.value !== "string" ||
      !entry.value.startsWith("image:")
    ) continue;
    normalized.push({
      value: entry.value,
      lastUsedAt: normalizeTimestamp(entry.lastUsedAt)
    });
  }
  if (!normalized.length) return;

  const database = await openCustomIconLibraryDatabase();
  if (!database) return;

  const existing = await getUserRecords(database, userId);
  const existingByKey = new Map(existing.map((record) => [record.key, record]));
  const writes = [];
  for (const entry of normalized) {
    const fingerprint = await fingerprintCustomIcon(entry.value);
    const key = `${userId}:${fingerprint}`;
    const previous = existingByKey.get(key);
    writes.push({
      key,
      userId,
      value: entry.value,
      lastUsedAt: previous
        ? Math.max(normalizeTimestamp(previous.lastUsedAt), entry.lastUsedAt)
        : entry.lastUsedAt
    });
  }

  const transaction = database.transaction(customIconLibraryStoreName, "readwrite");
  const store = transaction.objectStore(customIconLibraryStoreName);
  for (const record of writes) store.put(record);
  await transactionComplete(transaction);
  await pruneUserRecords(database, userId);
}
