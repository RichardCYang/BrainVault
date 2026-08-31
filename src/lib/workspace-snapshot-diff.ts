import { createHash } from "node:crypto";
import type { BrainVaultBackup } from "./data-transfer.js";

const maxPageDetails = 200;
const maxBlockDetails = 500;
const textContextLength = 180;

export type DiffValue = string | number | boolean | null | string[] | {
  length: number;
  sha256: string;
  excerpt: string;
};

export type FieldDifference = {
  field: string;
  snapshot: DiffValue;
  current: DiffValue;
};

export type BlockDifference = {
  blockId: string;
  status: "added" | "removed" | "modified";
  snapshotType: string | null;
  currentType: string | null;
  fields: FieldDifference[];
};

export type PageDifference = {
  pageId: string;
  status: "added" | "removed" | "modified";
  snapshotTitle: string | null;
  currentTitle: string | null;
  fields: FieldDifference[];
  blocks: BlockDifference[];
  blockSummary: { added: number; removed: number; modified: number };
  blockDetailsTruncated: boolean;
};

function sortedUnique(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function stableJson(value: unknown) {
  return JSON.stringify(value) ?? "null";
}

function stableStringList(values: unknown[]) {
  return values.map((value) => stableJson(value)).sort((left, right) => left.localeCompare(right));
}

function summarizeTextDifference(before: string | null, after: string | null) {
  const left = before ?? "";
  const right = after ?? "";
  let firstDifference = 0;
  const commonLength = Math.min(left.length, right.length);
  while (firstDifference < commonLength && left[firstDifference] === right[firstDifference]) firstDifference += 1;
  const start = Math.max(0, firstDifference - Math.floor(textContextLength / 2));
  const summarize = (text: string) => ({
    length: text.length,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    excerpt: text.slice(start, start + textContextLength)
  });
  return { snapshot: summarize(left), current: summarize(right) };
}

function fieldDifference(field: string, snapshot: DiffValue, current: DiffValue): FieldDifference | null {
  if (JSON.stringify(snapshot) === JSON.stringify(current)) return null;
  return { field, snapshot, current };
}

function compactFieldDifferences(values: Array<FieldDifference | null>) {
  return values.filter((value): value is FieldDifference => Boolean(value));
}

function includeContextualDifferences(
  semantic: Array<FieldDifference | null>,
  contextual: Array<FieldDifference | null>,
  hasRelatedSemanticChange = false
) {
  const semanticDifferences = compactFieldDifferences(semantic);
  if (!semanticDifferences.length && !hasRelatedSemanticChange) return [];
  return [...semanticDifferences, ...compactFieldDifferences(contextual)];
}

function longTextFieldDifference(field: string, snapshot: string | null, current: string | null): FieldDifference | null {
  if ((snapshot ?? "") === (current ?? "")) return null;
  const summary = summarizeTextDifference(snapshot, current);
  return { field, snapshot: summary.snapshot, current: summary.current };
}

function pageCoverDescription(manifest: BrainVaultBackup, pageId: string, coverUrl: string | null) {
  const storedCover = (manifest.pageCovers ?? []).find((cover) => cover.pageId === pageId);
  if (storedCover) {
    return [storedCover.path, storedCover.mimeType, storedCover.size, storedCover.sha256, storedCover.crc32].join(":");
  }
  return coverUrl;
}

function attachmentDescription(manifest: BrainVaultBackup, blockId: string) {
  const attachment = manifest.attachments.find((item) => item.blockId === blockId);
  if (!attachment) return null;
  return [attachment.path, attachment.size, attachment.sha256, attachment.crc32].join(":");
}

function pageBlockMap<T extends { id: string; page_id: string }>(blocks: T[]) {
  const byPage = new Map<string, T[]>();
  for (const block of blocks) {
    const items = byPage.get(block.page_id) ?? [];
    items.push(block);
    byPage.set(block.page_id, items);
  }
  return byPage;
}

function tagsForPage(manifest: BrainVaultBackup, pageId: string) {
  const tagById = new Map(manifest.data.tags.map((tag) => [tag.id, tag]));
  return (manifest.data.pageTags ?? [])
    .filter((relation) => relation.page_id === pageId)
    .map((relation) => tagById.get(relation.tag_id))
    .filter((tag): tag is BrainVaultBackup["data"]["tags"][number] => Boolean(tag))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function tagStateForPage(manifest: BrainVaultBackup, pageId: string) {
  return tagsForPage(manifest, pageId).map((tag) => stableJson({
    id: tag.id,
    name: tag.name,
    createdAt: tag.created_at
  }));
}

function tagNamesForPage(manifest: BrainVaultBackup, pageId: string) {
  return tagsForPage(manifest, pageId).map((tag) => tag.name).sort((a, b) => a.localeCompare(b));
}

function sharingStateForPage(manifest: BrainVaultBackup, pageId: string) {
  return (manifest.data.pageShares ?? [])
    .filter((share) => share.page_id === pageId)
    .map((share) => stableJson({
      sharedUserId: share.shared_user_id ?? null,
      username: share.shared_username,
      permission: share.permission,
      createdAt: share.created_at
    }))
    .sort((left, right) => left.localeCompare(right));
}

function sharedUsernamesForPage(manifest: BrainVaultBackup, pageId: string) {
  return sortedUnique((manifest.data.pageShares ?? [])
    .filter((share) => share.page_id === pageId)
    .map((share) => share.shared_username));
}

function pageCommentState(manifest: BrainVaultBackup, pageId: string) {
  return (manifest.data.pageComments ?? [])
    .filter((comment) => comment.page_id === pageId)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
    .map((comment) => ({
      id: comment.id,
      authorUserId: comment.author_user_id,
      authorUsername: comment.author_username,
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at
    }));
}

function pageVersionState(manifest: BrainVaultBackup, pageId: string) {
  return (manifest.data.pageVersions ?? [])
    .filter((version) => version.page_id === pageId)
    .sort((left, right) => left.revision - right.revision)
    .map((version) => ({
      revision: version.revision,
      pageEditVersion: version.page_edit_version,
      pageContentVersion: version.page_content_version,
      actors: version.actors,
      source: version.source,
      changeCount: version.change_count,
      changeSummary: version.change_summary,
      changes: version.changes,
      createdAt: version.created_at
    }));
}

function pageHistoryJson(manifest: BrainVaultBackup, pageId: string) {
  return stableJson(pageVersionState(manifest, pageId));
}

function navigationOrder(manifest: BrainVaultBackup, pageId: string) {
  return (manifest.data.navigationPageOrder ?? []).find((item) => item.page_id === pageId)?.sort_order ?? null;
}

function workspaceDifferences(snapshot: BrainVaultBackup, current: BrainVaultBackup) {
  const differences = [
    fieldDifference("accountName", snapshot.account.name, current.account.name),
    longTextFieldDifference("accountAvatar", snapshot.account.avatar_data, current.account.avatar_data),
    fieldDifference("preferredLanguage", snapshot.account.preferred_language, current.account.preferred_language),
    fieldDifference("defaultCollectionIcon", snapshot.account.default_collection_icon, current.account.default_collection_icon),
    fieldDifference("theme", snapshot.account.theme ?? null, current.account.theme ?? null),
    fieldDifference("sourceUsername", snapshot.source.username, current.source.username),
    fieldDifference("retainedAttachmentCount", snapshot.retainedAttachments?.length ?? 0, current.retainedAttachments?.length ?? 0),
    longTextFieldDifference(
      "retainedAttachments",
      stableJson(stableStringList((snapshot.retainedAttachments ?? []).map((item) => ({
        fileName: item.fileName,
        path: item.path,
        size: item.size,
        sha256: item.sha256,
        crc32: item.crc32
      })))),
      stableJson(stableStringList((current.retainedAttachments ?? []).map((item) => ({
        fileName: item.fileName,
        path: item.path,
        size: item.size,
        sha256: item.sha256,
        crc32: item.crc32
      }))))
    ),
    fieldDifference("customIconCount", snapshot.customIcons?.length ?? 0, current.customIcons?.length ?? 0),
    longTextFieldDifference(
      "customIcons",
      stableJson(stableStringList((snapshot.customIcons ?? []).map((item) => ({
        fileName: item.fileName,
        path: item.path,
        mimeType: item.mimeType,
        size: item.size,
        sha256: item.sha256,
        crc32: item.crc32,
        library: item.library
      })))),
      stableJson(stableStringList((current.customIcons ?? []).map((item) => ({
        fileName: item.fileName,
        path: item.path,
        mimeType: item.mimeType,
        size: item.size,
        sha256: item.sha256,
        crc32: item.crc32,
        library: item.library
      }))))
    ),
    longTextFieldDifference(
      "customIconRemovals",
      stableJson(stableStringList(snapshot.customIconLibraryRemovals ?? [])),
      stableJson(stableStringList(current.customIconLibraryRemovals ?? []))
    )
  ].filter((value): value is FieldDifference => Boolean(value));
  return differences;
}

export function diffWorkspaceManifests(snapshot: BrainVaultBackup, current: BrainVaultBackup) {
  const snapshotPages = new Map(snapshot.data.pages.map((page) => [page.id, page]));
  const currentPages = new Map(current.data.pages.map((page) => [page.id, page]));
  const snapshotBlocks = new Map(snapshot.data.blocks.map((block) => [block.id, block]));
  const currentBlocks = new Map(current.data.blocks.map((block) => [block.id, block]));
  const snapshotBlocksByPage = pageBlockMap(snapshot.data.blocks);
  const currentBlocksByPage = pageBlockMap(current.data.blocks);
  const snapshotCollapsed = new Set(snapshot.data.navigationCollapsedPageIds ?? []);
  const currentCollapsed = new Set(current.data.navigationCollapsedPageIds ?? []);
  const workspace = workspaceDifferences(snapshot, current);

  const pageSummary = { added: 0, removed: 0, modified: 0 };
  const blockSummary = { added: 0, removed: 0, modified: 0 };
  const pageDifferences: PageDifference[] = [];
  let totalBlockDetails = 0;
  let detailsTruncated = false;

  const pageIds = sortedUnique([...snapshotPages.keys(), ...currentPages.keys()]);
  for (const pageId of pageIds) {
    const beforePage = snapshotPages.get(pageId);
    const afterPage = currentPages.get(pageId);
    const beforePageBlocks = snapshotBlocksByPage.get(pageId) ?? [];
    const afterPageBlocks = currentBlocksByPage.get(pageId) ?? [];
    const localBlockSummary = { added: 0, removed: 0, modified: 0 };
    const blockDifferences: BlockDifference[] = [];
    let blockDetailsTruncated = false;

    const blockIds = sortedUnique([
      ...beforePageBlocks.map((block) => block.id),
      ...afterPageBlocks.map((block) => block.id)
    ]);
    for (const blockId of blockIds) {
      const beforeBlock = snapshotBlocks.get(blockId);
      const afterBlock = currentBlocks.get(blockId);
      let difference: BlockDifference | null = null;
      if (!beforeBlock && afterBlock) {
        localBlockSummary.added += 1;
        blockSummary.added += 1;
        difference = { blockId, status: "added", snapshotType: null, currentType: afterBlock.type, fields: [] };
      } else if (beforeBlock && !afterBlock) {
        localBlockSummary.removed += 1;
        blockSummary.removed += 1;
        difference = { blockId, status: "removed", snapshotType: beforeBlock.type, currentType: null, fields: [] };
      } else if (beforeBlock && afterBlock) {
        // html_cache is regenerated from the canonical block payload during a
        // restore, and edit_version is deliberately rebased to the restore
        // generation so stale optimistic writes cannot cross that boundary.
        // Neither value alone means the user's block state changed. Keep them
        // as useful context when a semantic block field changed, but do not let
        // restore-only operational metadata mark every block as modified.
        const fields = includeContextualDifferences([
          fieldDifference("type", beforeBlock.type, afterBlock.type),
          fieldDifference("parentBlockId", beforeBlock.parent_block_id, afterBlock.parent_block_id),
          longTextFieldDifference("markdown", beforeBlock.markdown, afterBlock.markdown),
          fieldDifference("checked", Boolean(beforeBlock.checked), Boolean(afterBlock.checked)),
          fieldDifference("sortOrder", Number(beforeBlock.sort_order), Number(afterBlock.sort_order)),
          longTextFieldDifference("metadata", beforeBlock.metadata, afterBlock.metadata),
          fieldDifference("attachmentFile", attachmentDescription(snapshot, blockId), attachmentDescription(current, blockId)),
          fieldDifference("createdAt", beforeBlock.created_at, afterBlock.created_at),
          fieldDifference("updatedAt", beforeBlock.updated_at, afterBlock.updated_at)
        ], [
          longTextFieldDifference("htmlCache", beforeBlock.html_cache, afterBlock.html_cache),
          fieldDifference("editVersion", beforeBlock.edit_version ?? null, afterBlock.edit_version ?? null)
        ]);
        if (fields.length) {
          localBlockSummary.modified += 1;
          blockSummary.modified += 1;
          difference = {
            blockId,
            status: "modified",
            snapshotType: beforeBlock.type,
            currentType: afterBlock.type,
            fields
          };
        }
      }
      if (difference) {
        if (totalBlockDetails < maxBlockDetails) {
          blockDifferences.push(difference);
          totalBlockDetails += 1;
        } else {
          blockDetailsTruncated = true;
          detailsTruncated = true;
        }
      }
    }

    let pageDifference: PageDifference | null = null;
    if (!beforePage && afterPage) {
      pageSummary.added += 1;
      pageDifference = {
        pageId,
        status: "added",
        snapshotTitle: null,
        currentTitle: afterPage.title,
        fields: [],
        blocks: blockDifferences,
        blockSummary: localBlockSummary,
        blockDetailsTruncated
      };
    } else if (beforePage && !afterPage) {
      pageSummary.removed += 1;
      pageDifference = {
        pageId,
        status: "removed",
        snapshotTitle: beforePage.title,
        currentTitle: null,
        fields: [],
        blocks: blockDifferences,
        blockSummary: localBlockSummary,
        blockDetailsTruncated
      };
    } else if (beforePage && afterPage) {
      const beforeHistory = pageVersionState(snapshot, pageId);
      const afterHistory = pageVersionState(current, pageId);
      const beforeComments = pageCommentState(snapshot, pageId);
      const afterComments = pageCommentState(current, pageId);
      const hasBlockChanges = Boolean(
        localBlockSummary.added || localBlockSummary.removed || localBlockSummary.modified
      );
      // Restore intentionally assigns a fresh common optimistic-concurrency
      // generation to every page's edit/content versions. Treat those tokens as
      // contextual metadata: expose them when the page really changed, but do
      // not let a restore fence by itself turn an otherwise identical page into
      // a user-visible modification.
      const fields = includeContextualDifferences([
        fieldDifference("title", beforePage.title, afterPage.title),
        fieldDifference("icon", beforePage.icon, afterPage.icon),
        fieldDifference("cover", pageCoverDescription(snapshot, pageId, beforePage.cover_url), pageCoverDescription(current, pageId, afterPage.cover_url)),
        fieldDifference("coverPositionX", Number(beforePage.cover_position_x ?? 50), Number(afterPage.cover_position_x ?? 50)),
        fieldDifference("coverPositionY", Number(beforePage.cover_position_y ?? 50), Number(afterPage.cover_position_y ?? 50)),
        fieldDifference("archived", Boolean(beforePage.is_archived), Boolean(afterPage.is_archived)),
        fieldDifference("collection", Boolean(beforePage.is_collection), Boolean(afterPage.is_collection)),
        fieldDifference("parentPageId", beforePage.parent_page_id, afterPage.parent_page_id),
        fieldDifference("tags", tagNamesForPage(snapshot, pageId), tagNamesForPage(current, pageId)),
        longTextFieldDifference("tagState", stableJson(tagStateForPage(snapshot, pageId)), stableJson(tagStateForPage(current, pageId))),
        fieldDifference("sharedWith", sharedUsernamesForPage(snapshot, pageId), sharedUsernamesForPage(current, pageId)),
        longTextFieldDifference("sharingState", stableJson(sharingStateForPage(snapshot, pageId)), stableJson(sharingStateForPage(current, pageId))),
        fieldDifference("commentCount", beforeComments.length, afterComments.length),
        longTextFieldDifference("commentState", stableJson(beforeComments), stableJson(afterComments)),
        fieldDifference("navigationCollapsed", snapshotCollapsed.has(pageId), currentCollapsed.has(pageId)),
        fieldDifference("navigationOrder", navigationOrder(snapshot, pageId), navigationOrder(current, pageId)),
        fieldDifference("historyEntries", beforeHistory.length, afterHistory.length),
        longTextFieldDifference("historyData", pageHistoryJson(snapshot, pageId), pageHistoryJson(current, pageId)),
        fieldDifference("createdAt", beforePage.created_at, afterPage.created_at),
        fieldDifference("updatedAt", beforePage.updated_at, afterPage.updated_at)
      ], [
        fieldDifference("editVersion", beforePage.edit_version ?? null, afterPage.edit_version ?? null),
        fieldDifference("contentVersion", beforePage.content_version ?? null, afterPage.content_version ?? null)
      ], hasBlockChanges);
      if (fields.length || hasBlockChanges) {
        pageSummary.modified += 1;
        pageDifference = {
          pageId,
          status: "modified",
          snapshotTitle: beforePage.title,
          currentTitle: afterPage.title,
          fields,
          blocks: blockDifferences,
          blockSummary: localBlockSummary,
          blockDetailsTruncated
        };
      }
    }

    if (pageDifference) {
      if (pageDifferences.length < maxPageDetails) pageDifferences.push(pageDifference);
      else detailsTruncated = true;
    }
  }

  return {
    identical: pageSummary.added === 0
      && pageSummary.removed === 0
      && pageSummary.modified === 0
      && workspace.length === 0,
    summary: { pages: pageSummary, blocks: blockSummary, workspace: workspace.length },
    workspace,
    pages: pageDifferences,
    detailsTruncated,
    limits: { pageDetails: maxPageDetails, blockDetails: maxBlockDetails }
  };
}
