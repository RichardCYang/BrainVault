export type BlockDeleteMutationReceipt = {
  page_id: string;
  block_id: string;
  request_hash: string | null;
  page_content_version: number;
  attachment_ids: unknown;
  attachment_generation?: number | null;
};

export type BlockDeleteMutationAssessment =
  | {
      kind: "replay";
      pageId: string;
      blockId: string;
      pageContentVersion: number;
      attachmentIds: string[];
      attachmentGeneration?: number;
    }
  | { kind: "collision" }
  | { kind: "incomplete" };

function decodeJsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function decodeBlockDeleteAttachmentIds(value: unknown): string[] | null {
  const decoded = decodeJsonValue(value);
  if (!Array.isArray(decoded)) return null;
  if (decoded.some((item) => typeof item !== "string" || !item.length || item.length > 64)) return null;
  if (new Set(decoded).size !== decoded.length) return null;
  return [...decoded];
}

function decodeAttachmentGeneration(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return generation;
}

export function assessBlockDeleteMutationReceipt(
  receipt: BlockDeleteMutationReceipt,
  request: { blockId: string; requestHash: string }
): BlockDeleteMutationAssessment {
  if (receipt.block_id !== request.blockId || receipt.request_hash !== request.requestHash) {
    return { kind: "collision" };
  }

  const pageContentVersion = Number(receipt.page_content_version);
  const attachmentIds = decodeBlockDeleteAttachmentIds(receipt.attachment_ids);
  const attachmentGeneration = decodeAttachmentGeneration(receipt.attachment_generation);
  if (
    !receipt.page_id
    || !Number.isSafeInteger(pageContentVersion)
    || pageContentVersion < 1
    || attachmentIds === null
    || attachmentGeneration === null
  ) {
    return { kind: "incomplete" };
  }

  return {
    kind: "replay",
    pageId: receipt.page_id,
    blockId: receipt.block_id,
    pageContentVersion,
    attachmentIds,
    ...(attachmentGeneration === undefined ? {} : { attachmentGeneration })
  };
}
