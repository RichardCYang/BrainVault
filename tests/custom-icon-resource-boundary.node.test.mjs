import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assessCustomIconStorageLimit } from "../src/lib/custom-icon-storage-limit.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8").replace(/\r\n/g, "\n");

test("custom icon quotas use overflow-safe byte and file-count accounting", () => {
  assert.deepEqual(
    assessCustomIconStorageLimit(63n * 1024n * 1024n, 1024n * 1024n, 2_047, 1, 64n * 1024n * 1024n, 2_048),
    { accepted: true, nextBytes: 64n * 1024n * 1024n, nextFiles: 2_048 }
  );
  assert.deepEqual(
    assessCustomIconStorageLimit(64n * 1024n * 1024n, 1n, 0, 1, 64n * 1024n * 1024n, 2_048),
    { accepted: false, reason: "quota-exceeded" }
  );
  assert.deepEqual(
    assessCustomIconStorageLimit(0n, 1n, 2_048, 1, 64n * 1024n * 1024n, 2_048),
    { accepted: false, reason: "file-count-exceeded" }
  );
  assert.deepEqual(
    assessCustomIconStorageLimit(2n ** 100n, 1n, 0, 1, 2n ** 100n, 2_048),
    { accepted: false, reason: "quota-exceeded" }
  );
  assert.throws(
    () => assessCustomIconStorageLimit(0n, 0n, 0.5, 1, 1n, 1),
    /safe integer/
  );
});

test("new icon mutations reject inline image data while legacy reads remain compatible", () => {
  const iconValues = read("src/lib/icon-value.ts");
  const pageRoutes = read("src/routes/page.routes.ts");
  const authRoutes = read("src/routes/auth.routes.ts");
  const dataTransfer = read("src/lib/data-transfer.ts");

  assert.match(iconValues, /export const iconValueSchema =/);
  assert.match(iconValues, /export const iconMutationValueSchema = iconValueSchema\.refine/);
  assert.match(iconValues, /!isInlineImageIconValue\(value\)/);
  assert.match(pageRoutes, /icon: iconMutationValueSchema\.optional\(\)/);
  assert.match(pageRoutes, /icon: iconMutationValueSchema\.nullable\(\)\.optional\(\)/);
  assert.match(authRoutes, /defaultCollectionIcon: iconMutationValueSchema\.nullable\(\)\.optional\(\)/);
  assert.match(dataTransfer, /icon: iconValueSchema\.nullable\(\)/);
});

test("custom icon uploads and backup restores enforce the same durable resource boundary", () => {
  const customIcons = read("src/lib/custom-icons.ts");
  const customIconRoutes = read("src/routes/custom-icon.routes.ts");
  const dataTransfer = read("src/lib/data-transfer.ts");
  const envSource = read("src/config/env.ts");

  assert.match(envSource, /CUSTOM_ICON_STORAGE_MAX_MB/);
  assert.match(envSource, /CUSTOM_ICON_STORAGE_MAX_FILES/);
  assert.match(customIcons, /getCustomIconStorageUsage\(safeUserId\)/);
  assert.match(customIcons, /assertCustomIconStorageLimit\(usage\.bytes, BigInt\(bytes\.length\), usage\.files, 1\)/);
  assert.match(customIcons, /await writeFile\(filePath, bytes, \{ flag: "wx", mode: 0o600 \}\)/);
  assert.ok(
    customIcons.indexOf("assertCustomIconStorageLimit(usage.bytes") < customIcons.indexOf("await writeFile(filePath")
  );
  assert.match(dataTransfer, /const restoredCustomIconBytes =/);
  assert.match(dataTransfer, /assertCustomIconStorageLimit\([\s\S]*restoredCustomIconBytes/);
  // Busboy raises partsLimit when the allowed count is reached, so parts: 1 rejects the
  // endpoint's one legitimate file part. parts: 2 is the smallest safe sentinel while
  // files: 1 and fields: 0 continue to reject every additional file or form field.
  assert.match(customIconRoutes, /parts: 2/);
  assert.doesNotMatch(customIconRoutes, /parts: 1/);
  assert.match(customIconRoutes, /fieldNestingDepth: 1/);
  assert.match(customIconRoutes, /headerPairs: 32/);
});


test("custom icon reads require authentication, ownership or an exact shared-page reference, and private caching", async () => {
  const appSource = read("src/app.ts");
  const customIcons = read("src/lib/custom-icons.ts");
  const iconMountStart = appSource.indexOf('"/upload/icons"');
  const iconMountEnd = appSource.indexOf("app.use(express.static(publicDir", iconMountStart);
  const iconMount = appSource.slice(iconMountStart, iconMountEnd);

  assert.match(iconMount, /"\/upload\/icons",\s*requireAuth,/);
  assert.match(iconMount, /canUserReadCustomIcon\(userId, publicPath\)/);
  assert.match(iconMount, /setPrivateNoStoreCacheControl\(res\)/);
  assert.doesNotMatch(iconMount, /public, max-age=31536000, immutable/);
  assert.match(customIcons, /p\.owner_id = \?/);
  assert.match(customIcons, /INNER JOIN page_shares ps/);
  assert.match(customIcons, /JSON_SEARCH\(b\.metadata, 'one', \?, '#'\) IS NOT NULL/);

  process.env.NODE_ENV = "test";
  const { canUserReadCustomIcon } = await import("../src/lib/custom-icons.ts");
  let queryCount = 0;
  const fakeClient = {
    async queryOne(sql, params) {
      queryCount += 1;
      assert.match(sql, /p\.owner_id = \?/);
      assert.equal(params[0], "editor_1");
      assert.equal(params[1], "owner_1");
      assert.equal(params[2], "image:/upload/icons/owner_1/cicon_value_1.png");
      assert.equal(params[3], "image:/upload/icons/owner#_1/cicon#_value#_1.png");
      return { allowed: 1 };
    }
  };

  assert.equal(
    await canUserReadCustomIcon("owner_1", "/upload/icons/owner_1/cicon_value_1.png", fakeClient),
    true
  );
  assert.equal(queryCount, 0, "owners should not need a sharing lookup");
  assert.equal(
    await canUserReadCustomIcon("editor_1", "/upload/icons/owner_1/cicon_value_1.png", fakeClient),
    true
  );
  assert.equal(queryCount, 1);
  assert.equal(
    await canUserReadCustomIcon("editor_1", "/upload/icons/owner_1/not-an-icon.txt", fakeClient),
    false
  );
  assert.equal(queryCount, 1, "invalid paths must fail before database lookup");
});
