import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs
  .readFileSync(path.join(here, "../src/routes/page.routes.ts"), "utf8")
  .replace(/\r\n/g, "\n");

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return text.slice(startIndex, endIndex);
}

test("permanent page deletion fails closed at the final owner-scoped delete sink", () => {
  const deleteRoute = section(
    source,
    'pageRouter.delete(\n  "/:pageId"',
    'pageRouter.put("/:pageId/tags"'
  );

  const executeIndex = deleteRoute.indexOf(
    "const deleteResult = await client.execute<{ affectedRows: number }>"
  );
  const deleteIndex = deleteRoute.indexOf(
    '"DELETE FROM pages WHERE id = ? AND owner_id = ?"',
    executeIndex
  );
  assert.ok(executeIndex >= 0, "hard delete must verify the database mutation result");
  assert.ok(deleteIndex > executeIndex, "hard delete must remain scoped to page id and owner id");

  const receiptIndex = deleteRoute.indexOf("INSERT INTO page_delete_mutations", deleteIndex);
  assert.ok(receiptIndex > deleteIndex, "success receipt must follow relational deletion");

  const sink = deleteRoute.slice(executeIndex, receiptIndex);
  assert.match(sink, /const deleteResult = await client\.execute<\{ affectedRows: number \}>/);
  assert.match(sink, /Number\(deleteResult\.affectedRows\) !== 1/);
  assert.match(sink, /PAGE_EDIT_CONFLICT/);
});

test("reproduction model: a zero-row final delete cannot commit a partial subtree plus success receipt", () => {
  function reproduce({ fixed }) {
    const originalPages = new Set(["leaf", "root"]);
    let pages = new Set(originalPages);
    let receipt = false;

    try {
      // The snapshot/lock phase expects both rows. Model a storage/trigger anomaly
      // where the leaf delete succeeds but the root DELETE reports zero rows.
      for (const id of ["leaf", "root"]) {
        const affectedRows = id === "leaf" ? 1 : 0;
        if (affectedRows === 1) pages.delete(id);
        if (fixed && affectedRows !== 1) {
          throw new Error("PAGE_EDIT_CONFLICT");
        }
      }
      receipt = true;
    } catch {
      // A real SQL transaction rolls the earlier leaf delete back.
      pages = new Set(originalPages);
      receipt = false;
    }

    return { pages: [...pages].sort(), receipt };
  }

  assert.deepEqual(reproduce({ fixed: false }), {
    pages: ["root"],
    receipt: true
  });
  assert.deepEqual(reproduce({ fixed: true }), {
    pages: ["leaf", "root"],
    receipt: false
  });
});
