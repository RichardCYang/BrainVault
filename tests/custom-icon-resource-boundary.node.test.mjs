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
  assert.match(customIconRoutes, /parts: 1/);
  assert.match(customIconRoutes, /fieldNestingDepth: 1/);
  assert.match(customIconRoutes, /headerPairs: 32/);
});
