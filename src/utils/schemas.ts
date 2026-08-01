import { z } from "zod";

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

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "ID must be at least 3 characters")
  .max(40, "ID must be at most 40 characters")
  .regex(/^[a-zA-Z0-9._-]+$/, "ID can contain letters, numbers, dots, underscores, and hyphens only")
  .transform((value) => value.toLowerCase());

export const idParamSchema = z.object({
  pageId: z.string().min(1).optional(),
  blockId: z.string().min(1).optional()
});

export const blockTypeSchema = z.enum([
  "MARKDOWN",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "TODO",
  "QUOTE",
  "CALLOUT",
  "TABLE",
  "KANBAN",
  "DATABASE",
  "GANTT",
  "BOOKMARK",
  "AI_CHAT",
  "MATH",
  "CODE",
  "DIVIDER",
  "IMAGE",
  "ATTACHMENT"
]);

export const metadataSchema = z.record(z.string(), z.unknown()).optional();

export function requireUser(user: Express.Request["user"]) {
  if (!user) {
    throw new Error("Route expected authenticated user but req.user was missing");
  }
  return user;
}
