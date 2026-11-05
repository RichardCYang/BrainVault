import { ApiError } from "./http.js";

// These ceilings accommodate all current manifest sections at their existing
// row limits. JSON columns remain strings here and have their own validators.
export const manifestValidationLimits = Object.freeze({
  maxNodes: 8_000_000,
  maxArrayItems: 200_000,
  maxObjectKeys: 64,
  maxKeyLength: 160,
  maxDepth: 16
});

export function assertManifestValidationBudget(root: unknown) {
  let nodes = 0;
  const reject = (): never => {
    throw new ApiError(413, "DATA_BACKUP_COMPLEXITY_EXCEEDED", "The backup manifest is too complex to validate safely");
  };
  // Recursion is bounded before descent. No worklist proportional to the input
  // width and no validation issues are allocated during this inspection.
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > manifestValidationLimits.maxNodes || depth > manifestValidationLimits.maxDepth) reject();
    if (Array.isArray(value)) {
      if (value.length > manifestValidationLimits.maxArrayItems) reject();
      for (const item of value) visit(item, depth + 1);
    } else if (value !== null && typeof value === "object") {
      let keys = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++keys > manifestValidationLimits.maxObjectKeys || key.length > manifestValidationLimits.maxKeyLength) reject();
        visit((value as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  visit(root, 0);
}

