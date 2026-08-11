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
  "TABLE",
  "KANBAN",
  "DATABASE",
  "TIMETABLE",
  "GANTT",
  "BOOKMARK",
  "AI_CHAT",
  "MATH",
  "CODE",
  "DIVIDER",
  "IMAGE",
  "VIDEO",
  "ATTACHMENT"
]);

export const metadataSchema = z.record(z.string(), z.unknown()).optional();

export function requireUser(user: Express.Request["user"]) {
  if (!user) {
    throw new Error("Route expected authenticated user but req.user was missing");
  }
  return user;
}
