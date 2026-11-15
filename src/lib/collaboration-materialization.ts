import * as Y from "yjs";
import { z } from "zod";
import { blockTypeSchema, metadataSchema } from "../utils/schemas.js";
import {
  CollaborationDocumentError,
  validateCollaborationBlockHierarchy
} from "./collaboration-document.js";
import { maxCollaborationDocumentBytes } from "./collaboration-protocol.js";
import {
  assertStructuredBlockMetadataIntegrity,
  StructuredMetadataIntegrityError
} from "./structured-metadata-integrity.js";
import {
  assertCanonicalStructuredMetadataModel,
  hasCanonicalStructuredMetadataPolicy,
  normalizeStructuredBlockMetadata,
  StructuredMetadataCanonicalityError
} from "./structured-metadata-canonical.js";
import { createId } from "./id.js";
import { maxBlockHierarchyDepth } from "../utils/hierarchy.js";
import type { BlockType } from "../types/domain.js";
import {
  createValidatedYjsDocument,
  InvalidYjsUpdateError,
  reencodeValidatedYjsCandidate,
  type ValidatedYjsUpdate
} from "./yjs-validation.js";

const maxCollaborationBlocks = 10_000;
const maxCollaborationAttachmentTombstones = 10_000;
const maxYjsValueDepth = 128;
const maxYjsValueNodes = 200_000;

const collaborationTitleSchema = z.string().max(160).refine((value) => value.trim().length > 0, {
  message: "Page title cannot be blank"
});

const collaborationBlockSchema = z.object({
  id: z.string().min(1).max(64),
  type: blockTypeSchema,
  markdown: z.string().max(20_000),
  checked: z.boolean(),
  parentBlockId: z.string().min(1).max(64).nullable(),
  sortOrder: z.number().int().min(0).max(2_147_483_647),
  metadata: z.unknown()
}).strict();

const collaborationBlockKeys = new Set([
  "type",
  "markdown",
  "checked",
  "parentBlockId",
  "sortOrder",
  "metadata"
]);

// These names are valid JSON keys, but allowing them through a later plain
// object clone can trigger prototype setters or ambiguous downstream behavior.
// Collaboration metadata fails closed instead of risking a semantic rewrite.
const unsafeObjectKeys = new Set(["__proto__", "prototype", "constructor"]);
const collaborationBlockIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/).min(1).max(64);

export type MaterializedCollaborationBlock = z.infer<typeof collaborationBlockSchema> & {
  metadata: Record<string, unknown> | null;
};

export type CollaborationMaterialization = {
  title: string;
  blocks: MaterializedCollaborationBlock[];
  deletedAttachmentIds: string[];
};

type DecodeBudget = { nodes: number };

function invalidDocument(message: string): never {
  throw new CollaborationDocumentError("INVALID_COLLABORATION_DOCUMENT", message);
}

function isDecodedObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readYjsValue(value: unknown, depth: number, budget: DecodeBudget): unknown {
  if (depth > maxYjsValueDepth) {
    return invalidDocument("The collaboration document contains values nested too deeply");
  }
  budget.nodes += 1;
  if (budget.nodes > maxYjsValueNodes) {
    return invalidDocument("The collaboration document contains too many nested values");
  }

  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Y.Array) {
    return value.toArray().map((item) => readYjsValue(item, depth + 1, budget));
  }
  if (value instanceof Y.Map) {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of value.entries()) {
      if (unsafeObjectKeys.has(key)) {
        return invalidDocument("The collaboration document contains an unsafe object key");
      }
      Object.defineProperty(result, key, {
        value: readYjsValue(item, depth + 1, budget),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return invalidDocument("The collaboration document contains an unsupported value type");
}

function readBlock(id: string, value: unknown, budget: DecodeBudget): MaterializedCollaborationBlock {
  const parsedId = collaborationBlockIdSchema.safeParse(id);
  if (!parsedId.success || !(value instanceof Y.Map)) {
    return invalidDocument("The collaboration document contains an invalid block entry");
  }
  for (const key of value.keys()) {
    if (!collaborationBlockKeys.has(key)) {
      return invalidDocument("The collaboration document contains an unsupported block field");
    }
  }

  const decodedMetadata = readYjsValue(value.get("metadata"), 0, budget);
  if (decodedMetadata !== null && !isDecodedObject(decodedMetadata)) {
    return invalidDocument("The collaboration document contains invalid block metadata");
  }
  let metadata: Record<string, unknown> | null = null;
  if (decodedMetadata !== null) {
    const envelope = metadataSchema.safeParse(decodedMetadata);
    if (!envelope.success || envelope.data === undefined) {
      return invalidDocument("The collaboration document contains block metadata outside the supported storage envelope");
    }
    metadata = envelope.data;
  }

  const parsed = collaborationBlockSchema.safeParse({
    id: parsedId.data,
    type: readYjsValue(value.get("type"), 0, budget),
    markdown: readYjsValue(value.get("markdown"), 0, budget),
    checked: readYjsValue(value.get("checked"), 0, budget),
    parentBlockId: readYjsValue(value.get("parentBlockId"), 0, budget),
    sortOrder: readYjsValue(value.get("sortOrder"), 0, budget),
    metadata
  });
  if (!parsed.success) {
    return invalidDocument("The collaboration document contains an invalid block");
  }

  try {
    const validatedMetadata = assertStructuredBlockMetadataIntegrity(parsed.data.type, parsed.data.metadata);
    assertCanonicalStructuredMetadataModel(parsed.data.type, validatedMetadata);
    return { ...parsed.data, metadata: validatedMetadata } as MaterializedCollaborationBlock;
  } catch (error) {
    if (
      error instanceof StructuredMetadataIntegrityError
      || error instanceof StructuredMetadataCanonicalityError
    ) {
      return invalidDocument("The collaboration document contains invalid block metadata");
    }
    throw error;
  }
}

export function readCollaborationMaterialization(document: Y.Doc): CollaborationMaterialization {
  try {
    const title = collaborationTitleSchema.safeParse(document.getText("title").toString());
    if (!title.success) {
      return invalidDocument("The collaboration document contains an invalid page title");
    }

    const blocks = document.getMap("blocks");
    const deletedAttachments = document.getMap("deletedAttachments");
    if (blocks.size > maxCollaborationBlocks) {
      return invalidDocument("The collaboration document contains too many blocks");
    }
    if (deletedAttachments.size > maxCollaborationAttachmentTombstones) {
      return invalidDocument("The collaboration document contains too many attachment tombstones");
    }

    const deletedAttachmentIds = [...deletedAttachments.keys()];
    for (const id of deletedAttachmentIds) {
      if (!collaborationBlockIdSchema.safeParse(id).success) {
        return invalidDocument("The collaboration document contains an invalid attachment tombstone");
      }
    }
    deletedAttachmentIds.sort();
    const deletedAttachmentIdSet = new Set(deletedAttachmentIds);

    const budget: DecodeBudget = { nodes: 0 };
    const materializedBlocks: MaterializedCollaborationBlock[] = [];
    for (const [id, value] of blocks.entries()) {
      // Tombstone presence is the protocol's deletion signal. It wins over a
      // concurrently retained map entry, matching the browser's CRDT view.
      if (deletedAttachmentIdSet.has(id)) continue;
      materializedBlocks.push(readBlock(id, value, budget));
    }

    return {
      title: title.data,
      blocks: validateCollaborationBlockHierarchy(materializedBlocks),
      deletedAttachmentIds
    };
  } catch (error) {
    if (error instanceof CollaborationDocumentError) throw error;
    throw new CollaborationDocumentError(
      "INVALID_COLLABORATION_DOCUMENT",
      "The persisted collaboration document cannot be materialized"
    );
  }
}

/**
 * Rebuild the authoritative collaboration document from the ordered durable
 * update log, then decode the only snapshot that may be written to SQL.
 */
export function materializeCollaborationUpdates(
  updates: Iterable<Uint8Array>
): CollaborationMaterialization {
  let document: Y.Doc;
  try {
    document = createValidatedYjsDocument(updates, maxCollaborationDocumentBytes);
  } catch (error) {
    if (error instanceof InvalidYjsUpdateError) {
      throw new CollaborationDocumentError(
        "INVALID_COLLABORATION_DOCUMENT",
        "The persisted collaboration history cannot be reconstructed"
      );
    }
    throw error;
  }

  try {
    return readCollaborationMaterialization(document);
  } finally {
    document.destroy();
  }
}

// ---------------------------------------------------------------------------
// Repair of concurrent merges
//
// Each peer's edit is valid on the document it saw. Merged by the CRDT, two
// such edits can still break a document rule: a row and a column added at
// once leave a short row, the same card moved to two columns appears twice,
// a block moved under a block that a peer deleted loses its parent. Rejecting
// that merge would reject the second peer's update on every reconnect, so
// none of that person's later edits could ever be saved.
//
// The server instead adds a repair to the same update. Repairs keep content:
// duplicate ids are renamed, short rows padded, orphaned or cyclic blocks
// moved to the top level, and text over the block limit continues in a new
// block. Only items over a hard count limit (for example a 51st table row)
// are dropped, because those limits bound server memory.
// ---------------------------------------------------------------------------

const collaborationBlockMarkdownLimit = 20_000;
const collaborationTitleLimit = 160;
const untitledCollaborationTitle = "Untitled";

function createRepairValue(value: unknown): unknown {
  if (typeof value === "string") {
    const text = new Y.Text();
    if (value) text.insert(0, value);
    return text;
  }
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    if (value.length) array.insert(0, value.map(createRepairValue));
    return array;
  }
  if (isDecodedObject(value)) {
    const map = new Y.Map<unknown>();
    for (const [key, item] of Object.entries(value)) map.set(key, createRepairValue(item));
    return map;
  }
  return value === undefined ? null : value;
}

function isCompatibleRepairValue(current: unknown, value: unknown) {
  if (typeof value === "string") return current instanceof Y.Text;
  if (Array.isArray(value)) return current instanceof Y.Array;
  if (isDecodedObject(value)) return current instanceof Y.Map;
  return !(current instanceof Y.Text || current instanceof Y.Array || current instanceof Y.Map);
}

function replaceRepairText(text: Y.Text, value: string) {
  const current = text.toString();
  if (current === value) return;
  let prefix = 0;
  while (prefix < current.length && prefix < value.length && current[prefix] === value[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix
    && suffix < value.length - prefix
    && current[current.length - 1 - suffix] === value[value.length - 1 - suffix]
  ) suffix += 1;
  const deleteLength = current.length - prefix - suffix;
  const insertValue = value.slice(prefix, value.length - suffix);
  if (deleteLength) text.delete(prefix, deleteLength);
  if (insertValue) text.insert(prefix, insertValue);
}

// Same in-place reconciliation as the browser (public/collaboration.js), so a
// repair touches only what it fixes and an in-flight text edit inside an
// unchanged cell still lands.
function reconcileRepairValue(current: unknown, value: unknown, replace: (next: unknown) => void) {
  if (!isCompatibleRepairValue(current, value)) {
    replace(createRepairValue(value));
  } else if (current instanceof Y.Text) {
    replaceRepairText(current, value as string);
  } else if (current instanceof Y.Array) {
    const next = value as unknown[];
    if (current.length > next.length) current.delete(next.length, current.length - next.length);
    for (let index = 0; index < next.length; index += 1) {
      if (index >= current.length) {
        current.insert(index, [createRepairValue(next[index])]);
        continue;
      }
      reconcileRepairValue(current.get(index), next[index], (replacement) => {
        current.delete(index, 1);
        current.insert(index, [replacement]);
      });
    }
  } else if (current instanceof Y.Map) {
    const source = value as Record<string, unknown>;
    for (const key of [...current.keys()]) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) current.delete(key);
    }
    for (const [key, item] of Object.entries(source)) {
      const existing = current.get(key);
      if (existing === undefined) current.set(key, createRepairValue(item));
      else reconcileRepairValue(existing, item, (replacement) => current.set(key, replacement));
    }
  } else if (!Object.is(current, value)) {
    replace(createRepairValue(value));
  }
}

function isValidStructuredMetadata(type: BlockType, metadata: Record<string, unknown> | null) {
  try {
    if (metadata !== null && !metadataSchema.safeParse(metadata).success) return false;
    const validated = assertStructuredBlockMetadataIntegrity(type, metadata);
    assertCanonicalStructuredMetadataModel(type, validated);
    return true;
  } catch (error) {
    if (error instanceof StructuredMetadataIntegrityError || error instanceof StructuredMetadataCanonicalityError) {
      return false;
    }
    throw error;
  }
}

function readRepairString(value: unknown) {
  if (value instanceof Y.Text) return value.toString();
  return typeof value === "string" ? value : null;
}

/** Cut point at or below `limit` that does not split a surrogate pair. */
function textCutIndex(text: string, limit: number) {
  if (text.length <= limit) return text.length;
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

// Values that name or style things rather than hold what someone wrote. A
// repair renames duplicate ids, so counting them would report a loss.
const structuralRepairKeys = new Set(["id", "rowIds", "columnIds", "color", "icon", "type", "kind"]);

function countRepairStrings(value: unknown, key: string, counts: Map<string, number>) {
  if (typeof value === "string") {
    if (value.trim() && !structuralRepairKeys.has(key)) counts.set(value, (counts.get(value) ?? 0) + 1);
    return;
  }
  if (Array.isArray(value)) {
    if (structuralRepairKeys.has(key)) return;
    for (const item of value) countRepairStrings(item, key, counts);
    return;
  }
  if (isDecodedObject(value)) {
    for (const [childKey, item] of Object.entries(value)) countRepairStrings(item, childKey, counts);
  }
}

/**
 * The text a metadata repair drops or shortens: every written string of
 * `before` that `after` no longer holds as many times. A shortened string is
 * reported whole, so nothing of it is lost (its start then appears twice).
 */
export function lostRepairText(before: unknown, after: unknown): string {
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  countRepairStrings(before, "", beforeCounts);
  countRepairStrings(after, "", afterCounts);
  const lost: string[] = [];
  for (const [text, count] of beforeCounts) {
    for (let index = afterCounts.get(text) ?? 0; index < count; index += 1) lost.push(text);
  }
  return lost.join("\n");
}

/** "text": past a block's text limit; "lost": dropped by a metadata repair; "title": past the title limit. */
type OverflowEntry = { sourceId: string | null; kind: "title" | "text" | "lost"; text: string };
type OverflowContinuation = {
  id: string;
  map: Y.Map<unknown>;
  parentBlockId: string | null;
  /** Placed right after this block, or first among its siblings when null. */
  afterId: string | null;
};

function buildOverflowContinuations(
  overflow: OverflowEntry[],
  live: Map<string, Y.Map<unknown>>,
  budget: DecodeBudget
): OverflowContinuation[] {
  const continuations: OverflowContinuation[] = [];
  for (const { sourceId, kind, text } of overflow) {
    const source = sourceId === null ? null : live.get(sourceId) ?? null;
    const parentBlockId = source ? readRepairString(source.get("parentBlockId")) : null;
    // Text past a code or quote block's limit stays code or a quote (as a long
    // paste does); anything else, and text a structured block could not hold,
    // continues as plain text.
    const sourceType = source ? readYjsValue(source.get("type"), 0, budget) : null;
    const type = kind === "text" && (sourceType === "CODE" || sourceType === "QUOTE") ? sourceType : "MARKDOWN";
    const metadata = type === "CODE" ? readYjsValue(source!.get("metadata"), 0, budget) : null;
    let afterId = sourceId;
    let rest = text;
    while (rest.length) {
      const pieceEnd = textCutIndex(rest, collaborationBlockMarkdownLimit);
      const map = new Y.Map<unknown>();
      map.set("type", type);
      map.set("markdown", createRepairValue(rest.slice(0, pieceEnd)));
      map.set("checked", false);
      map.set("parentBlockId", parentBlockId === null ? null : createRepairValue(parentBlockId));
      map.set("sortOrder", 0);
      map.set("metadata", isDecodedObject(metadata) ? createRepairValue(metadata) : null);
      const id = createId("blk");
      continuations.push({ id, map, parentBlockId, afterId });
      afterId = id;
      rest = rest.slice(pieceEnd);
    }
  }
  return continuations;
}

/**
 * Puts each continuation right after the block it continues and renumbers
 * those siblings 0, 1, 2, ... A continuation given its source's sort order + 1
 * could tie with the next sibling and land in a random place.
 */
function placeOverflowContinuations(
  continuations: OverflowContinuation[],
  live: Map<string, Y.Map<unknown>>,
  budget: DecodeBudget
) {
  const parents = new Set(continuations.map((item) => item.parentBlockId));
  for (const parentBlockId of parents) {
    const order = [...live.entries()]
      .filter(([, map]) => readRepairString(map.get("parentBlockId")) === parentBlockId)
      .map(([id, map]) => {
        const sortOrder = Number(readYjsValue(map.get("sortOrder"), 0, budget));
        return { id, map, sortOrder: Number.isSafeInteger(sortOrder) ? sortOrder : 0 };
      })
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
      .map(({ id, map }) => ({ id, map }));
    for (const continuation of continuations) {
      if (continuation.parentBlockId !== parentBlockId) continue;
      const at = continuation.afterId === null
        ? 0
        : order.findIndex((item) => item.id === continuation.afterId) + 1;
      order.splice(at > 0 || continuation.afterId === null ? at : order.length, 0, continuation);
    }
    order.forEach(({ map }, index) => {
      if (Number(readYjsValue(map.get("sortOrder"), 0, budget)) !== index) map.set("sortOrder", index);
    });
  }
}

/**
 * Validates a candidate produced by applyValidatedYjsStateUpdate and, when a
 * concurrent merge broke a document rule, repairs it and re-encodes the
 * update. The returned candidate's incremental update then holds the
 * client's change plus the repair. `allowRepair` is false for the first
 * (bootstrap) write, which must match the saved page exactly.
 */
export function validateCollaborationCandidate(
  candidate: ValidatedYjsUpdate,
  { maxStateBytes, allowRepair }: { maxStateBytes: number; allowRepair: boolean }
): {
  candidate: ValidatedYjsUpdate;
  materialization: CollaborationMaterialization;
  repaired: boolean;
  relocatedBlocks: number;
} {
  try {
    return {
      candidate,
      materialization: readCollaborationMaterialization(candidate.document),
      repaired: false,
      relocatedBlocks: 0
    };
  } catch (error) {
    if (!(error instanceof CollaborationDocumentError) || !allowRepair || !candidate.changed) throw error;
    const report: CollaborationRepairReport = { relocatedBlocks: 0 };
    if (!repairCollaborationDocument(candidate.document, report)) throw error;
    const repaired = reencodeValidatedYjsCandidate(candidate, maxStateBytes);
    return {
      candidate: repaired,
      materialization: readCollaborationMaterialization(repaired.document),
      repaired: true,
      relocatedBlocks: report.relocatedBlocks
    };
  }
}

export type CollaborationRepairReport = {
  /** New blocks that now hold text a limit would otherwise have cut off. */
  relocatedBlocks: number;
};

/**
 * Applies the repairs described above to `document` in one transaction.
 * Returns true when anything changed. Throws CollaborationDocumentError when
 * the document breaks a rule that cannot be repaired without losing content
 * (an unsafe key, too many blocks, unsupported values); the update is then
 * rejected as before.
 */
export function repairCollaborationDocument(document: Y.Doc, report?: CollaborationRepairReport): boolean {
  let changed = false;
  document.transact(() => {
    // Overflow, in order: where it came from (null: the title) and its text.
    const overflow: OverflowEntry[] = [];
    const title = document.getText("title");
    const titleValue = title.toString();
    if (!titleValue.trim()) {
      if (titleValue.length) title.delete(0, titleValue.length);
      title.insert(0, untitledCollaborationTitle);
      changed = true;
    } else if (titleValue.length > collaborationTitleLimit) {
      // Two people typing into a nearly full title: the rest opens the page.
      const cut = textCutIndex(titleValue, collaborationTitleLimit);
      overflow.push({ sourceId: null, kind: "title", text: titleValue.slice(cut) });
      title.delete(cut, titleValue.length - cut);
      changed = true;
    }

    const blocks = document.getMap("blocks");
    const tombstones = new Set(document.getMap("deletedAttachments").keys());
    const live = new Map<string, Y.Map<unknown>>();
    for (const [id, value] of blocks.entries()) {
      if (tombstones.has(id)) continue;
      if (!collaborationBlockIdSchema.safeParse(id).success || !(value instanceof Y.Map)) {
        invalidDocument("The collaboration document contains an invalid block entry");
      }
      live.set(id, value as Y.Map<unknown>);
    }

    const budget: DecodeBudget = { nodes: 0 };
    for (const [id, map] of live) {
      const type = blockTypeSchema.safeParse(readYjsValue(map.get("type"), 0, budget));

      // Text over the block limit (two people typing into a nearly full block)
      // continues in new blocks right after this one instead of being cut.
      const markdown = map.get("markdown");
      if (markdown instanceof Y.Text && markdown.length > collaborationBlockMarkdownLimit) {
        const text = markdown.toString();
        const cut = textCutIndex(text, collaborationBlockMarkdownLimit);
        overflow.push({ sourceId: id, kind: "text", text: text.slice(cut) });
        markdown.delete(cut, text.length - cut);
        changed = true;
      }

      if (!type.success || !hasCanonicalStructuredMetadataPolicy(type.data)) continue;
      const decoded = readYjsValue(map.get("metadata"), 0, budget);
      if (decoded !== null && !isDecodedObject(decoded)) continue;
      const metadata = decoded as Record<string, unknown> | null;
      if (isValidStructuredMetadata(type.data, metadata)) continue;
      const repaired = normalizeStructuredBlockMetadata(type.data, metadata);
      if (!repaired || !isValidStructuredMetadata(type.data, repaired)) continue;
      // The editor's limits (cards per column, rows, text length) can drop or
      // shorten what two merged edits held together. Whatever text the repair
      // would lose goes into a new block right below instead.
      const lost = lostRepairText(metadata, repaired);
      if (lost) overflow.push({ sourceId: id, kind: "lost", text: lost });
      const current = map.get("metadata");
      if (current instanceof Y.Map) {
        reconcileRepairValue(current, repaired, (replacement) => map.set("metadata", replacement));
      } else {
        map.set("metadata", createRepairValue(repaired));
      }
      changed = true;
    }

    const continuations = buildOverflowContinuations(overflow, live, budget);
    if (live.size + continuations.length > maxCollaborationBlocks) {
      invalidDocument("The collaboration document contains too many blocks");
    }
    for (const { id, map } of continuations) {
      blocks.set(id, map);
    }
    if (continuations.length) {
      placeOverflowContinuations(continuations, live, budget);
      for (const { id, map } of continuations) live.set(id, map);
      if (report) report.relocatedBlocks += continuations.length;
    }

    // Hierarchy: a parent a peer deleted, a cycle from two crossing moves, or
    // nesting past the depth limit. The affected block moves to the top level.
    const parents = new Map<string, string | null>();
    for (const [id, map] of live) parents.set(id, readRepairString(map.get("parentBlockId")));
    const detach = (id: string) => {
      parents.set(id, null);
      live.get(id)!.set("parentBlockId", null);
      changed = true;
    };
    for (const [id, parentId] of parents) {
      if (parentId !== null && (parentId === id || !live.has(parentId))) detach(id);
    }
    const depth = new Map<string, number>();
    for (const start of [...parents.keys()].sort()) {
      if (depth.has(start)) continue;
      let path: string[] = [];
      let onPath = new Set<string>();
      let current: string | null = start;
      while (current !== null && !depth.has(current)) {
        if (onPath.has(current)) {
          // Break the cycle at its smallest id so the outcome is deterministic,
          // then walk again from the start on the repaired hierarchy.
          detach([...path.slice(path.indexOf(current))].sort()[0]);
          path = [];
          onPath = new Set<string>();
          current = start;
          continue;
        }
        onPath.add(current);
        path.push(current);
        current = parents.get(current) ?? null;
      }
      let nextDepth = current === null ? 0 : depth.get(current)! + 1;
      for (let index = path.length - 1; index >= 0; index -= 1) {
        const id = path[index];
        if (nextDepth >= maxBlockHierarchyDepth) {
          detach(id);
          nextDepth = 0;
        }
        depth.set(id, nextDepth);
        nextDepth += 1;
      }
    }
  });
  return changed;
}
