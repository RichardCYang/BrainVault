import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { requireAuth } from "../middleware/auth.js";
import { getValidatedQuery, validate } from "../middleware/validate.js";
import { requireUser } from "../utils/schemas.js";
import type { BlockRow, PageRow } from "../types/domain.js";

export const searchRouter = Router();

searchRouter.use(requireAuth);

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

function snippet(markdown: string, term: string) {
  const normalized = markdown.replace(/\s+/g, " ").trim();
  const idx = normalized.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return normalized.slice(0, 180);
  const start = Math.max(0, idx - 60);
  const end = Math.min(normalized.length, idx + term.length + 120);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}

searchRouter.get("/", validate({ query: searchQuerySchema }), async (req, res, next) => {
  try {
    const user = requireUser(req.user);
    const query = getValidatedQuery<z.infer<typeof searchQuerySchema>>(req);
    const search = `%${query.q}%`;

    const pages = await db.query<PageRow>(
      `SELECT * FROM pages
       WHERE owner_id = ? AND is_archived = 0 AND title LIKE ?
       ORDER BY updated_at DESC
       LIMIT ?`,
      [user.id, search, query.limit]
    );

    const blocks = await db.query<BlockRow & { page_title: string; page_icon: string | null }>(
      `SELECT b.*, p.title AS page_title, p.icon AS page_icon
       FROM blocks b
       INNER JOIN pages p ON p.id = b.page_id
       WHERE p.owner_id = ? AND p.is_archived = 0 AND b.markdown LIKE ?
       ORDER BY b.updated_at DESC
       LIMIT ?`,
      [user.id, search, query.limit]
    );

    res.json({
      results: [
        ...pages.map((page) => ({
          kind: "page" as const,
          pageId: page.id,
          title: page.title,
          icon: page.icon,
          updatedAt: page.updated_at
        })),
        ...blocks.map((block) => ({
          kind: "block" as const,
          blockId: block.id,
          pageId: block.page_id,
          pageTitle: block.page_title,
          pageIcon: block.page_icon,
          type: block.type,
          snippet: snippet(block.markdown, query.q),
          updatedAt: block.updated_at
        }))
      ]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, query.limit)
    });
  } catch (error) {
    next(error);
  }
});
