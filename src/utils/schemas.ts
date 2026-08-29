import { z } from "zod";
import {
  bcryptPasswordLimitMessage,
  isPasswordWithinBcryptLimit
} from "../lib/password-policy.js";

export function httpUrlSchema(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "URL must use HTTP or HTTPS");
}

export function passwordInputSchema(minLength: number) {
  return z
    .string()
    .min(minLength)
    .max(128)
    .refine(isPasswordWithinBcryptLimit, bcryptPasswordLimitMessage);
}

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "ID must be at least 3 characters")
  .max(40, "ID must be at most 40 characters")
  .regex(/^[a-zA-Z0-9._-]+$/, "ID can contain letters, numbers, dots, underscores, and hyphens only")
  .transform((value) => value.toLowerCase());

export const routeIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "Invalid resource identifier");

export const safeVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const idParamSchema = z.object({
  pageId: routeIdSchema.optional(),
  blockId: routeIdSchema.optional()
});

export const blockTypeSchema = z.enum([
  "MARKDOWN",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "TODO",
  "UNORDERED_LIST",
  "ORDERED_LIST",
  "QUOTE",
  "CALLOUT",
  "TOGGLE",
  "ACCORDION",
  "TABLE",
  "KANBAN",
  "DATABASE",
  "TREEVIEW",
  "TIMETABLE",
  "GANTT",
  "BOOKMARK",
  "AI_CHAT",
  "MATH",
  "MERMAID",
  "CODE",
  "DIVIDER",
  "IMAGE",
  "VIDEO",
  "ATTACHMENT"
]);

const metadataMaxDepth = 12;
const metadataMaxNodes = 25_000;
const metadataMaxSerializedBytes = 4 * 1024 * 1024;
const forbiddenMetadataKeys = new Set(["__proto__", "constructor", "prototype"]);

type MetadataEnvelope = Record<string, unknown>;

function inspectMetadataEnvelope(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  depth: number,
  budget: { nodes: number }
): boolean {
  if (depth > metadataMaxDepth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Metadata exceeds the maximum nesting depth of ${metadataMaxDepth}`
    });
    return false;
  }

  budget.nodes += 1;
  if (budget.nodes > metadataMaxNodes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Metadata exceeds the maximum node count of ${metadataMaxNodes}`
    });
    return false;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!inspectMetadataEnvelope(value[index], ctx, [...path, index], depth + 1, budget)) return false;
    }
    return true;
  }
  if (!value || typeof value !== "object") return true;

  for (const [key, child] of Object.entries(value as MetadataEnvelope)) {
    if (forbiddenMetadataKeys.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: `Metadata key '${key}' is not allowed`
      });
      return false;
    }
    if (!inspectMetadataEnvelope(child, ctx, [...path, key], depth + 1, budget)) return false;
  }
  return true;
}

const metadataEnvelopeSchema = z.custom<MetadataEnvelope>(
  (value) => Boolean(value && typeof value === "object" && !Array.isArray(value)),
  { message: "Metadata must be a JSON object" }
);

export const metadataSchema = metadataEnvelopeSchema
  .superRefine((value, ctx) => {
    if (!inspectMetadataEnvelope(value, ctx, [], 0, { nodes: 0 })) return;
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Metadata must be JSON serializable" });
      return;
    }
    if (Buffer.byteLength(serialized, "utf8") > metadataMaxSerializedBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Metadata exceeds the ${metadataMaxSerializedBytes}-byte storage boundary`
      });
    }
  })
  .optional();

export function requireUser(user: Express.Request["user"]) {
  if (!user) {
    throw new Error("Route expected authenticated user but req.user was missing");
  }
  return user;
}
