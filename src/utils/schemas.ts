import { z } from "zod";

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
  "CODE",
  "DIVIDER",
  "IMAGE"
]);

export const metadataSchema = z.record(z.string(), z.unknown()).optional();

export function requireUser(user: Express.Request["user"]) {
  if (!user) {
    throw new Error("Route expected authenticated user but req.user was missing");
  }
  return user;
}
