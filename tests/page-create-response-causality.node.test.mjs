import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("page creation materializes its acknowledgement before the transaction releases owner state", async () => {
  const route = (await readFile(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const createRoute = section(route, 'pageRouter.post("/",', 'pageRouter.get("/:pageId/cover"');

  const transactionIndex = createRoute.indexOf("const page = await transaction");
  const transactionEnd = createRoute.indexOf("\n    });", transactionIndex);
  const replayResponseIndex = createRoute.indexOf(
    "return getPageResponse(assessment.pageId, user.id, client);"
  );
  const freshResponseIndex = createRoute.indexOf("return getPageResponse(id, user.id, client);");
  const sendIndex = createRoute.indexOf("res.status(201).json({ page });");

  assert.ok(transactionIndex >= 0, "page creation must remain transactional");
  assert.ok(replayResponseIndex > transactionIndex && replayResponseIndex < transactionEnd);
  assert.ok(freshResponseIndex > replayResponseIndex && freshResponseIndex < transactionEnd);
  assert.ok(sendIndex > transactionEnd, "the already-materialized response should be sent after COMMIT");
  assert.doesNotMatch(
    createRoute.slice(transactionEnd),
    /await getPageResponse\(/,
    "a committed page create must not perform a causally unbound response read"
  );
});

test("reproduction: a post-COMMIT read can borrow a later writer or turn success into a false 404", () => {
  function vulnerable(interleaving) {
    let stored = { id: "pag-a", title: "Created", version: 1 };
    const committed = true;

    interleaving({
      edit(title) {
        stored = stored ? { ...stored, title, version: stored.version + 1 } : stored;
      },
      remove() {
        stored = null;
      }
    });

    return { committed, response: stored ? { ...stored } : null };
  }

  function fixed(interleaving) {
    let stored = { id: "pag-a", title: "Created", version: 1 };
    const lockedAcknowledgement = { ...stored };
    const committed = true;

    interleaving({
      edit(title) {
        stored = stored ? { ...stored, title, version: stored.version + 1 } : stored;
      },
      remove() {
        stored = null;
      }
    });

    return { committed, response: lockedAcknowledgement, current: stored };
  }

  assert.deepEqual(vulnerable(({ edit }) => edit("Other session")), {
    committed: true,
    response: { id: "pag-a", title: "Other session", version: 2 }
  });
  assert.deepEqual(vulnerable(({ remove }) => remove()), {
    committed: true,
    response: null
  });

  assert.deepEqual(fixed(({ edit }) => edit("Other session")), {
    committed: true,
    response: { id: "pag-a", title: "Created", version: 1 },
    current: { id: "pag-a", title: "Other session", version: 2 }
  });
  assert.deepEqual(fixed(({ remove }) => remove()), {
    committed: true,
    response: { id: "pag-a", title: "Created", version: 1 },
    current: null
  });
});
