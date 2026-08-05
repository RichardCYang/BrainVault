export interface PageVersionResetMutationReceipt {
  page_id: string;
  request_hash: string | null;
  revision: number | bigint | null;
  deleted_count: number | bigint | null;
}

export type PageVersionResetMutationAssessment =
  | { kind: "new" }
  | { kind: "replay"; revision: number; deletedCount: number }
  | { kind: "collision" }
  | { kind: "incomplete" };

export function assessPageVersionResetMutationReceipt(
  receipt: PageVersionResetMutationReceipt | null | undefined,
  input: { pageId: string; requestHash: string | undefined }
): PageVersionResetMutationAssessment {
  if (!receipt) return { kind: "new" };
  if (
    receipt.page_id !== input.pageId
    || !input.requestHash
    || !receipt.request_hash
    || receipt.request_hash !== input.requestHash
  ) {
    return { kind: "collision" };
  }
  if (receipt.revision === null || receipt.deleted_count === null) {
    return { kind: "incomplete" };
  }
  return {
    kind: "replay",
    revision: Number(receipt.revision),
    deletedCount: Number(receipt.deleted_count)
  };
}
