export const customIconLibraryLimit = 36;

const customIconApiPath = "/api/custom-icons";
const uploadedCustomIconValuePattern = /^image:\/upload\/icons\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,96}\.(?:png|jpg|webp|ico)$/;

function normalizeTimestamp(value, fallback = 0) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function normalizeStoredEntry(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.value !== "string") return null;
  if (!uploadedCustomIconValuePattern.test(entry.value)) return null;
  return {
    value: entry.value,
    lastUsedAt: normalizeTimestamp(entry.lastUsedAt)
  };
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  let body = options.body;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }

  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers,
    body
  });
  if (!response.ok) {
    const error = new Error(`CUSTOM_ICON_LIBRARY_HTTP_${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function listCustomIconLibrary(userId) {
  if (typeof userId !== "string" || !userId) return { entries: [], removedKeys: [] };
  const data = await request(customIconApiPath);
  const entries = (Array.isArray(data?.icons) ? data.icons : [])
    .map(normalizeStoredEntry)
    .filter(Boolean)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, customIconLibraryLimit);
  const removedKeys = (Array.isArray(data?.removedKeys) ? data.removedKeys : [])
    .filter((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
  return { entries, removedKeys };
}

export async function rememberCustomIconLibraryEntry(userId, value) {
  if (
    typeof userId !== "string"
    || !userId
    || typeof value !== "string"
    || !value.startsWith("image:")
  ) return;

  await request(`${customIconApiPath}/restore`, {
    method: "POST",
    body: { value }
  });
}

export async function rememberCustomIconLibraryEntries(userId, entries) {
  if (typeof userId !== "string" || !userId || !Array.isArray(entries) || !entries.length) return;
  const values = [...new Set(entries
    .map((entry) => entry?.value)
    .filter((value) => typeof value === "string" && uploadedCustomIconValuePattern.test(value)))]
    .slice(0, customIconLibraryLimit);
  if (!values.length) return;

  await request(`${customIconApiPath}/touch`, {
    method: "POST",
    body: { values }
  });
}

export async function removeCustomIconLibraryEntry(userId, value) {
  if (typeof userId !== "string" || !userId || typeof value !== "string") return null;
  return request(customIconApiPath, {
    method: "DELETE",
    body: { value }
  });
}

export async function customIconLibraryValueKey(value) {
  if (typeof value !== "string" || !value || !globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function filterRemovedCustomIconLibraryEntries(entries, removedKeys) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const removed = new Set(Array.isArray(removedKeys) ? removedKeys : removedKeys instanceof Set ? removedKeys : []);
  if (!removed.size) return entries;

  const filtered = [];
  for (const entry of entries) {
    const key = await customIconLibraryValueKey(entry?.value);
    if (!key || !removed.has(key)) filtered.push(entry);
  }
  return filtered;
}
