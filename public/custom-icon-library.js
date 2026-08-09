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
  if (!response.ok) throw new Error(`CUSTOM_ICON_LIBRARY_HTTP_${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

export async function listCustomIconLibrary(userId) {
  if (typeof userId !== "string" || !userId) return [];
  const data = await request(customIconApiPath);
  return (Array.isArray(data?.icons) ? data.icons : [])
    .map(normalizeStoredEntry)
    .filter(Boolean)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, customIconLibraryLimit);
}

export async function rememberCustomIconLibraryEntry(userId, value) {
  if (
    typeof userId !== "string"
    || !userId
    || typeof value !== "string"
    || !uploadedCustomIconValuePattern.test(value)
  ) return;

  await request(`${customIconApiPath}/touch`, {
    method: "POST",
    body: { values: [value] }
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
