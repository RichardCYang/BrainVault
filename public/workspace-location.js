const authFragments = new Set(["login", "signup"]);

function normalizeHash(hash) {
  return String(hash ?? "").replace(/^#/, "");
}

/**
 * Parses the browser fragment into a reload-safe workspace destination.
 * Authentication fragments intentionally return null because they belong to
 * the logged-out shell rather than the authenticated workspace router.
 */
export function parseWorkspaceLocation(hash) {
  const fragment = normalizeHash(hash);
  if (!fragment) return { view: "home" };
  if (authFragments.has(fragment)) return null;

  const params = new URLSearchParams(fragment);
  const pageId = params.get("page")?.trim();
  if (pageId) {
    return {
      view: "page",
      pageId,
      pageMode: params.get("mode") === "write" ? "write" : "read"
    };
  }

  const collectionId = params.get("collection")?.trim();
  if (collectionId) return { view: "collection", collectionId };
  return null;
}

/**
 * Serializes workspace state into a same-document fragment. Home intentionally
 * uses an empty fragment so the canonical workspace landing URL remains clean.
 */
export function serializeWorkspaceLocation(location) {
  if (!location || location.view === "home") return "";

  if (location.view === "page" && location.pageId) {
    const params = new URLSearchParams({ page: String(location.pageId) });
    if (location.pageMode === "write") params.set("mode", "write");
    return `#${params.toString()}`;
  }

  if (location.view === "collection" && location.collectionId) {
    return `#${new URLSearchParams({ collection: String(location.collectionId) }).toString()}`;
  }

  return "";
}
