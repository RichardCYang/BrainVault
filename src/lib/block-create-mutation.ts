export type BlockCreateMutationReceipt = {
  page_id: string;
  block_id: string;
  request_hash: string | null;
};

export type BlockCreateMutationAssessment =
  | { kind: "new" }
  | { kind: "replay"; blockId: string }
  | { kind: "collision" };

export function assessBlockCreateMutationReceipt(
  receipt: BlockCreateMutationReceipt | null | undefined,
  input: { pageId: string; requestHash: string | undefined }
): BlockCreateMutationAssessment {
  if (!receipt) return { kind: "new" };
  if (
    receipt.page_id !== input.pageId
    || !input.requestHash
    || !receipt.request_hash
    || receipt.request_hash !== input.requestHash
  ) {
    return { kind: "collision" };
  }
  return { kind: "replay", blockId: receipt.block_id };
}
