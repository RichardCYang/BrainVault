export interface PageCreateMutationReceipt {
  page_id: string;
  request_hash: string | null;
}

export type PageCreateMutationAssessment =
  | { kind: "new" }
  | { kind: "replay"; pageId: string }
  | { kind: "collision" };

export function assessPageCreateMutationReceipt(
  receipt: PageCreateMutationReceipt | null | undefined,
  requestHash: string | undefined
): PageCreateMutationAssessment {
  if (!receipt) return { kind: "new" };
  if (!requestHash || !receipt.request_hash || receipt.request_hash !== requestHash) {
    return { kind: "collision" };
  }
  return { kind: "replay", pageId: receipt.page_id };
}
