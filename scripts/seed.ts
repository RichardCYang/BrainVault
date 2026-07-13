import { closeDb, db, transaction } from "../src/lib/db.js";
import { createId } from "../src/lib/id.js";
import { hashPassword } from "../src/lib/auth.js";
import { renderBlockHtml } from "../src/lib/markdown.js";
import type { TagRow, UserRow } from "../src/types/domain.js";

async function main() {
  const username = "demo";
  const password = "brainvault123";

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

  if (!user) {
    throw new Error("Failed to create or load demo user");
  }

  const existingPage = await db.queryOne<{ id: string }>(
    "SELECT id FROM pages WHERE owner_id = ? AND title = ? LIMIT 1",
    [user.id, "BrainVault 시작하기"]
  );
  if (existingPage) {
    console.log(`Seed skipped. Demo account already exists: ${username} / ${password}`);
    return;
  }

  const pageId = createId("pag");
  await transaction(async (client) => {
    await client.execute("INSERT INTO pages (id, owner_id, title, icon) VALUES (?, ?, ?, ?)", [
      pageId,
      user.id,
      "BrainVault 시작하기",
      "🧠"
    ]);

    const blocks = [
      { type: "HEADING_1", markdown: "# BrainVault에 오신 것을 환영합니다" },
      { type: "MARKDOWN", markdown: "마크다운으로 작성한 블록을 페이지 안에서 자유롭게 쌓고 재정렬할 수 있습니다." },
      { type: "TODO", markdown: "- [ ] 첫 노트 만들기\n- [ ] 검색 API 테스트하기" }
    ] as const;

    for (const [sortOrder, block] of blocks.entries()) {
      await client.execute(
        `INSERT INTO blocks (id, page_id, type, markdown, html_cache, checked, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [createId("blk"), pageId, block.type, block.markdown, renderBlockHtml(block.type, block.markdown), 0, sortOrder]
      );
    }

    await client.execute("INSERT IGNORE INTO tags (id, name) VALUES (?, ?)", [createId("tag"), "demo"]);
    const tag = await client.queryOne<TagRow>("SELECT * FROM tags WHERE name = ?", ["demo"]);
    if (tag) {
      await client.execute("INSERT IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)", [pageId, tag.id]);
    }
  });

  console.log(`Seed complete. Demo account: ${username} / ${password}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
