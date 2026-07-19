const editableBlockFields = Object.freeze(["type", "markdown", "checked", "metadata"]);

export function rebaseCommittedPageTitle(committedPage, localTitle = null) {
  if (!committedPage || typeof committedPage !== "object" || typeof localTitle !== "string") {
    return committedPage;
  }
  return { ...committedPage, title: localTitle };
}

export function rebaseCommittedBlockContent(committedBlock, localPayload = null) {
  if (
    !committedBlock ||
    typeof committedBlock !== "object" ||
    !localPayload ||
    typeof localPayload !== "object" ||
    Array.isArray(localPayload)
  ) {
    return committedBlock;
  }

  const localContent = {};
  for (const field of editableBlockFields) {
    if (Object.hasOwn(localPayload, field)) localContent[field] = localPayload[field];
  }
  return { ...committedBlock, ...localContent, htmlCache: null };
}
