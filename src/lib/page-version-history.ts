import { z } from "zod";
import { createHash } from "node:crypto";
import { measureJsonUtf8BytesWithinLimit } from "./data-transfer-limits.js";
import { failFastArray } from "./validation-errors.js";
import type { DbClient } from "./db.js";
import { describePageCoverUrlForHistory } from "./page-cover.js";
import type { BlockRow, PageRow, UserRow } from "../types/domain.js";
import { validateStoredBlockMetadata } from "./structured-metadata-integrity.js";
import { blockTypeSchema } from "../utils/schemas.js";

export type PageVersionActor = {
  id: string;
  username: string;
  name: string | null;
};

export type PageVersionFieldChange = {
  field: string;
  before: unknown;
  after: unknown;
  /** Characters removed by the saves grouped into this entry so far (see coalescing). */
  removedInGroup?: number;
};

export type PageVersionBlockState = {
  id: string;
  parentBlockId: string | null;
  type: BlockRow["type"];
  markdown: string;
  checked: boolean;
  sortOrder: number;
  metadata: Record<string, unknown> | null;
  metadataOmitted?: { bytes: number; sha256: string };
};

export type PageVersionPageState = {
  title: string;
  icon: string | null;
  coverUrl: string | null;
  coverPositionX: number;
  coverPositionY: number;
  isArchived: boolean;
  isCollection: boolean;
  parentPageId: string | null;
  tags: string[];
};

export type PageVersionChange =
  | { kind: "history-started"; page: Omit<PageVersionPageState, "tags"> }
  | { kind: "page-created"; page: PageVersionPageState }
  | { kind: "page-updated"; fields: PageVersionFieldChange[] }
  | { kind: "block-created"; block: PageVersionBlockState }
  | { kind: "block-updated"; blockId: string; blockType: BlockRow["type"]; fields: PageVersionFieldChange[] }
  | { kind: "block-deleted"; block: PageVersionBlockState }
  | { kind: "details-omitted"; reason: "DETAIL_LIMIT" | "LEGACY_INVALID" };

export type PageVersionSummary = {
  baseline: number;
  pageCreated: number;
  pageFields: string[];
  blocksCreated: number;
  blocksUpdated: number;
  blocksDeleted: number;
  blocksMoved: number;
};

const pageVersionHistoryMaxDepth = 16;
const pageVersionHistoryMaxNodes = 100_000;
const pageVersionHistoryMaxSerializedBytes = 4 * 1024 * 1024;
export const pageVersionWriteMaxBytes = 256 * 1024;
export const pageVersionValueInlineMaxBytes = 16 * 1024;
export const pageVersionMaxRowsPerPage = 1_000;
export const pageVersionMaxBytesPerPage = 16 * 1024 * 1024;
// Row retention does not restart the public revision counter. Permit long-lived
// histories while reserving ample safe-integer headroom after an import.
export const maxRestoredPageVersionRevision = 0xffffffff;
const forbiddenPageVersionHistoryKeys = new Set(["__proto__", "constructor", "prototype"]);
const historyIdSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const historyNullableIdSchema = historyIdSchema.nullable();
const pageVersionActorSchema = z.object({
  id: z.string().min(1).max(64),
  username: z.string().min(1).max(50),
  name: z.string().max(80).nullable()
}).strict();
const pageVersionActorsSchema = failFastArray(pageVersionActorSchema, pageVersionHistoryMaxNodes);
const pageVersionSummarySchema = z.object({
  baseline: z.number().int().min(0).max(0xffffffff),
  pageCreated: z.number().int().min(0).max(0xffffffff),
  pageFields: failFastArray(z.string().min(1).max(64), 64),
  blocksCreated: z.number().int().min(0).max(0xffffffff),
  blocksUpdated: z.number().int().min(0).max(0xffffffff),
  blocksDeleted: z.number().int().min(0).max(0xffffffff),
  blocksMoved: z.number().int().min(0).max(0xffffffff)
}).strict();
const pageVersionFieldChangeSchema = z.object({
  field: z.string().min(1).max(64),
  before: z.unknown(),
  after: z.unknown(),
  removedInGroup: z.number().int().nonnegative().max(1_000_000_000).optional()
}).strict();
const omittedHistoryValueSchema = z.object({
  $pageVersionOmitted: z.literal(true),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export function isPageVersionOmittedValue(value: unknown) {
  return omittedHistoryValueSchema.safeParse(value).success;
}
const pageVersionPageStateSchema = z.object({
  title: z.string().max(160),
  icon: z.string().max(1024 * 1024).nullable(),
  coverUrl: z.string().max(4096).nullable(),
  coverPositionX: z.number().int().min(0).max(100),
  coverPositionY: z.number().int().min(0).max(100),
  isArchived: z.boolean(),
  isCollection: z.boolean(),
  parentPageId: historyNullableIdSchema,
  tags: failFastArray(z.string().max(50), 20)
}).strict();
const pageVersionBlockStateSchema = z.object({
  id: historyIdSchema,
  parentBlockId: historyNullableIdSchema,
  type: blockTypeSchema,
  markdown: z.string().max(20_000),
  checked: z.boolean(),
  sortOrder: z.number().int(),
  metadata: z.unknown().nullable(),
  metadataOmitted: z.object({ bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional()
}).strict();
const pageVersionChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("details-omitted"),
    reason: z.enum(["DETAIL_LIMIT", "LEGACY_INVALID"])
  }).strict(),
  z.object({
    kind: z.literal("history-started"),
    page: pageVersionPageStateSchema.omit({ tags: true })
  }).strict(),
  z.object({
    kind: z.literal("page-created"),
    page: pageVersionPageStateSchema
  }).strict(),
  z.object({
    kind: z.literal("page-updated"),
    fields: failFastArray(pageVersionFieldChangeSchema, pageVersionHistoryMaxNodes)
  }).strict(),
  z.object({
    kind: z.literal("block-created"),
    block: pageVersionBlockStateSchema
  }).strict(),
  z.object({
    kind: z.literal("block-updated"),
    blockId: historyIdSchema,
    blockType: blockTypeSchema,
    fields: failFastArray(pageVersionFieldChangeSchema, pageVersionHistoryMaxNodes)
  }).strict(),
  z.object({
    kind: z.literal("block-deleted"),
    block: pageVersionBlockStateSchema
  }).strict()
]);
const pageVersionChangesSchema = failFastArray(pageVersionChangeSchema, pageVersionHistoryMaxNodes);

export class PageVersionHistoryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageVersionHistoryIntegrityError";
  }
}

function inspectPageVersionHistoryJson(
  value: unknown,
  label: string,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 }
): void {
  if (depth > pageVersionHistoryMaxDepth) {
    throw new PageVersionHistoryIntegrityError(`${label} exceeds the maximum nesting depth`);
  }
  budget.nodes += 1;
  if (budget.nodes > pageVersionHistoryMaxNodes) {
    throw new PageVersionHistoryIntegrityError(`${label} exceeds the maximum node count`);
  }

  if (value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) inspectPageVersionHistoryJson(item, label, depth + 1, budget);
    return;
  }

  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return;
  if (valueType === "number") {
    if (!Number.isFinite(value)) throw new PageVersionHistoryIntegrityError(`${label} contains a non-finite number`);
    return;
  }
  if (valueType !== "object") {
    throw new PageVersionHistoryIntegrityError(`${label} contains a non-JSON value`);
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenPageVersionHistoryKeys.has(key)) {
      throw new PageVersionHistoryIntegrityError(`${label} contains the forbidden key '${key}'`);
    }
    inspectPageVersionHistoryJson(child, label, depth + 1, budget);
  }
}

function decodePageVersionHistoryJson(value: unknown, label: string) {
  let decoded = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > pageVersionHistoryMaxSerializedBytes) {
      throw new PageVersionHistoryIntegrityError(`${label} exceeds the serialized byte limit`);
    }
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      throw new PageVersionHistoryIntegrityError(`${label} is not valid JSON`);
    }
  }

  inspectPageVersionHistoryJson(decoded, label);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(decoded);
  } catch {
    throw new PageVersionHistoryIntegrityError(`${label} is not JSON serializable`);
  }
  if (serialized === undefined) {
    throw new PageVersionHistoryIntegrityError(`${label} is not JSON serializable`);
  }
  if (Buffer.byteLength(serialized, "utf8") > pageVersionHistoryMaxSerializedBytes) {
    throw new PageVersionHistoryIntegrityError(`${label} exceeds the serialized byte limit`);
  }
  return decoded;
}

function parseWithSchema<T>(value: unknown, label: string, schema: z.ZodTypeAny): T {
  const decoded = decodePageVersionHistoryJson(value, label);
  try {
    return schema.parse(decoded) as T;
  } catch {
    throw new PageVersionHistoryIntegrityError(`${label} does not match the page-version history schema`);
  }
}

function normalizePageVersionBlockState(block: z.infer<typeof pageVersionBlockStateSchema>): PageVersionBlockState {
  if (block.metadataOmitted && block.metadata !== null) {
    throw new PageVersionHistoryIntegrityError("Omitted page version metadata must be null");
  }
  const metadata = validateStoredBlockMetadata(block.type, block.metadata);
  if (block.metadata !== null && metadata === null) {
    throw new PageVersionHistoryIntegrityError("Page version block metadata is invalid");
  }
  return { ...block, metadata };
}

export function parsePageVersionActorsJson(value: string | PageVersionActor[]) {
  return parseWithSchema<PageVersionActor[]>(value, "Page version actors", pageVersionActorsSchema);
}

export function parsePageVersionSummaryJson(value: string | PageVersionSummary) {
  return parseWithSchema<PageVersionSummary>(value, "Page version summary", pageVersionSummarySchema);
}

export function parsePageVersionChangesJson(value: string | PageVersionChange[]) {
  const changes = parseWithSchema<z.infer<typeof pageVersionChangesSchema>>(
    value,
    "Page version changes",
    pageVersionChangesSchema
  );
  return changes.map((change): PageVersionChange => {
    if (change.kind === "block-created" || change.kind === "block-deleted") {
      return { ...change, block: normalizePageVersionBlockState(change.block) };
    }
    return change as PageVersionChange;
  });
}

type PublicUserLike = Pick<UserRow, "id" | "username" | "name">;

type PageVersionRow = {
  id: number | bigint;
  page_id: string;
  revision: number | bigint;
  page_edit_version: number | bigint;
  page_content_version: number | bigint;
  actors: string | PageVersionActor[];
  source: string;
  change_count: number;
  change_summary: string | PageVersionSummary;
  changes?: string | PageVersionChange[];
  created_at: string;
};

function parseStoredHistory<T>(parser: (value: string | T) => T, value: string | T, fallback: T): T {
  try {
    return parser(value);
  } catch {
    return fallback;
  }
}

function isEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pushFieldChange(
  fields: PageVersionFieldChange[],
  field: string,
  before: unknown,
  after: unknown
) {
  if (!isEqual(before, after)) fields.push({ field, before, after });
}

export function toPageVersionActor(user: PublicUserLike): PageVersionActor {
  return { id: user.id, username: user.username, name: user.name ?? null };
}

export async function loadPageVersionActors(client: DbClient, userIds: string[]) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (!uniqueIds.length) return [] as PageVersionActor[];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = await client.query<Pick<UserRow, "id" | "username" | "name">>(
    `SELECT id, username, name FROM users WHERE id IN (${placeholders})`,
    uniqueIds
  );
  const byId = new Map(rows.map((row) => [row.id, toPageVersionActor(row)]));
  return uniqueIds.map((id) => byId.get(id) ?? { id, username: id, name: null });
}

export function toPageVersionPageState(page: PageRow, tags: string[] = []): PageVersionPageState {
  return {
    title: page.title,
    icon: page.icon,
    coverUrl: describePageCoverUrlForHistory(page.cover_url),
    coverPositionX: Math.min(100, Math.max(0, Number(page.cover_position_x ?? 50))),
    coverPositionY: Math.min(100, Math.max(0, Number(page.cover_position_y ?? 50))),
    isArchived: Boolean(page.is_archived),
    isCollection: Boolean(page.is_collection),
    parentPageId: page.parent_page_id,
    tags: [...tags].sort((left, right) => left.localeCompare(right))
  };
}

export function toPageVersionBlockState(block: BlockRow): PageVersionBlockState {
  return {
    id: block.id,
    parentBlockId: block.parent_block_id,
    type: block.type,
    markdown: block.markdown,
    checked: Boolean(block.checked),
    sortOrder: Number(block.sort_order),
    metadata: validateStoredBlockMetadata(block.type, block.metadata)
  };
}

export function diffPageVersionPage(
  before: PageRow | null,
  after: PageRow,
  beforeTags: string[] = [],
  afterTags: string[] = []
): PageVersionChange[] {
  const afterState = toPageVersionPageState(after, afterTags);
  if (!before) return [{ kind: "page-created", page: afterState }];

  const beforeState = toPageVersionPageState(before, beforeTags);
  const fields: PageVersionFieldChange[] = [];
  pushFieldChange(fields, "title", beforeState.title, afterState.title);
  pushFieldChange(fields, "icon", beforeState.icon, afterState.icon);
  pushFieldChange(fields, "coverUrl", beforeState.coverUrl, afterState.coverUrl);
  pushFieldChange(fields, "coverPositionX", beforeState.coverPositionX, afterState.coverPositionX);
  pushFieldChange(fields, "coverPositionY", beforeState.coverPositionY, afterState.coverPositionY);
  pushFieldChange(fields, "isArchived", beforeState.isArchived, afterState.isArchived);
  pushFieldChange(fields, "isCollection", beforeState.isCollection, afterState.isCollection);
  pushFieldChange(fields, "parentPageId", beforeState.parentPageId, afterState.parentPageId);
  pushFieldChange(fields, "tags", beforeState.tags, afterState.tags);
  return fields.length ? [{ kind: "page-updated", fields }] : [];
}

export function diffPageVersionBlocks(beforeRows: BlockRow[], afterRows: BlockRow[]): PageVersionChange[] {
  const beforeById = new Map(beforeRows.map((row) => [row.id, row]));
  const afterById = new Map(afterRows.map((row) => [row.id, row]));
  const changes: PageVersionChange[] = [];

  for (const beforeRow of beforeRows) {
    const afterRow = afterById.get(beforeRow.id);
    if (!afterRow) {
      changes.push({ kind: "block-deleted", block: toPageVersionBlockState(beforeRow) });
      continue;
    }

    const before = toPageVersionBlockState(beforeRow);
    const after = toPageVersionBlockState(afterRow);
    const fields: PageVersionFieldChange[] = [];
    pushFieldChange(fields, "parentBlockId", before.parentBlockId, after.parentBlockId);
    pushFieldChange(fields, "type", before.type, after.type);
    pushFieldChange(fields, "markdown", before.markdown, after.markdown);
    pushFieldChange(fields, "checked", before.checked, after.checked);
    pushFieldChange(fields, "sortOrder", before.sortOrder, after.sortOrder);
    pushFieldChange(fields, "metadata", before.metadata, after.metadata);
    if (fields.length) {
      changes.push({ kind: "block-updated", blockId: before.id, blockType: after.type, fields });
    }
  }

  for (const afterRow of afterRows) {
    if (!beforeById.has(afterRow.id)) {
      changes.push({ kind: "block-created", block: toPageVersionBlockState(afterRow) });
    }
  }

  return changes;
}

function summarizePageVersionChanges(changes: PageVersionChange[]): PageVersionSummary {
  const summary: PageVersionSummary = {
    baseline: 0,
    pageCreated: 0,
    pageFields: [],
    blocksCreated: 0,
    blocksUpdated: 0,
    blocksDeleted: 0,
    blocksMoved: 0
  };
  const pageFields = new Set<string>();

  for (const change of changes) {
    if (change.kind === "history-started") summary.baseline += 1;
    if (change.kind === "page-created") summary.pageCreated += 1;
    if (change.kind === "page-updated") {
      for (const field of change.fields) pageFields.add(field.field);
    }
    if (change.kind === "block-created") summary.blocksCreated += 1;
    if (change.kind === "block-deleted") summary.blocksDeleted += 1;
    if (change.kind === "block-updated") {
      summary.blocksUpdated += 1;
      if (change.fields.some((field) => field.field === "sortOrder" || field.field === "parentBlockId")) {
        summary.blocksMoved += 1;
      }
    }
  }
  summary.pageFields = [...pageFields];
  return summary;
}

function countPageVersionChanges(changes: PageVersionChange[]) {
  return changes.reduce((count, change) => {
    if (change.kind === "page-updated" || change.kind === "block-updated") {
      return count + Math.max(1, change.fields.length);
    }
    return count + 1;
  }, 0);
}

function describeOmittedHistoryValue(value: unknown) {
  const serialized = JSON.stringify(value) ?? "null";
  return {
    bytes: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex")
  };
}

// A deleted block exists nowhere else once it is gone, and history is where a
// person can bring it back from. Keep more of its structured content inline.
export const pageVersionDeletedMetadataInlineMaxBytes = 128 * 1024;
// The same reasoning applies to the value an edit replaced. 128 KB holds the
// longest block text (20,000 characters, JSON-escaped) with room to spare.
export const pageVersionPreviousValueInlineMaxBytes = 128 * 1024;
// Field values at most this size stay readable even when a row is reduced.
const pageVersionReducedValueInlineMaxBytes = 256;

type PageVersionBlockStateChange = Extract<PageVersionChange, { kind: "block-created" | "block-deleted" }>;

function omitBlockStateMetadata(change: PageVersionBlockStateChange): PageVersionBlockStateChange {
  if (change.block.metadata === null || change.block.metadata === undefined) return change;
  const block: PageVersionBlockState = {
    ...change.block, metadata: null, metadataOmitted: describeOmittedHistoryValue(change.block.metadata)
  };
  return { kind: change.kind, block };
}

function boundHistoryFieldValue(value: unknown, limit: number) {
  if (isPageVersionOmittedValue(value)) return value;
  if (measureJsonUtf8BytesWithinLimit(value, limit) !== null) return value;
  return { $pageVersionOmitted: true, ...describeOmittedHistoryValue(value) };
}

function boundHistoryChange(change: PageVersionChange, reduced: boolean): PageVersionChange {
  if (change.kind === "block-created" || change.kind === "block-deleted") {
    if (reduced) return omitBlockStateMetadata(change);
    const limit = change.kind === "block-deleted"
      ? pageVersionDeletedMetadataInlineMaxBytes
      : pageVersionValueInlineMaxBytes;
    return measureJsonUtf8BytesWithinLimit(change.block.metadata, limit) !== null
      ? change
      : omitBlockStateMetadata(change);
  }
  if (change.kind === "page-updated" || change.kind === "block-updated") {
    const limit = reduced ? pageVersionReducedValueInlineMaxBytes : pageVersionValueInlineMaxBytes;
    // A block's previous content is the only copy of what an edit replaced:
    // the "after" value is still in the block or in the next entry's "before".
    // Keep the whole previous text of even a full-length block.
    const beforeLimit = !reduced && change.kind === "block-updated"
      ? pageVersionPreviousValueInlineMaxBytes
      : limit;
    return { ...change, fields: change.fields.map((field) => ({
      ...field,
      before: boundHistoryFieldValue(field.before, beforeLimit),
      after: boundHistoryFieldValue(field.after, limit)
    })) };
  }
  return change;
}

function measureHistoryChange(change: PageVersionChange) {
  return measureJsonUtf8BytesWithinLimit(change, pageVersionWriteMaxBytes) ?? Number.POSITIVE_INFINITY;
}

// History is an audit log, not the canonical block store. Explicitly describe
// omitted values without rejecting a valid edit or silently showing it as null.
//
// When one mutation is too large for a history row (deleting a long subtree,
// for example), keep as much as fits instead of dropping every detail: deleted
// blocks come first, each change shrinks to a summary before it is left out,
// and a DETAIL_LIMIT marker says that something was left out.
export function boundPageVersionChanges(changes: PageVersionChange[]): PageVersionChange[] {
  const marker: PageVersionChange = { kind: "details-omitted", reason: "DETAIL_LIMIT" };
  const omitted: PageVersionChange[] = [marker];
  try {
    const full = changes.map((change) => boundHistoryChange(change, false));
    if (measureJsonUtf8BytesWithinLimit(full, pageVersionWriteMaxBytes) !== null) {
      // Use the same schema/depth/node validation as reads and backup restore.
      return parsePageVersionChangesJson(full);
    }

    const reduced = changes.map((change) => boundHistoryChange(change, true));
    const fullSizes = full.map(measureHistoryChange);
    const reducedSizes = reduced.map(measureHistoryChange);
    // Two array brackets, the marker, and one separator per kept element.
    let remaining = pageVersionWriteMaxBytes - 2 - (measureJsonUtf8BytesWithinLimit(marker, 1024) ?? 64) - 1;
    const order = changes
      .map((change, index) => ({ index, deleted: change.kind === "block-deleted" }))
      .sort((left, right) => Number(right.deleted) - Number(left.deleted) || left.index - right.index)
      .map(({ index }) => index);
    const chosen: Array<PageVersionChange | null> = changes.map(() => null);
    for (const index of order) {
      const cost = reducedSizes[index] + 1;
      if (cost > remaining) continue;
      chosen[index] = reduced[index];
      remaining -= cost;
    }
    for (const index of order) {
      if (chosen[index] === null) continue;
      const extra = fullSizes[index] - reducedSizes[index];
      if (extra <= 0 || extra > remaining) continue;
      chosen[index] = full[index];
      remaining -= extra;
    }

    const kept = chosen.filter((change): change is PageVersionChange => change !== null);
    const bounded = kept.length < changes.length ? [...kept, marker] : kept;
    if (measureJsonUtf8BytesWithinLimit(bounded, pageVersionWriteMaxBytes) === null) return omitted;
    return parsePageVersionChangesJson(bounded);
  } catch (error) {
    if (error instanceof PageVersionHistoryIntegrityError || error instanceof RangeError) return omitted;
    throw error;
  }
}

export function pageVersionChangesForBackup(value: string) {
  try {
    parsePageVersionChangesJson(value);
    return value;
  } catch (error) {
    if (!(error instanceof PageVersionHistoryIntegrityError)) throw error;
    // Keep the revision/actors/summary and make the missing legacy detail
    // explicit. A historical bad row must not prevent restoring current notes.
    return JSON.stringify([{ kind: "details-omitted", reason: "LEGACY_INVALID" }]);
  }
}

// An entry that deleted a block holds the only copy of that block. Leaving the
// 1,000-revision window does not remove it: the newest of these are kept on
// top of the window, so Restore stays available long after the deletion.
export const pageVersionMaxRetainedDeletionRowsPerPage = 200;
/** Byte share of pageVersionMaxBytesPerPage kept for block deletion entries. */
export const pageVersionMaxDeletionBytesPerPage = 4 * 1024 * 1024;
const pageVersionDeletionRowSql =
  "COALESCE(CAST(JSON_VALUE(change_summary, '$.blocksDeleted') AS UNSIGNED), 0) > 0";

export async function prunePageVersionHistory(client: DbClient, pageId: string, revision: number) {
  const windowCutoff = revision - pageVersionMaxRowsPerPage;
  if (windowCutoff > 0) {
    await client.execute(
      `DELETE FROM page_versions WHERE page_id = ? AND revision <= ? AND NOT (${pageVersionDeletionRowSql})`,
      [pageId, windowCutoff]
    );
    // Only deletion entries remain below the window now; keep the newest ones.
    const oldestRetained = await client.queryOne<{ revision: number | bigint | null }>(
      `SELECT revision FROM page_versions WHERE page_id = ? AND revision <= ?
       ORDER BY revision DESC LIMIT 1 OFFSET ?`,
      [pageId, windowCutoff, pageVersionMaxRetainedDeletionRowsPerPage - 1]
    );
    if (oldestRetained?.revision !== null && oldestRetained?.revision !== undefined) {
      await client.execute("DELETE FROM page_versions WHERE page_id = ? AND revision < ?", [
        pageId, Number(oldestRetained.revision)
      ]);
    }
  }
  // The revision prune bounds these scans to 1,200 rows, including legacy
  // history. The byte budgets stay a hard limit: deletion entries and other
  // entries each have their own share of pageVersionMaxBytesPerPage, so a
  // busy page full of large edits cannot push out the only copy of a deleted
  // block (it used to, after a few hundred saves of long blocks).
  // Compute sizes in SQL so historical JSON never crosses the DB connection.
  await pruneVersionHistoryBytes(client, pageId, true, pageVersionMaxDeletionBytesPerPage);
  await pruneVersionHistoryBytes(
    client,
    pageId,
    false,
    pageVersionMaxBytesPerPage - pageVersionMaxDeletionBytesPerPage
  );
}

async function pruneVersionHistoryBytes(client: DbClient, pageId: string, deletions: boolean, maxBytes: number) {
  const kind = deletions ? pageVersionDeletionRowSql : `NOT (${pageVersionDeletionRowSql})`;
  const expired = await client.queryOne<{ cutoff_revision: number | bigint | null }>(
    `SELECT MAX(retained_versions.revision) AS cutoff_revision FROM (
       SELECT revision,
              SUM(OCTET_LENGTH(actors) + OCTET_LENGTH(change_summary) + OCTET_LENGTH(changes))
                OVER (ORDER BY revision DESC ROWS UNBOUNDED PRECEDING) AS total_bytes
       FROM page_versions WHERE page_id = ? AND ${kind}
     ) retained_versions WHERE retained_versions.total_bytes > ?`,
    [pageId, maxBytes]
  );
  if (expired?.cutoff_revision !== null && expired?.cutoff_revision !== undefined) {
    await client.execute(`DELETE FROM page_versions WHERE page_id = ? AND revision <= ? AND ${kind}`, [
      pageId, Number(expired.cutoff_revision)
    ]);
  }
}

// Autosave writes after every pause in typing. Without grouping, an afternoon
// of typing fills the 1,000-entry window and pushes everything older (deleted
// blocks included) out of history. Successive saves of one block by the same
// people within this window share one entry instead.
export const pageVersionCoalesceWindowSeconds = 10 * 60;
// An edit that removes more than this many characters always starts a new
// entry. Grouping keeps only the first "before", so text typed and then
// replaced or cleared inside the window would otherwise vanish from history.
export const pageVersionCoalesceMaxRemovedCharacters = 64;
const pageVersionCoalescibleSources = new Set(["BLOCK_UPDATE", "COLLABORATION"]);
const pageVersionCoalescibleBlockFields = new Set(["markdown", "checked", "metadata"]);

function serializeHistoryFieldValue(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null) ?? "null";
}

/** Characters of `before` that are not kept, at either end, in `after`. */
export function countRemovedHistoryCharacters(before: string, after: string) {
  const shared = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shared && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix
    && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) suffix += 1;
  return before.length - prefix - suffix;
}

function isCoalescibleBlockUpdateFields(fields: PageVersionFieldChange[]) {
  return fields.length > 0 && fields.every((field) => pageVersionCoalescibleBlockFields.has(field.field));
}

/** True when this change may join the previous entry for the same block. */
export function isCoalescibleBlockUpdate(changes: PageVersionChange[]) {
  if (changes.length !== 1) return false;
  const [change] = changes;
  if (change.kind !== "block-updated" || !isCoalescibleBlockUpdateFields(change.fields)) return false;
  return change.fields.every((field) => {
    if (field.field === "checked") return true;
    // Without both values the size of the removal is unknown: keep it separate.
    if (isPageVersionOmittedValue(field.before) || isPageVersionOmittedValue(field.after)) return false;
    return countRemovedHistoryCharacters(
      serializeHistoryFieldValue(field.before),
      serializeHistoryFieldValue(field.after)
    ) <= pageVersionCoalesceMaxRemovedCharacters;
  });
}

/**
 * Folds `next` into the stored entry: each field keeps the oldest "before"
 * and takes the newest "after". Returns null when they cannot be merged.
 */
export function mergeCoalescedBlockUpdate(
  previous: PageVersionChange[],
  next: PageVersionChange[]
): PageVersionChange[] | null {
  if (previous.length !== 1 || !isCoalescibleBlockUpdate(next)) return null;
  const [stored] = previous;
  const [change] = next;
  if (
    stored.kind !== "block-updated"
    || change.kind !== "block-updated"
    || stored.blockId !== change.blockId
    || !isCoalescibleBlockUpdateFields(stored.fields)
  ) return null;

  const fields = stored.fields.map((field) => ({ ...field }));
  for (const field of change.fields) {
    // A group keeps only its oldest "before" and newest "after", so text typed
    // and then removed inside the group is in neither. Each save may remove a
    // little, but the total removed in one group is capped too; past it a new
    // entry starts and keeps that text as its "before".
    const removed = field.field === "checked"
      ? 0
      : countRemovedHistoryCharacters(
        serializeHistoryFieldValue(field.before),
        serializeHistoryFieldValue(field.after)
      );
    const existing = fields.find((candidate) => candidate.field === field.field);
    const removedInGroup = (existing?.removedInGroup ?? 0) + removed;
    if (removedInGroup > pageVersionCoalesceMaxRemovedCharacters) return null;
    if (existing) {
      existing.after = field.after;
      if (removedInGroup > 0) existing.removedInGroup = removedInGroup;
    } else {
      fields.push(removedInGroup > 0 ? { ...field, removedInGroup } : { ...field });
    }
  }
  return [{ kind: "block-updated", blockId: change.blockId, blockType: change.blockType, fields }];
}

function sameHistoryActors(stored: string | PageVersionActor[], actors: PageVersionActor[]) {
  try {
    const storedIds = parsePageVersionActorsJson(stored).map((actor) => actor.id).sort();
    const nextIds = actors.map((actor) => actor.id).sort();
    return storedIds.length === nextIds.length && storedIds.every((id, index) => id === nextIds[index]);
  } catch {
    return false;
  }
}

async function coalescePageVersion(
  client: DbClient,
  input: { pageId: string; actors: PageVersionActor[]; source: string; changes: PageVersionChange[] },
  page: Pick<PageRow, "edit_version" | "content_version">,
  currentRevision: number
) {
  if (currentRevision < 1 || !pageVersionCoalescibleSources.has(input.source)) return null;
  if (!isCoalescibleBlockUpdate(input.changes)) return null;

  const latest = await client.queryOne<{
    id: number | bigint;
    revision: number | bigint;
    source: string;
    actors: string | PageVersionActor[];
    changes: string | PageVersionChange[];
    recent: number | bigint | boolean | string | null;
  }>(
    `SELECT id, revision, source, actors, changes,
            created_at >= DATE_SUB(NOW(3), INTERVAL ? SECOND) AS recent
     FROM page_versions WHERE page_id = ? AND revision = ? FOR UPDATE`,
    [pageVersionCoalesceWindowSeconds, input.pageId, currentRevision]
  );
  if (
    !latest
    || Number(latest.revision) !== currentRevision
    || latest.source !== input.source
    || !(latest.recent === true || Number(latest.recent) === 1)
    || !sameHistoryActors(latest.actors, input.actors)
  ) return null;

  let stored: PageVersionChange[];
  try {
    stored = parsePageVersionChangesJson(latest.changes);
  } catch {
    return null;
  }
  const merged = mergeCoalescedBlockUpdate(stored, input.changes);
  if (!merged) return null;
  const bounded = boundPageVersionChanges(merged);
  // Never let grouping cost detail that a separate entry would have kept.
  if (bounded.some((change) => change.kind === "details-omitted")) return null;

  await client.execute(
    `UPDATE page_versions
     SET page_edit_version = ?, page_content_version = ?, change_count = ?, change_summary = ?, changes = ?
     WHERE id = ? AND page_id = ?`,
    [
      Number(page.edit_version ?? 1),
      Number(page.content_version ?? 1),
      countPageVersionChanges(merged),
      JSON.stringify(summarizePageVersionChanges(merged)),
      JSON.stringify(bounded),
      Number(latest.id),
      input.pageId
    ]
  );
  await prunePageVersionHistory(client, input.pageId, currentRevision);
  return { id: Number(latest.id), revision: currentRevision };
}

export async function recordPageVersion(
  client: DbClient,
  input: {
    pageId: string;
    actors: PageVersionActor[];
    source: string;
    changes: PageVersionChange[];
  }
) {
  if (!input.changes.length) return null;

  const page = await client.queryOne<Pick<PageRow, "edit_version" | "content_version">>(
    "SELECT edit_version, content_version FROM pages WHERE id = ? FOR UPDATE",
    [input.pageId]
  );
  if (!page) return null;

  const current = await client.queryOne<{ revision: number | bigint | null }>(
    "SELECT MAX(revision) AS revision FROM page_versions WHERE page_id = ?",
    [input.pageId]
  );
  const currentRevision = Number(current?.revision ?? 0);
  if (
    !Number.isSafeInteger(currentRevision)
    || currentRevision < 0
    || currentRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("Page version history revision cannot be advanced safely");
  }
  const coalesced = await coalescePageVersion(client, input, page, currentRevision);
  if (coalesced) return coalesced;
  const revision = currentRevision + 1;
  const summary = summarizePageVersionChanges(input.changes);
  const changeCount = countPageVersionChanges(input.changes);
  const actors = input.actors.length ? input.actors : [{ id: "unknown", username: "unknown", name: null }];
  const changesJson = JSON.stringify(boundPageVersionChanges(input.changes));
  const actorsJson = JSON.stringify(parsePageVersionActorsJson(actors));
  if (Buffer.byteLength(actorsJson, "utf8") > pageVersionWriteMaxBytes) {
    throw new PageVersionHistoryIntegrityError("Page version actors exceed the write byte limit");
  }

  const result = await client.execute<{ insertId: number | bigint }>(
    `INSERT INTO page_versions
       (page_id, revision, page_edit_version, page_content_version, actors, source,
        change_count, change_summary, changes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.pageId,
      revision,
      Number(page.edit_version ?? 1),
      Number(page.content_version ?? 1),
      actorsJson,
      input.source,
      changeCount,
      JSON.stringify(summary),
      changesJson
    ]
  );

  await prunePageVersionHistory(client, input.pageId, revision);

  return { id: Number(result.insertId), revision };
}

export async function resetPageVersionHistory(
  client: DbClient,
  input: { page: PageRow; actor: PageVersionActor }
) {
  // Keep edit/content versions monotonic because they protect optimistic concurrency.
  // Only the user-facing history revision sequence is restarted at revision 1.
  const deletion = await client.execute<{ affectedRows: number }>(
    "DELETE FROM page_versions WHERE page_id = ?",
    [input.page.id]
  );
  const version = await recordPageVersion(client, {
    pageId: input.page.id,
    actors: [input.actor],
    source: "RESET",
    changes: [{
      kind: "history-started",
      page: {
        title: input.page.title,
        icon: input.page.icon,
        coverUrl: describePageCoverUrlForHistory(input.page.cover_url),
        coverPositionX: Math.min(100, Math.max(0, Number(input.page.cover_position_x ?? 50))),
        coverPositionY: Math.min(100, Math.max(0, Number(input.page.cover_position_y ?? 50))),
        isArchived: Boolean(input.page.is_archived),
        isCollection: Boolean(input.page.is_collection),
        parentPageId: input.page.parent_page_id
      }
    }]
  });
  return { version, deletedCount: Number(deletion.affectedRows ?? 0) };
}

export function mapPageVersionListRow(row: PageVersionRow) {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    pageVersion: Number(row.page_edit_version),
    contentVersion: Number(row.page_content_version),
    actors: parseStoredHistory(parsePageVersionActorsJson, row.actors, [] as PageVersionActor[]),
    source: row.source,
    changeCount: Number(row.change_count),
    summary: parseStoredHistory(parsePageVersionSummaryJson, row.change_summary, {
      baseline: 0,
      pageCreated: 0,
      pageFields: [],
      blocksCreated: 0,
      blocksUpdated: 0,
      blocksDeleted: 0,
      blocksMoved: 0
    }),
    createdAt: row.created_at
  };
}

export function mapPageVersionDetailRow(row: PageVersionRow) {
  let changes: PageVersionChange[] = [];
  let integrity: "ok" | "invalid" = "ok";
  try {
    changes = parsePageVersionChangesJson(row.changes ?? []);
  } catch {
    integrity = "invalid";
  }
  return {
    ...mapPageVersionListRow(row),
    changes,
    integrity
  };
}

export type { PageVersionRow };
