import type { DbClient } from "./db.js";
import type { BlockRow, PageRow, UserRow } from "../types/domain.js";

export type PageVersionActor = {
  id: string;
  username: string;
  name: string | null;
};

export type PageVersionFieldChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type PageVersionBlockState = {
  id: string;
  parentBlockId: string | null;
  type: BlockRow["type"];
  markdown: string;
  checked: boolean;
  sortOrder: number;
  metadata: Record<string, unknown> | null;
};

export type PageVersionPageState = {
  title: string;
  icon: string | null;
  coverUrl: string | null;
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
  | { kind: "block-deleted"; block: PageVersionBlockState };

export type PageVersionSummary = {
  baseline: number;
  pageCreated: number;
  pageFields: string[];
  blocksCreated: number;
  blocksUpdated: number;
  blocksDeleted: number;
  blocksMoved: number;
};

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

function parseJson<T>(value: string | T, fallback: T): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeMetadata(value: BlockRow["metadata"]): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
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
    coverUrl: page.cover_url,
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
    metadata: normalizeMetadata(block.metadata)
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
    "SELECT edit_version, content_version FROM pages WHERE id = ?",
    [input.pageId]
  );
  if (!page) return null;

  const current = await client.queryOne<{ revision: number | bigint | null }>(
    "SELECT MAX(revision) AS revision FROM page_versions WHERE page_id = ?",
    [input.pageId]
  );
  const revision = Number(current?.revision ?? 0) + 1;
  const summary = summarizePageVersionChanges(input.changes);
  const changeCount = countPageVersionChanges(input.changes);
  const actors = input.actors.length ? input.actors : [{ id: "unknown", username: "unknown", name: null }];

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
      JSON.stringify(actors),
      input.source,
      changeCount,
      JSON.stringify(summary),
      JSON.stringify(input.changes)
    ]
  );

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
        coverUrl: input.page.cover_url,
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
    actors: parseJson(row.actors, [] as PageVersionActor[]),
    source: row.source,
    changeCount: Number(row.change_count),
    summary: parseJson(row.change_summary, {
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
  return {
    ...mapPageVersionListRow(row),
    changes: parseJson(row.changes ?? [], [] as PageVersionChange[])
  };
}

export type { PageVersionRow };
