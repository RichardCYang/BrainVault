export type PageCreateMutationReceipt = {
  page_id: string;
  request_hash: string | null;
  workspace_generation: number | bigint | string | null;
};

export type PageCreateMutationAssessment =
  | { kind: "new" }
  | { kind: "replay"; pageId: string }
  | { kind: "collision" }
  | { kind: "superseded" };

export function assessPageCreateMutationReceipt(
  receipt: PageCreateMutationReceipt | null | undefined,
  requestHash: string | undefined,
  workspaceGeneration: number
): PageCreateMutationAssessment {
  if (!receipt) return { kind: "new" };
  if (!requestHash || !receipt.request_hash || receipt.request_hash !== requestHash) {
    return { kind: "collision" };
  }
  const receiptGeneration = Number(receipt.workspace_generation);
  if (
    !Number.isSafeInteger(receiptGeneration)
    || receiptGeneration < 1
    || receiptGeneration !== workspaceGeneration
  ) {
    return { kind: "superseded" };
  }
  return { kind: "replay", pageId: receipt.page_id };
}
