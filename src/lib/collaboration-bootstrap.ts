import type { BlockRow } from "../types/domain.js";

const unsafeObjectKeys = new Set(["__proto__", "prototype", "constructor"]);
const maxJsonDepth = 128;
const maxJsonNodes = 200_000;

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

type BootstrapComparableBlock = {
  id: string;
  type: string;
  markdown: string;
  checked: boolean;
  parentBlockId: string | null;
  sortOrder: number;
  metadata: CanonicalJson;
};

type CollaborationBootstrapCandidate = {
  title: string;
  blocks: Array<{
    id: string;
    type: string;
    markdown: string;
    checked: boolean;
    parentBlockId: string | null;
    sortOrder: number;
    metadata: Record<string, unknown> | null;
  }>;
  deletedAttachmentIds: string[];
};

export type CollaborationBootstrapMismatchSummary = {
  invalidCandidate: boolean;
  titleMismatch: boolean;
  canonicalBlockCount: number;
  candidateBlockCount: number;
  missingBlockCount: number;
  extraBlockCount: number;
  changedBlockCount: number;
  attachmentTombstoneCount: number;
};

export type CollaborationBootstrapAssessment =
  | { accepted: true }
  | {
      accepted: false;
      summary: CollaborationBootstrapMismatchSummary;
    };

export class CollaborationBootstrapStateError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "CollaborationBootstrapStateError";
  }
}

type JsonBudget = { nodes: number };

function invalidCanonicalState(message: string, cause?: unknown): never {
  throw new CollaborationBootstrapStateError(message, cause === undefined ? {} : { cause });
}

function canonicalizeJson(value: unknown, depth: number, budget: JsonBudget): CanonicalJson {
  if (depth > maxJsonDepth) {
    return invalidCanonicalState("Stored collaboration metadata is nested too deeply");
  }
  budget.nodes += 1;
  if (budget.nodes > maxJsonNodes) {
    return invalidCanonicalState("Stored collaboration metadata contains too many values");
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalidCanonicalState("Stored collaboration metadata contains a non-finite number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item, depth + 1, budget));
  }
  if (!value || typeof value !== "object") {
    return invalidCanonicalState("Stored collaboration metadata contains a non-JSON value");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidCanonicalState("Stored collaboration metadata contains an unsupported object");
  }

  const result: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>;
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (unsafeObjectKeys.has(key)) {
      return invalidCanonicalState("Stored collaboration metadata contains an unsafe object key");
    }
    result[key] = canonicalizeJson((value as Record<string, unknown>)[key], depth + 1, budget);
  }
  return result;
}

function parseStoredMetadata(metadata: BlockRow["metadata"]): CanonicalJson {
  if (metadata === null || metadata === undefined || metadata === "") return null;
  let decoded: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      decoded = JSON.parse(metadata);
    } catch (error) {
      return invalidCanonicalState("Stored collaboration metadata is not valid JSON", error);
    }
  }
  if (decoded === null) return null;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return invalidCanonicalState("Stored collaboration metadata must be an object or null");
  }
  return canonicalizeJson(decoded, 0, { nodes: 0 });
}

function canonicalizeCandidateMetadata(metadata: unknown): CanonicalJson {
  if (metadata === null) return null;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return invalidCanonicalState("The collaboration bootstrap metadata must be an object or null");
  }
  return canonicalizeJson(metadata, 0, { nodes: 0 });
}

function fromStoredBlock(row: BlockRow): BootstrapComparableBlock {
  const sortOrder = Number(row.sort_order);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 2_147_483_647) {
    return invalidCanonicalState("Stored collaboration block order is outside the supported range");
  }
  return {
    id: row.id,
    type: row.type,
    markdown: row.markdown,
    checked: Boolean(row.checked),
    parentBlockId: row.parent_block_id,
    sortOrder,
    metadata: parseStoredMetadata(row.metadata)
  };
}

function fromCandidateBlock(
  block: CollaborationBootstrapCandidate["blocks"][number]
): BootstrapComparableBlock {
  return {
    id: block.id,
    type: block.type,
    markdown: block.markdown,
    checked: block.checked,
    parentBlockId: block.parentBlockId,
    sortOrder: block.sortOrder,
    metadata: canonicalizeCandidateMetadata(block.metadata)
  };
}

function stableBlockSignature(block: BootstrapComparableBlock) {
  return JSON.stringify({
    id: block.id,
    type: block.type,
    markdown: block.markdown,
    checked: block.checked,
    parentBlockId: block.parentBlockId,
    sortOrder: block.sortOrder,
    metadata: block.metadata
  });
}

/**
 * The first durable Yjs update is an initialization checkpoint, not an edit.
 * It may be accepted only when its decoded page state is semantically identical
 * to the relational page snapshot held under the same page-row transaction lock.
 */
export function assessInitialCollaborationBootstrap({
  pageTitle,
  storedBlocks,
  candidate
}: {
  pageTitle: string;
  storedBlocks: BlockRow[];
  candidate: CollaborationBootstrapCandidate;
}): CollaborationBootstrapAssessment {
  const canonicalById = new Map(
    storedBlocks.map((row) => {
      const block = fromStoredBlock(row);
      return [block.id, stableBlockSignature(block)] as const;
    })
  );
  const candidateById = new Map(
    candidate.blocks.map((item) => {
      const block = fromCandidateBlock(item);
      return [block.id, stableBlockSignature(block)] as const;
    })
  );

  let missingBlockCount = 0;
  let extraBlockCount = 0;
  let changedBlockCount = 0;
  for (const [id, signature] of canonicalById) {
    const candidateSignature = candidateById.get(id);
    if (candidateSignature === undefined) missingBlockCount += 1;
    else if (candidateSignature !== signature) changedBlockCount += 1;
  }
  for (const id of candidateById.keys()) {
    if (!canonicalById.has(id)) extraBlockCount += 1;
  }

  const summary: CollaborationBootstrapMismatchSummary = {
    invalidCandidate: false,
    titleMismatch: candidate.title !== pageTitle,
    canonicalBlockCount: canonicalById.size,
    candidateBlockCount: candidateById.size,
    missingBlockCount,
    extraBlockCount,
    changedBlockCount,
    attachmentTombstoneCount: candidate.deletedAttachmentIds.length
  };
  if (
    !summary.titleMismatch
    && summary.missingBlockCount === 0
    && summary.extraBlockCount === 0
    && summary.changedBlockCount === 0
    && summary.attachmentTombstoneCount === 0
  ) {
    return { accepted: true };
  }
  return { accepted: false, summary };
}

export function invalidInitialCollaborationBootstrapSummary({
  storedBlockCount
}: {
  storedBlockCount: number;
}): CollaborationBootstrapMismatchSummary {
  return {
    invalidCandidate: true,
    titleMismatch: false,
    canonicalBlockCount: storedBlockCount,
    candidateBlockCount: 0,
    missingBlockCount: storedBlockCount,
    extraBlockCount: 0,
    changedBlockCount: 0,
    attachmentTombstoneCount: 0
  };
}
