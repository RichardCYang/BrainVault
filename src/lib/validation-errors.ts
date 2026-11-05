import { z, type ZodError } from "zod";

/** Parse collections one item at a time; callers catch the first thrown ZodError. */
export function failFastArray<T extends z.ZodTypeAny>(itemSchema: T, maxItems: number) {
  return z.unknown().transform((value): z.output<T>[] => {
    // Unlike Zod 3 array.max(), this check happens before any item is parsed.
    if (!Array.isArray(value) || value.length > maxItems) {
      throw new z.ZodError([{ code: "custom", path: [], message: "Invalid collection or collection size" }]);
    }
    return value.map((item) => itemSchema.parse(item));
  });
}

/** Preserve the public flattened shape without serializing arbitrary input or all issues. */
export function boundedValidationDetails(error: ZodError) {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = Object.create(null);
  for (const issue of error.issues.slice(0, 20)) {
    const message = issue.message.slice(0, 200);
    if (issue.path.length === 0) formErrors.push(message);
    else {
      const field = String(issue.path[0]).slice(0, 80);
      (fieldErrors[field] ??= []).push(message);
    }
  }
  return { formErrors, fieldErrors };
}
