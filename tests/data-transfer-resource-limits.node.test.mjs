import assert from "node:assert/strict";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DataImportAdmissionGate } from "../src/lib/data-import-admission.ts";
import { dataTransferResourceLimits, measureJsonUtf8BytesWithinLimit } from "../src/lib/data-transfer-limits.ts";
import { crc32, readZipDirectory, readZipEntryBuffer, ZipWriter } from "../src/lib/zip.ts";

const root = new URL("../", import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), "utf8").replace(/\r\n/g, "\n");

test("backup manifest byte measurement rejects oversized JSON before aggregate serialization", () => {
  const sample = {
    format: "brainvault-backup",
    strings: ["ASCII", "한글", "line\nbreak", "quote\"slash\\"],
    omitted: undefined,
    nested: { valid: true, finite: 42, nonFinite: Number.POSITIVE_INFINITY }
  };
  const expected = Buffer.byteLength(JSON.stringify(sample), "utf8");

  assert.equal(measureJsonUtf8BytesWithinLimit(sample, expected), expected);
  assert.equal(measureJsonUtf8BytesWithinLimit(sample, expected - 1), null);
  assert.equal(measureJsonUtf8BytesWithinLimit([undefined], 6), 6);
  assert.throws(() => measureJsonUtf8BytesWithinLimit(sample, -1), /non-negative safe integer/);
});

test("data-import admission allows one operation per principal and caps server concurrency", () => {
  const gate = new DataImportAdmissionGate(2);
  assert.deepEqual(gate.tryAcquire("user-a"), { accepted: true });
  assert.deepEqual(gate.tryAcquire("user-a"), { accepted: false, reason: "principal-active" });
  assert.deepEqual(gate.tryAcquire("user-b"), { accepted: true });
  assert.deepEqual(gate.tryAcquire("user-c"), { accepted: false, reason: "server-capacity" });
  assert.equal(gate.activeCount, 2);
  gate.release("user-a");
  assert.deepEqual(gate.tryAcquire("user-c"), { accepted: true });
  gate.release("user-a");
  assert.equal(gate.activeCount, 2);
});

test("backup ZIP parsing honors caller-specific entry and central-directory ceilings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brainvault-data-limits-"));
  const zipPath = join(directory, "two-entries.zip");
  const output = createWriteStream(zipPath, { flags: "wx", mode: 0o600 });
  const writer = new ZipWriter(output);
  for (const [name, data] of [["one", Buffer.from("1")], ["two", Buffer.from("2")]]) {
    await writer.add({ name, size: BigInt(data.length), crc32: crc32(data), source: { kind: "buffer", data } });
  }
  await writer.finalize();
  output.end();
  await once(output, "finish");

  try {
    await assert.rejects(readZipDirectory(zipPath, { maxEntries: 1 }), /too many entries/);
    await assert.rejects(readZipDirectory(zipPath, { maxCentralDirectoryBytes: 1 }), /central directory is too large/);
    const entries = await readZipDirectory(zipPath, { maxEntries: 2, maxCentralDirectoryBytes: 1024 });
    assert.equal(entries.length, 2);
    await assert.rejects(readZipEntryBuffer(zipPath, entries[1], 0), /exceeds the allowed size/);

    const malformed = await readFile(zipPath);
    malformed.writeUInt16LE(malformed.readUInt16LE(26) + 1, 26);
    await writeFile(zipPath, malformed);
    await assert.rejects(
      readZipDirectory(zipPath, { maxEntries: 2, maxCentralDirectoryBytes: 1024 }),
      /name length does not match/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup route and manifest limits are applied before expensive import work", () => {
  const envSource = read("src/config/env.ts");
  const routeSource = read("src/routes/data.routes.ts");
  const middlewareSource = read("src/middleware/data-rate-limit.ts");
  const transferSource = read("src/lib/data-transfer.ts");

  assert.match(envSource, /DATA_TRANSFER_MAX_SIZE_MB:[^\n]+max\(16_384\)\.default\(1024\)/);
  assert.match(envSource, /DATA_TRANSFER_MAX_MANIFEST_SIZE_MB:[^\n]+max\(64\)\.default\(16\)/);
  assert.match(envSource, /DATA_IMPORT_MAX:[^\n]+default\(3\)/);
  assert.match(envSource, /DATA_IMPORT_MAX_CONCURRENT:[^\n]+default\(2\)/);
  assert.match(
    routeSource,
    /"\/import",\s*dataImportRateLimit,\s*enforceBackupUploadRequestSize,\s*dataImportConcurrencyLimit,\s*backupUpload\.single\("backup"\)/
  );
  assert.ok(middlewareSource.includes("DATA_IMPORT_RATE_LIMITED"));
  assert.ok(middlewareSource.includes("DATA_IMPORT_IN_PROGRESS"));
  assert.ok(middlewareSource.includes("DATA_IMPORT_BUSY"));
  assert.ok(transferSource.includes("DATA_TRANSFER_MAX_MANIFEST_SIZE_MB * 1024 * 1024"));
  assert.ok(transferSource.includes("measureJsonUtf8BytesWithinLimit(manifest, maxManifestBytes - 1)"));
  assert.ok(transferSource.includes("manifestEntry.uncompressedSize > BigInt(maxManifestBytes)"));
  assert.ok(transferSource.includes("maxCentralDirectoryBytes: dataTransferResourceLimits.maxCentralDirectoryBytes"));
  assert.ok(transferSource.includes("maxEntries: dataTransferResourceLimits.maxZipEntries"));
  assert.ok(transferSource.includes("if (error instanceof ApiError) throw error"));
  const importSource = transferSource.slice(transferSource.indexOf("export async function importUserDataBackup"));
  assert.ok(importSource.indexOf("readZipDirectory(zipPath") < importSource.indexOf("const initialWorkspaceSnapshot"));
  assert.ok(
    dataTransferResourceLimits.maxAttachments
      + dataTransferResourceLimits.maxPageCovers
      + 1
      === dataTransferResourceLimits.maxZipEntries
  );
  assert.ok(dataTransferResourceLimits.maxCentralDirectoryBytes <= 4 * 1024 * 1024);
});
