import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const readSource = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

const defaultCoverPaths = Array.from(
  { length: 5 },
  (_, index) => `public/img/default_cover/coverimg${index + 1}.png`
);
const defaultCoverThumbnailPaths = Array.from(
  { length: 5 },
  (_, index) => `public/img/default_cover/thumbnails/coverimg${index + 1}.webp`
);

test("all built-in cover images are shipped and exposed by the picker", async () => {
  const html = await readSource("public/index.html");
  const serverValidation = await readSource("src/lib/page-cover.ts");

  for (const relativePath of defaultCoverPaths) {
    const info = await stat(new URL(`../${relativePath}`, import.meta.url));
    assert.ok(info.isFile());
    assert.ok(info.size > 8, `${relativePath} must not be empty`);
    const bytes = await readFile(new URL(`../${relativePath}`, import.meta.url));
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${relativePath} must be a PNG`
    );

    const publicPath = `/${relativePath.replace(/^public\//, "")}`;
    assert.match(html, new RegExp(publicPath.replaceAll("/", "\\/")));
  }
  assert.match(serverValidation, /Array\.from\(\{ length: 5 \}[\s\S]*?`\/img\/default_cover\/coverimg\$\{index \+ 1\}\.png`/);

  let thumbnailBytes = 0;
  for (const relativePath of defaultCoverThumbnailPaths) {
    const info = await stat(new URL(`../${relativePath}`, import.meta.url));
    const bytes = await readFile(new URL(`../${relativePath}`, import.meta.url));
    thumbnailBytes += info.size;
    assert.ok(info.isFile() && info.size > 8 && info.size < 100 * 1024);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
    const publicPath = `/${relativePath.replace(/^public\//, "")}`;
    assert.match(html, new RegExp(`data-cover-preview-src="${publicPath.replaceAll("/", "\\/")}"`));
  }
  assert.ok(thumbnailBytes < 500 * 1024);
  assert.doesNotMatch(html, /<img\s+src="\/img\/default_cover\/coverimg\d+\.png"/);
});

test("the page UI supports adding, replacing, removing, and repositioning covers", async () => {
  const [html, app, styles, translations] = await Promise.all([
    readSource("public/index.html"),
    readSource("public/app.js"),
    readSource("public/styles.css"),
    readSource("public/i18n.js")
  ]);

  assert.match(html, /id="page-cover-add-button"/);
  assert.match(html, /id="page-cover-change-button"/);
  assert.match(html, /id="page-cover-remove-button"/);
  assert.match(html, /id="page-cover-position-x"[^>]*type="range"/);
  assert.match(html, /id="page-cover-position-y"[^>]*type="range"/);
  assert.match(html, /id="page-cover-custom-input"[^>]*accept="image\/png,image\/jpeg,image\/webp"/);

  assert.match(app, /prepareCustomCoverDataUrl\(file\)/);
  assert.match(app, /canvasToBlob\(canvas, "image\/webp", quality\)/);
  assert.match(app, /\{ coverUrl: null, coverPositionX: 50, coverPositionY: 50 \}/);
  assert.match(app, /\{ coverPositionX: x, coverPositionY: y \}/);
  assert.match(app, /style\.objectPosition = `\$\{positionX\}% \$\{positionY\}%`/);
  assert.match(app, /setPointerCapture\(event\.pointerId\)/);
  assert.match(app, /hydratePageCoverPreviews\(\)/);
  assert.match(app, /createPageCoverOperationGuard\(\)/);

  assert.match(styles, /\.page-cover-image\s*\{[\s\S]*?object-fit:\s*cover;[\s\S]*?object-position:\s*50% 50%;/);
  assert.match(styles, /\.page-cover\.is-repositioning \.page-cover-image/);
  assert.match(styles, /body\.app-mode:not\(\.pdf-export-mode\) \.page-view\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(styles, /body\.app-mode:not\(\.pdf-export-mode\) \.page-view > :not\(\.page-cover\)\s*\{[\s\S]*?width:\s*min\(100%, 960px\);[\s\S]*?margin-inline:\s*auto;/);
  assert.match(styles, /body\.app-mode:not\(\.pdf-export-mode\) \.page-cover\s*\{[\s\S]*?width:\s*auto;[\s\S]*?margin-inline:\s*calc\(0px - var\(--main-inline-padding\)\);[\s\S]*?border-radius:\s*0;/);
  assert.match(translations, /removeConfirm:\s*"Remove this page cover\?/);
  assert.match(translations, /removeConfirm:\s*"이 페이지의 커버를 삭제할까요\?/);
});

test("cover persistence, validation, migration, history, and backup paths remain connected", async () => {
  const [migration, routes, coverValidation, mapper, pageAccess, domain, transfer, history, collaborationRoutes] = await Promise.all([
    readSource("migrations/035_page_covers.sql"),
    readSource("src/routes/page.routes.ts"),
    readSource("src/lib/page-cover.ts"),
    readSource("src/lib/mappers.ts"),
    readSource("src/lib/page-access.ts"),
    readSource("src/types/domain.ts"),
    readSource("src/lib/data-transfer.ts"),
    readSource("src/lib/page-version-history.ts"),
    readSource("src/routes/collaboration.routes.ts")
  ]);

  assert.match(migration, /MODIFY COLUMN cover_url MEDIUMTEXT NULL/);
  assert.match(migration, /cover_position_x TINYINT UNSIGNED NOT NULL DEFAULT 50/);
  assert.match(migration, /cover_position_y TINYINT UNSIGNED NOT NULL DEFAULT 50/);

  assert.match(routes, /coverUrl: pageCoverUrlSchema\.nullable\(\)\.optional\(\)/);
  assert.match(routes, /coverPositionX: pageCoverPositionSchema\.optional\(\)/);
  assert.match(routes, /coverPositionY: pageCoverPositionSchema\.optional\(\)/);
  assert.match(routes, /fields\.push\("cover_url = \?"\)/);
  assert.match(routes, /fields\.push\("cover_position_x = \?"\)/);
  assert.match(routes, /fields\.push\("cover_position_y = \?"\)/);
  assert.match(routes, /pageRouter\.get\("\/:pageId\/cover"/);
  assert.match(routes, /inspectCustomCoverDataUrl\(row\.cover_url\)/);

  assert.match(coverValidation, /maxCustomCoverImageBytes = 2 \* 1024 \* 1024/);
  assert.ok(coverValidation.includes('new Set(["image/png", "image/jpeg", "image/webp"])'));
  assert.match(coverValidation, /hasExpectedSignature/);
  assert.match(coverValidation, /createHash\("sha256"\)/);

  assert.match(domain, /cover_position_x: number/);
  assert.match(domain, /cover_position_y: number/);
  assert.match(mapper, /toPublicPageCoverUrl\(row\.id, row\.cover_url/);
  assert.match(mapper, /coverPositionX:/);
  assert.match(mapper, /coverPositionY:/);
  assert.match(coverValidation, /storedCustomPageCoverSentinel = "custom-image:stored"/);
  assert.match(pageAccess, /storedCustomPageCoverSentinel/);
  assert.match(pageAccess, /CASE WHEN .*cover_url.*LIKE 'data:image\/%;base64,%'/);

  assert.match(transfer, /CASE WHEN cover_url LIKE 'data:image\/%;base64,%' THEN \? ELSE cover_url END AS cover_url/);
  assert.match(transfer, /pageCovers: pageCoverFiles\.map/);
  assert.match(transfer, /page\.cover_position_x \?\? 50, page\.cover_position_y \?\? 50/);
  assert.match(history, /describePageCoverUrlForHistory\(page\.cover_url\)/);
  assert.match(history, /coverPositionX/);
  assert.match(history, /coverPositionY/);
  assert.match(collaborationRoutes, /const versionBeforePage = await client\.queryOne<PageRow>/);
  assert.match(collaborationRoutes, /SELECT \* FROM pages WHERE id = \?/);
});
