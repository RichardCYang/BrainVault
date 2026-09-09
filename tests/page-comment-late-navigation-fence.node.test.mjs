import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

function section(startNeedle, endNeedle) {
  const start = appSource.indexOf(startNeedle);
  const end = appSource.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return appSource.slice(start, end);
}

async function simulateCommentDispatch({ guarded }) {
  let current = true;
  let dispatched = false;
  let releasePreflight;
  const preflight = new Promise((resolve) => {
    releasePreflight = resolve;
  });

  const request = (async () => {
    await preflight;
    if (guarded && !current) return false;
    dispatched = true;
    return true;
  })();

  current = false;
  releasePreflight();
  await request;
  return dispatched;
}

test("reproduction: an unguarded comment delete can dispatch after navigation during request preflight", async () => {
  assert.equal(await simulateCommentDispatch({ guarded: false }), true);
  assert.equal(await simulateCommentDispatch({ guarded: true }), false);
});

test("comment create, edit, and delete revalidate page context at the fetch dispatch boundary", () => {
  const cases = [
    section("async function submitPageComment()", "\nasync function savePageCommentEdit"),
    section("async function savePageCommentEdit", "\nasync function deletePageComment"),
    section("async function deletePageComment", "\nfunction setSharePageMessage")
  ];

  for (const source of cases) {
    assert.match(
      source,
      /const isCommentMutationCurrent = \(\) => \([\s\S]*?isCurrentAuthenticatedSessionScope\(authenticationScope\)[\s\S]*?isCurrentPageCommentsContext\(pageId, navigationGeneration\)[\s\S]*?\);/,
      "each comment mutation must bind intent to the initiating auth and page-navigation context"
    );
    assert.match(
      source,
      /beforeFetch: isCommentMutationCurrent/,
      "api dispatch must be fenced after async network verification and before fetch"
    );
    assert.match(
      source,
      /data === skippedApiRequest \|\| !isCommentMutationCurrent\(\)/,
      "skipped requests and stale responses must not update the current page comment state"
    );
  }
});
