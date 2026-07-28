import * as Y from "yjs";
import { z } from "zod";
import { blockTypeSchema } from "../utils/schemas.js";
import {
  CollaborationDocumentError,
  validateCollaborationBlockHierarchy
} from "./collaboration-document.js";
import { maxCollaborationDocumentBytes } from "./collaboration-protocol.js";
import {
  createValidatedYjsDocument,
  InvalidYjsUpdateError
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
const collaborationBlockIdSchema = z.string().min(1).max(64);

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

  const metadata = readYjsValue(value.get("metadata"), 0, budget);
  if (metadata !== null && !isDecodedObject(metadata)) {
    return invalidDocument("The collaboration document contains invalid block metadata");
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
  return parsed.data as MaterializedCollaborationBlock;
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
