import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const worker = fileURLToPath(new URL("./fixtures/backup-manifest-memory-worker.mjs", import.meta.url));
for (const [section, count] of [
  ["pageVersions", 200_000], ["pageVersions", 50_000], ["pageComments", 200_000],
  ["pageTags", 100_000], ["customIconPublications", 200_000], ["customIconLibraryRemovals", 50_000],
  ["pageVersionActors", 99_990], ["pageVersionChanges", 99_990]
]) {
  test(`backup ${section} (${count} invalid rows) stays within a 128 MiB V8 heap`, { timeout: 30_000 }, async (context) => {
    const { stdout } = await run(process.execPath, ["--max-old-space-size=128", "--import=tsx", worker, section, String(count)], {
      timeout: 25_000, maxBuffer: 64 * 1024,
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "mariadb://report:unused@127.0.0.1:1/report" }
    });
    const result = JSON.parse(stdout.trim());
    assert.ok([400, 413].includes(result.status));
    assert.ok(result.responseBytes < 1024, JSON.stringify(result));
    context.diagnostic(JSON.stringify(result));
  });
}
