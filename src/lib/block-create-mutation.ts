export type BlockCreateMutationReceipt = {
  page_id: string;
  block_id: string;
  request_hash: string | null;
  workspace_generation: number | bigint | string | null;
  workspace_owner_id: string | null;
  owner_workspace_generation: number | bigint | string | null;
};

export type BlockCreateMutationAssessment =
  | { kind: "new" }
  | { kind: "replay"; blockId: string }
  | { kind: "collision" }
  | { kind: "superseded" };

export function assessBlockCreateMutationReceipt(
  receipt: BlockCreateMutationReceipt | null | undefined,
  input: {
    pageId: string;
    requestHash: string | undefined;
    workspaceGeneration: number;
    workspaceOwnerId: string;
    ownerWorkspaceGeneration: number;
  }
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

  const receiptWorkspaceGeneration = Number(receipt.workspace_generation);
  const receiptOwnerWorkspaceGeneration = Number(receipt.owner_workspace_generation);
  if (
    !Number.isSafeInteger(receiptWorkspaceGeneration)
    || receiptWorkspaceGeneration < 1
    || receiptWorkspaceGeneration !== input.workspaceGeneration
    || !receipt.workspace_owner_id
    || receipt.workspace_owner_id !== input.workspaceOwnerId
    || !Number.isSafeInteger(receiptOwnerWorkspaceGeneration)
    || receiptOwnerWorkspaceGeneration < 1
    || receiptOwnerWorkspaceGeneration !== input.ownerWorkspaceGeneration
  ) {
    return { kind: "superseded" };
  }

  return { kind: "replay", blockId: receipt.block_id };
}
