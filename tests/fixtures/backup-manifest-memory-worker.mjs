import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, ZipWriter } from "../../src/lib/zip.ts";

// Exercise the actual ZIP reader in an isolated, heap-limited process. No SQL
// operation or server credentials are needed to reach manifest validation.
const { readUserDataBackupManifest } = await import("../../src/lib/data-transfer.ts");
const { closeDb } = await import("../../src/lib/db.ts");
const section = process.argv[2] ?? "pageVersions";
const count = Number(process.argv[3] ?? 200_000);
const directory = await mkdtemp(join(tmpdir(), "brainvault-manifest-memory-"));
try {
  const manifest = {
    format: "brainvault-backup", version: 6, exportedAt: "2026-11-04T00:00:00.000Z",
    source: { userId: "usr_memory", username: "memory" },
    account: { name: null, avatar_data: null, preferred_language: null, default_collection_icon: null, theme: "light" },
    data: { pages: [], blocks: [], tags: [], pageTags: [], pageShares: [], collectionShares: [],
      pageComments: [], pageVersions: [], navigationCollapsedPageIds: [], navigationPageOrder: [] },
    attachments: [], retainedAttachments: [], pageCovers: [], customIcons: [], customIconLibraryRemovals: [], customIconPublications: []
  };
  const invalidRows = Array.from({ length: count }, () => ({}));
  if (section === "pageVersionActors" || section === "pageVersionChanges") {
    manifest.data.pageVersions.push({
      page_id: "page", revision: 1, page_edit_version: 1, page_content_version: 1,
      actors: section === "pageVersionActors" ? JSON.stringify(invalidRows) : "[]",
      source: "edit", change_count: 0,
      change_summary: JSON.stringify({ baseline: 0, pageCreated: 0, pageFields: [], blocksCreated: 0,
        blocksUpdated: 0, blocksDeleted: 0, blocksMoved: 0 }),
      changes: section === "pageVersionChanges" ? JSON.stringify(invalidRows) : "[]",
      created_at: "2026-11-04 00:00:00"
    });
  } else {
    const target = section.startsWith("custom") ? manifest : manifest.data;
    target[section] = invalidRows;
  }
  const data = Buffer.from(JSON.stringify(manifest));
  const zipPath = join(directory, "backup.zip");
  const output = createWriteStream(zipPath);
  const writer = new ZipWriter(output);
  await writer.add({ name: "brainvault-backup.json", size: BigInt(data.length), crc32: crc32(data), source: { kind: "buffer", data } });
  await writer.finalize();
  output.end();
  await once(output, "finish");
  const started = performance.now();
  try {
    await readUserDataBackupManifest(zipPath);
    throw new Error("Invalid manifest was accepted");
  } catch (error) {
    if (![400, 413].includes(error.statusCode)) throw error;
    const response = JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } });
    console.log(JSON.stringify({ section, count, manifestBytes: data.length, status: error.statusCode,
      responseBytes: Buffer.byteLength(response), elapsedMs: Math.round(performance.now() - started),
      maxRssKiB: process.resourceUsage().maxRSS }));
  }
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
