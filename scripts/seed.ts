import { readFile } from "node:fs/promises";
import { closeDb, db, transaction, type DbClient } from "../src/lib/db.js";
import { createId } from "../src/lib/id.js";
import { hashPassword } from "../src/lib/auth.js";
import { renderBlockHtml } from "../src/lib/markdown.js";
import type { BlockType, TagRow, UserRow } from "../src/types/domain.js";

type DemoBlock = {
  type: BlockType;
  markdown: string;
  checked?: boolean;
  metadata?: Record<string, unknown>;
};

type DemoWorkspace = {
  page: {
    title: string;
    icon: string;
    tags: string[];
  };
  blocks: DemoBlock[];
};

async function loadDemoWorkspace(): Promise<DemoWorkspace> {
  const raw = await readFile(new URL("./demo-workspace.json", import.meta.url), "utf8");
  return JSON.parse(raw) as DemoWorkspace;
}

async function attachTags(client: DbClient, pageId: string, tagNames: string[]) {
  for (const name of tagNames) {
    await client.execute("INSERT IGNORE INTO tags (id, name) VALUES (?, ?)", [createId("tag"), name]);
    const tag = await client.queryOne<TagRow>("SELECT * FROM tags WHERE name = ?", [name]);
    if (tag) {
      await client.execute("INSERT IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)", [pageId, tag.id]);
    }
  }
}

async function insertBlocks(client: DbClient, pageId: string, blocks: DemoBlock[]) {
  for (const [sortOrder, block] of blocks.entries()) {
    const metadata = block.metadata ?? null;
    await client.execute(
      `INSERT INTO blocks (id, page_id, type, markdown, html_cache, checked, sort_order, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId("blk"),
        pageId,
        block.type,
        block.markdown,
        renderBlockHtml(block.type, block.markdown, Boolean(block.checked), metadata),
        block.checked ? 1 : 0,
        sortOrder,
        metadata ? JSON.stringify(metadata) : null
      ]
    );
  }
}

async function createPageIfMissing(
  userId: string,
  page: DemoWorkspace["page"],
  blocks: DemoBlock[]
) {
  const existing = await db.queryOne<{ id: string }>(
    "SELECT id FROM pages WHERE owner_id = ? AND title = ? LIMIT 1",
    [userId, page.title]
  );
  if (existing) return false;

  await transaction(async (client) => {
    const pageId = createId("pag");
    await client.execute("INSERT INTO pages (id, owner_id, title, icon) VALUES (?, ?, ?, ?)", [
      pageId,
      userId,
      page.title,
      page.icon
    ]);
    await insertBlocks(client, pageId, blocks);
    await attachTags(client, pageId, page.tags);
  });

  return true;
}

async function main() {
  const username = "demo";
  const password = "brainvault123";
  const demoWorkspace = await loadDemoWorkspace();

  let user = await db.queryOne<UserRow>("SELECT * FROM users WHERE username = ?", [username]);
  if (!user) {
    const userId = createId("usr");
    await db.execute("INSERT INTO users (id, username, name, password_hash) VALUES (?, ?, ?, ?)", [
      userId,
      username,
      "BrainVault Demo",
      await hashPassword(password)
    ]);
    user = await db.queryOne<UserRow>("SELECT * FROM users WHERE id = ?", [userId]);
  }

  if (!user) throw new Error("Failed to create or load demo user");

  const createdStarter = await createPageIfMissing(
    user.id,
    { title: "Getting Started with BrainVault", icon: "🧠", tags: ["demo"] },
    [
      { type: "HEADING_1", markdown: "# Welcome to BrainVault" },
      { type: "MARKDOWN", markdown: "Create, stack, and reorder Markdown-powered blocks directly on the page." },
      { type: "TODO", markdown: "- [ ] Create your first note\n- [ ] Try the search API" }
    ]
  );

  const createdWorkspace = await createPageIfMissing(user.id, demoWorkspace.page, demoWorkspace.blocks);
  const createdCount = Number(createdStarter) + Number(createdWorkspace);
  const action = createdCount ? `${createdCount} demo page(s) created` : "demo pages already exist";
  console.log(`Seed complete (${action}). Demo account: ${username} / ${password}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
