import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `section not found: ${startMarker}`);
  return source.slice(start, end);
}

test("block create/update relationship ids share the canonical route-id boundary", () => {
  const createAndUpdate = section("const createBlockSchema = z.object({", "const deleteBlockSchema = z");
  assert.doesNotMatch(createAndUpdate, /parentBlockId: z\.string/);
  assert.equal(
    (createAndUpdate.match(/parentBlockId: routeIdSchema\.nullable\(\)\.optional\(\)/g) ?? []).length,
    2
  );
  assert.match(createAndUpdate, /const versionSnapshotSchema = z\.object\(\{\s*id: routeIdSchema,/s);
});

test("multipart attachment parent ids reject non-string and non-canonical identifiers", () => {
  const attachment = section("const attachmentFormSchema = z.object({", "const maxAttachmentUploadBytes");
  assert.match(attachment, /if \(value === undefined \|\| value === null\) return null/);
  assert.match(attachment, /if \(typeof value !== "string"\) return value/);
  assert.match(attachment, /routeIdSchema\.nullable\(\)/);
  assert.doesNotMatch(attachment, /z\.string\(\)\.min\(1\)\.nullable\(\)/);
});
