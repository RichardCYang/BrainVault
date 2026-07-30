import assert from "node:assert/strict";
import http from "node:http";
import { Writable } from "node:stream";
import { calculateZipArchiveSize, crc32, ZipWriter } from "../src/lib/zip.ts";

function collectingWritable() {
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  return { output, chunks };
}

const manifest = Buffer.from('{"format":"brainvault-backup","version":1}\n', "utf8");
const attachment = Buffer.from("recovery-critical attachment bytes", "utf8");
const entries = [
  { name: "brainvault-backup.json", size: BigInt(manifest.length), crc32: crc32(manifest), source: { kind: "buffer", data: manifest } },
  { name: "attachments/block_demo", size: BigInt(attachment.length), crc32: crc32(attachment), source: { kind: "buffer", data: attachment } }
];

const measuredSize = calculateZipArchiveSize(entries);
const { output, chunks } = collectingWritable();
const writer = new ZipWriter(output);
for (const entry of entries) await writer.add(entry);
await writer.finalize();
const archive = Buffer.concat(chunks);
assert.equal(BigInt(archive.length), measuredSize);

const truncationBytes = 17;
const truncated = archive.subarray(0, archive.length - truncationBytes);
const server = http.createServer((request, response) => {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/zip");
  if (request.url === "/fixed") response.setHeader("Content-Length", archive.length.toString());
  response.end(truncated);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const address = server.address();
assert(address && typeof address === "object");
let vulnerableAcceptedBytes = null;
let fixedReadRejected = false;
let fixedReadError = null;
try {
  const vulnerableResponse = await fetch(`http://127.0.0.1:${address.port}/vulnerable`);
  vulnerableAcceptedBytes = (await vulnerableResponse.arrayBuffer()).byteLength;

  try {
    const fixedResponse = await fetch(`http://127.0.0.1:${address.port}/fixed`);
    await fixedResponse.arrayBuffer();
  } catch (error) {
    fixedReadRejected = true;
    fixedReadError = error instanceof Error ? error.message : String(error);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

assert.equal(vulnerableAcceptedBytes, truncated.length);
assert.equal(fixedReadRejected, true);

console.log(JSON.stringify({
  vulnerable: {
    declaredArchiveLength: false,
    expectedArchiveBytes: archive.length,
    receivedArchiveBytes: vulnerableAcceptedBytes,
    truncatedBytesAcceptedAsComplete: vulnerableAcceptedBytes === truncated.length,
    unusableBackupFalseSuccessReproduced: vulnerableAcceptedBytes < archive.length
  },
  fixed: {
    exactArchiveLengthCalculated: measuredSize === BigInt(archive.length),
    declaredArchiveLength: archive.length,
    truncatedTransferRejected: fixedReadRejected,
    readError: fixedReadError,
    unusableBackupFalseSuccessClosed: fixedReadRejected
  }
}, null, 2));
