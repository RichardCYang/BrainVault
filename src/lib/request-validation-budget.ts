/**
 * Pre-Zod structural admission limit. Walk the already-parsed JSON without
 * collecting validation errors, and fail closed before Zod sees a pathologically
 * wide/nested container. Retain this independent work budget alongside Zod's
 * patched collection validation and the bounded public error response.
 */
export const REQUEST_VALIDATION_MAX_ARRAY_ITEMS = 10_000;
export const REQUEST_VALIDATION_MAX_OBJECT_KEYS = 10_000;
export const REQUEST_VALIDATION_MAX_NODES = 50_000;

export function isWithinRequestValidationBudget(root: unknown): boolean {
  const stack: unknown[] = [root];
  let nodes = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    nodes += 1;
    if (nodes > REQUEST_VALIDATION_MAX_NODES) return false;
    if (Array.isArray(value)) {
      if (value.length > REQUEST_VALIDATION_MAX_ARRAY_ITEMS) return false;
      for (const item of value) stack.push(item);
    } else if (value !== null && typeof value === "object") {
      const values = Object.values(value);
      if (values.length > REQUEST_VALIDATION_MAX_OBJECT_KEYS) return false;
      for (const item of values) stack.push(item);
    }
    // Bound pending work as well as completed work, to avoid a huge stack.
    if (stack.length + nodes > REQUEST_VALIDATION_MAX_NODES) return false;
  }
  return true;
}
