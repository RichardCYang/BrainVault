import { isDeepStrictEqual } from "node:util";
import type { BlockType } from "../types/domain.js";
import { getAccordionData } from "./accordion.js";
import { getAiChatData } from "./ai-chat.js";
import { getBookmarkData } from "./bookmark.js";
import { getDatabaseData } from "./database.js";
import { getGanttData } from "./gantt.js";
import { getKanbanData } from "./kanban.js";
import { getTableData } from "./table.js";
import { getTimetableData } from "./timetable.js";
import { getTreeViewData } from "./treeview.js";

type StructuredMetadataPolicy = {
  metadataKey: string;
  normalize: (metadata: unknown) => unknown;
};

const structuredMetadataPolicies = new Map<BlockType, StructuredMetadataPolicy>([
  ["TABLE", { metadataKey: "table", normalize: getTableData }],
  ["KANBAN", { metadataKey: "kanban", normalize: getKanbanData }],
  ["DATABASE", { metadataKey: "database", normalize: getDatabaseData }],
  ["TREEVIEW", { metadataKey: "treeView", normalize: getTreeViewData }],
  ["ACCORDION", { metadataKey: "accordion", normalize: getAccordionData }],
  ["TIMETABLE", { metadataKey: "timetable", normalize: getTimetableData }],
  ["GANTT", { metadataKey: "gantt", normalize: getGanttData }],
  ["BOOKMARK", { metadataKey: "bookmark", normalize: getBookmarkData }],
  ["AI_CHAT", { metadataKey: "aiChat", normalize: getAiChatData }]
]);

export class StructuredMetadataCanonicalityError extends Error {
  readonly blockType: BlockType;
  readonly metadataKey: string;

  constructor(blockType: BlockType, metadataKey: string) {
    super(`${blockType} metadata must contain a complete canonical ${metadataKey} model`);
    this.name = "StructuredMetadataCanonicalityError";
    this.blockType = blockType;
    this.metadataKey = metadataKey;
  }
}

export function hasCanonicalStructuredMetadataPolicy(type: BlockType) {
  return structuredMetadataPolicies.has(type);
}

function normalizeComparableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeComparableJsonValue);
  if (value && typeof value === "object") {
    // Null-prototype records make comparison independent of object provenance
    // without invoking legacy setters for keys such as __proto__.
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeComparableJsonValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/**
 * Require the complete editor model for metadata-backed block types.
 *
 * Callers must run assertStructuredBlockMetadataIntegrity first. This second
 * boundary rejects partial-but-well-typed models that an editor normalizer
 * would silently fill with defaults before relational materialization.
 */
export function assertCanonicalStructuredMetadataModel(type: BlockType, metadata: unknown) {
  const policy = structuredMetadataPolicies.get(type);
  if (!policy) return;

  if (
    !metadata
    || typeof metadata !== "object"
    || Array.isArray(metadata)
    || !Object.prototype.hasOwnProperty.call(metadata, policy.metadataKey)
  ) {
    throw new StructuredMetadataCanonicalityError(type, policy.metadataKey);
  }

  const requestedModel = (metadata as Record<string, unknown>)[policy.metadataKey];
  if (
    !requestedModel
    || typeof requestedModel !== "object"
    || Array.isArray(requestedModel)
    || !isDeepStrictEqual(
      normalizeComparableJsonValue(requestedModel),
      normalizeComparableJsonValue(policy.normalize(metadata))
    )
  ) {
    throw new StructuredMetadataCanonicalityError(type, policy.metadataKey);
  }
}
