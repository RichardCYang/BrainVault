import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLatestWriteQueue } from "../public/save-queue.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("page-title and block autosave pin request expectedVersion across ambiguous retries", async () => {
  const client = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  const titleQueue = sliceBetween(
    client,
    "const pageTitleSaveQueue = createLatestWriteQueue",
    "async function downloadAttachment"
  );
  assert.match(
    titleQueue,
    /if \(task\.requestExpectedVersion === undefined\) \{\s*task\.requestExpectedVersion = getLatestKnownVersion\(/
  );
  assert.match(titleQueue, /const expectedVersion = task\.requestExpectedVersion;/);
  assert.doesNotMatch(
    titleQueue,
    /const expectedVersion = getLatestKnownVersion\(/
  );

  const blockQueue = sliceBetween(
    client,
    "function getBlockSaveQueue",
    "function scheduleBlockSave"
  );
  assert.match(
    blockQueue,
    /if \(task\.requestExpectedVersion === undefined\) \{\s*task\.requestExpectedVersion = getLatestKnownVersion\(/
  );
  assert.match(blockQueue, /const currentVersion = task\.requestExpectedVersion;/);
  assert.doesNotMatch(
    blockQueue,
    /const currentVersion = getLatestKnownVersion\(/
  );
});


test("pinning happens at writer admission so a queued edit still inherits the prior acknowledgement", async () => {
  let releaseFirst;
  const firstBarrier = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let canonicalVersion = 5;
  const seenExpectedVersions = [];

  const queue = createLatestWriteQueue(async (task) => {
    if (task.requestExpectedVersion === undefined) {
      task.requestExpectedVersion = canonicalVersion;
    }
    seenExpectedVersions.push(task.requestExpectedVersion);
    if (task.id === "first") await firstBarrier;
    canonicalVersion += 1;
    return canonicalVersion;
  }, { shouldRetry: () => false });

  const first = { id: "first" };
  const second = { id: "second" };
  const saving = queue.enqueue(first);
  queue.enqueue(second);

  await Promise.resolve();
  assert.equal(first.requestExpectedVersion, 5);
  assert.equal(second.requestExpectedVersion, undefined);

  releaseFirst();
  await saving;

  assert.deepEqual(seenExpectedVersions, [5, 6]);
  assert.equal(second.requestExpectedVersion, 6);
});

test("retry reproduction preserves exact replay and rejects stale overwrite after the fix", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-autosave-retry-version-donation.mjs", import.meta.url))],
    { encoding: "utf8" }
  );
  const result = JSON.parse(stdout);

  assert.equal(result.duplicateAfterCanonicalRefresh.vulnerable.retryKind, "committed");
  assert.equal(result.duplicateAfterCanonicalRefresh.fixed.retryKind, "replay");

  assert.equal(result.staleOverwriteAfterNewerWrite.vulnerable.finalValue, "local edit");
  assert.equal(result.staleOverwriteAfterNewerWrite.fixed.retryKind, "conflict");
  assert.equal(
    result.staleOverwriteAfterNewerWrite.fixed.finalValue,
    "newer canonical edit"
  );
});
