export const blockSortOrderLimits = Object.freeze({
  min: 0,
  max: 2_147_483_647
});

export type BlockSortOrderIntegrityCode =
  | "BLOCK_SORT_ORDER_INVALID"
  | "BLOCK_SORT_ORDER_EXHAUSTED";

export class BlockSortOrderIntegrityError extends Error {
  readonly code: BlockSortOrderIntegrityCode;
  readonly value: number;

  constructor(code: BlockSortOrderIntegrityCode, message: string, value: number) {
    super(message);
    this.name = "BlockSortOrderIntegrityError";
    this.code = code;
    this.value = value;
  }
}

export function assertBlockSortOrder(value: number) {
  if (
    !Number.isSafeInteger(value)
    || value < blockSortOrderLimits.min
    || value > blockSortOrderLimits.max
  ) {
    throw new BlockSortOrderIntegrityError(
      "BLOCK_SORT_ORDER_INVALID",
      `Block sort order must be a safe integer from ${blockSortOrderLimits.min} through ${blockSortOrderLimits.max}`,
      value
    );
  }
  return value;
}

export function nextBlockSortOrder(lastSortOrder: number | null | undefined) {
  if (lastSortOrder === null || lastSortOrder === undefined) return blockSortOrderLimits.min;
  const current = assertBlockSortOrder(lastSortOrder);
  if (current === blockSortOrderLimits.max) {
    throw new BlockSortOrderIntegrityError(
      "BLOCK_SORT_ORDER_EXHAUSTED",
      "The block order range is exhausted",
      current
    );
  }
  return current + 1;
}
