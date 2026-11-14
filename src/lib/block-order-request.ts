import { z } from "zod";
import { ApiError } from "./http.js";

/**
 * A block reorder names every sibling of the parent it changes. As one JSON
 * object per block, a page's worth of siblings outgrew the shared request
 * validation budget (50,000 values) at about 10,000 blocks. The compact form
 * carries the same snapshot as two strings, so its size no longer depends on
 * that budget; it is expanded here into exactly the items the itemized form
 * would have sent, and validated by the same code.
 */
export const maxCompactOrderIdLength = 64;
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const versionPattern = /^[1-9][0-9]{0,15}$/;

export function compactBlockOrderSchema(maxItems: number) {
  return z.object({
    parentBlockId: z.string().regex(idPattern).nullable(),
    // Comma-separated, in the requested order.
    ids: z.string().min(1).max(maxItems * (maxCompactOrderIdLength + 1)),
    // Comma-separated expected edit versions, one per id.
    versions: z.string().min(1).max(maxItems * 17)
  }).strict();
}

export type CompactBlockOrder = z.infer<ReturnType<typeof compactBlockOrderSchema>>;

export type BlockOrderItem = {
  id: string;
  sortOrder: number;
  parentBlockId: string | null;
  expectedVersion: number;
};

function invalidOrder(): never {
  throw new ApiError(400, "INVALID_BLOCK_ORDER", "The requested block order is malformed.");
}

export function expandCompactBlockOrder(order: CompactBlockOrder, maxItems: number): BlockOrderItem[] {
  const ids = order.ids.split(",");
  const versions = order.versions.split(",");
  if (ids.length === 0 || ids.length > maxItems || ids.length !== versions.length) invalidOrder();
  const items: BlockOrderItem[] = new Array(ids.length);
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const version = versions[index];
    if (!idPattern.test(id) || !versionPattern.test(version)) invalidOrder();
    const expectedVersion = Number(version);
    if (!Number.isSafeInteger(expectedVersion)) invalidOrder();
    items[index] = { id, sortOrder: index, parentBlockId: order.parentBlockId, expectedVersion };
  }
  return items;
}
