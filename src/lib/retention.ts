import { db } from "./db.js";

let tagCursor = "";
export const deletedCommentRetentionDays = 30;
export const loginHistoryRetentionMonths = 13;

export async function pruneExpiredWorkspaceRecords() {
  await db.execute(
    `DELETE FROM user_login_attempts WHERE attempted_at < CURRENT_TIMESTAMP(3) - INTERVAL ? MONTH
     ORDER BY attempted_at LIMIT 500`, [loginHistoryRetentionMonths]
  );
  await db.execute(
    `DELETE FROM page_comment_deletions WHERE deleted_at < CURRENT_TIMESTAMP(3) - INTERVAL ? DAY
     ORDER BY deleted_at LIMIT 500`, [deletedCommentRetentionDays]
  );
  const tags = await db.query<{ id: string }>("SELECT id FROM tags WHERE id > ? ORDER BY id LIMIT 256", [tagCursor]);
  if (tags.length) {
    // Recheck references at deletion, including links added after the scan.
    await db.execute(
      `DELETE FROM tags WHERE id IN (${tags.map(() => "?").join(", ")})
       AND NOT EXISTS (SELECT 1 FROM page_tags pt WHERE pt.tag_id = tags.id)`, tags.map((tag) => tag.id)
    );
  }
  tagCursor = tags.length === 256 ? tags[tags.length - 1].id : "";
}
