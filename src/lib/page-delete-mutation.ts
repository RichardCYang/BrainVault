export type PageDeleteMutationReceipt = {
  page_id: string;
  request_hash: string | null;
  page_ids: unknown;
  attachment_ids: unknown;
};

export type PageDeleteMutationAssessment =
  | {
      kind: "replay";
      pageId: string;
      pageIds: string[];
      attachmentIds: string[];
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

function decodeUniqueIds(value: unknown): string[] | null {
  const decoded = decodeJsonValue(value);
  if (!Array.isArray(decoded) || decoded.length > 10_000) return null;
  if (decoded.some((item) => typeof item !== "string" || !item.length || item.length > 64)) return null;
  if (new Set(decoded).size !== decoded.length) return null;
  return [...decoded];
}

export function decodePageDeletePageIds(value: unknown): string[] | null {
  const pageIds = decodeUniqueIds(value);
  return pageIds?.length ? pageIds : null;
}

export function decodePageDeleteAttachmentIds(value: unknown): string[] | null {
  return decodeUniqueIds(value);
}

export function assessPageDeleteMutationReceipt(
  receipt: PageDeleteMutationReceipt,
  request: { pageId: string; requestHash: string }
): PageDeleteMutationAssessment {
  if (receipt.page_id !== request.pageId || receipt.request_hash !== request.requestHash) {
    return { kind: "collision" };
  }

  const pageIds = decodePageDeletePageIds(receipt.page_ids);
  const attachmentIds = decodePageDeleteAttachmentIds(receipt.attachment_ids);
  if (!pageIds || !pageIds.includes(receipt.page_id) || attachmentIds === null) {
    return { kind: "incomplete" };
  }

  return {
    kind: "replay",
    pageId: receipt.page_id,
    pageIds,
    attachmentIds
  };
}
