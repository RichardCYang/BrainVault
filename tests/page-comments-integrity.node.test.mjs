import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("page discussions are persisted and permission-bound", async () => {
  const [route, migration, versionMigration] = await Promise.all([
    read("src/routes/collaboration.routes.ts"),
    read("migrations/067_page_comments.sql"),
    read("migrations/070_page_comment_edit_versions.sql")
  ]);

  assert.match(route, /z\.string\(\)\.trim\(\)\.min\(1\)\.max\(2_000\)/);
  assert.match(route, /const maxPageCommentsPerPage = 500/);
  assert.match(route, /collaborationRouter\.get\(\s*"\/pages\/:pageId\/comments"/);
  assert.match(route, /collaborationRouter\.post\(\s*"\/pages\/:pageId\/comments"/);
  assert.match(route, /collaborationRouter\.patch\(\s*"\/pages\/:pageId\/comments\/:commentId"/);
  assert.match(route, /collaborationRouter\.delete\(\s*"\/pages\/:pageId\/comments\/:commentId"/);
  assert.match(route, /getPageAccess\(pageId, user\.id, client, \{ lockPage: true \}\)/);
  assert.match(route, /Only the comment author can edit this comment/);
  assert.match(route, /existing\.user_id !== user\.id && access\.role !== "OWNER"/);
  assert.match(
    route,
    /collaborationRouter\.delete\([\s\S]*assertPageNotArchived\(access\.page, "Restore the page before deleting a comment"\)/
  );
  assert.match(route, /body: row\.body[\s\S]*?version: Number\(row\.edit_version\)[\s\S]*?canEdit: isAuthor[\s\S]*?canDelete: isAuthor \|\| viewer\.isOwner/);
  assert.match(route, /expectedVersion: safeVersionSchema/);
  assert.match(route, /SET body = \?, edit_version = edit_version \+ 1[\s\S]*?AND edit_version = \?/);
  assert.match(route, /DELETE FROM page_comments WHERE page_id = \? AND id = \? AND edit_version = \?/);
  assert.match(route, /PAGE_COMMENT_EDIT_CONFLICT/);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS page_comments/);
  assert.match(migration, /FOREIGN KEY \(page_id\) REFERENCES pages\(id\) ON DELETE CASCADE/);
  assert.match(migration, /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /idx_page_comments_page_created/);
  assert.match(versionMigration, /ADD COLUMN IF NOT EXISTS edit_version BIGINT UNSIGNED NOT NULL DEFAULT 1/);
});

test("page discussion UI sits under the title and renders comment text safely", async () => {
  const [html, app, styles, i18n] = await Promise.all([
    read("public/index.html"),
    read("public/app.js"),
    read("public/styles.css"),
    read("public/i18n.js")
  ]);

  assert.match(html, /<div class="page-toolbar">[\s\S]*?<section id="page-comments"/);
  assert.match(html, /id="page-comments-input"[\s\S]*?maxlength="2000"/);
  assert.match(app, /body\.textContent = comment\.body/);
  assert.doesNotMatch(app, /innerHTML\s*=\s*comment\.body/);
  assert.match(app, /\/api\/pages\/\$\{encodeURIComponent\(pageId\)\}\/comments/);
  assert.match(app, /editingVersion: null/);
  assert.match(app, /body: \{ body, expectedVersion \}/);
  assert.match(app, /method: "DELETE",\s*body: \{ expectedVersion \}/);
  assert.match(app, /event\.key === "Enter" && \(event\.metaKey \|\| event\.ctrlKey\)/);
  assert.match(styles, /\.page-comments\s*\{[\s\S]*?width: min\(100%, 46rem\)/);
  assert.match(styles, /body\.pdf-export-mode \.page-comments/);
  for (const language of ["en", "ja", "ko", "fr", "de", "es", "pt"]) {
    assert.match(i18n, new RegExp(`\\n  ${language}: \\{[\\s\\S]*?add:`));
  }
});

test("complete backups and snapshot diffs preserve page discussions", async () => {
  const [transfer, limits, diff] = await Promise.all([
    read("src/lib/data-transfer.ts"),
    read("src/lib/data-transfer-limits.ts"),
    read("src/lib/workspace-snapshot-diff.ts")
  ]);

  assert.match(limits, /maxPageComments: 200_000/);
  assert.match(transfer, /const pageCommentSchema = z\.object/);
  assert.match(transfer, /pageComments: z\.array\(pageCommentSchema\)/);
  assert.match(transfer, /pageComments: snapshot\.pageComments/);
  assert.match(transfer, /prepareRestorePageComments/);
  assert.match(transfer, /Page comment owner identity is invalid/);
  assert.match(transfer, /INSERT INTO page_comments \(id, page_id, user_id, body, edit_version, created_at, updated_at\)/);
  assert.match(transfer, /restoreVersion,\s*comment\.createdAt,\s*comment\.updatedAt/);
  assert.match(transfer, /`page-comment\\0\$\{JSON\.stringify\(comment\)\}\\n`/);
  assert.match(diff, /fieldDifference\("commentCount"/);
  assert.match(diff, /longTextFieldDifference\("commentState"/);
});
