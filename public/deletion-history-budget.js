// @ts-check

/**
 * Whether version history can keep everything a block deletion removes.
 *
 * Deleting a block records one history entry holding the deleted blocks, so
 * Restore can bring them back. The server bounds that entry
 * (boundPageVersionChanges in src/lib/page-version-history.ts): a deleted
 * block's structured content over 128 KB is left out, and when the whole entry
 * passes 256 KB the content of later blocks, and then whole blocks, are left
 * out. Asking only about the block itself missed a toggle or heading whose
 * nested blocks together pass that limit, so they were deleted with the plain
 * prompt and could not be brought back.
 */

/** Mirrors pageVersionDeletedMetadataInlineMaxBytes. */
export const deletedBlockHistoryMetadataMaxBytes = 128 * 1024;
/** Mirrors pageVersionWriteMaxBytes. */
export const deletionHistoryEntryMaxBytes = 256 * 1024;
// Room for the rest of the entry (a sibling renumbered by the deletion, the
// marker the server adds). Erring towards the warning is the safe side.
const deletionHistorySafetyMarginBytes = 8 * 1024;

const encoder = new TextEncoder();

function utf8Bytes(text) {
  return encoder.encode(text).length;
}

/** The block and every block nested under it (`children` arrays), root first. */
export function collectBlockSubtree(root) {
  const blocks = [];
  const pending = root ? [root] : [];
  const seen = new Set();
  while (pending.length) {
    const block = pending.shift();
    if (!block || seen.has(block)) continue;
    seen.add(block);
    blocks.push(block);
    if (Array.isArray(block.children)) pending.push(...block.children);
  }
  return blocks;
}

/**
 * True when deleting these blocks would leave part of them out of version
 * history, so they could not be restored after the deletion.
 */
export function isDeletionTooLargeForHistory(blocks) {
  let total = 2;
  for (const block of blocks) {
    let metadataJson;
    try {
      metadataJson = block?.metadata ? JSON.stringify(block.metadata) : "null";
    } catch {
      return true;
    }
    const metadataBytes = utf8Bytes(metadataJson);
    if (block?.metadata && metadataBytes > deletedBlockHistoryMetadataMaxBytes) return true;
    // The entry holds what toPageVersionBlockState records for the block.
    const state = JSON.stringify({
      kind: "block-deleted",
      block: {
        id: String(block?.id ?? ""),
        parentBlockId: block?.parentBlockId ?? null,
        type: String(block?.type ?? "MARKDOWN"),
        markdown: String(block?.markdown ?? ""),
        checked: Boolean(block?.checked),
        sortOrder: Number(block?.sortOrder ?? 0),
        metadata: null
      }
    });
    total += utf8Bytes(state) - 4 + metadataBytes + 1;
    if (total > deletionHistoryEntryMaxBytes - deletionHistorySafetyMarginBytes) return true;
  }
  return false;
}
