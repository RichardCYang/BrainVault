import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const MERMAID_VERSION = "11.17.2";
export const MERMAID_PACKAGE_URL = `https://registry.npmjs.org/mermaid/-/mermaid-${MERMAID_VERSION}.tgz`;
export const MERMAID_PACKAGE_INTEGRITY =
  "sha512-V6K3C8EBdEsPFZXSKMJe6ppQOENxuHARr9GvHX4hh47lAbhMRD9qf4oEK7LoaRQxULMa80/qt5gHO73aCleBBg==";

const maxCompressedBytes = 32 * 1024 * 1024;
const maxUncompressedBytes = 160 * 1024 * 1024;
const targetEntries = new Map([
  ["package/dist/mermaid.min.js", "mermaid.min.js"],
  ["package/LICENSE", "LICENSE"]
]);

function parseTarOctal(field, label) {
  const value = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid tar ${label}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid tar ${label}`);
  return parsed;
}

function tarPath(header) {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  return prefix ? `${prefix}/${name}` : name;
}

function assertTarHeaderChecksum(header) {
  const expected = parseTarOctal(header.subarray(148, 156), "header checksum");
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  let actual = 0;
  for (const byte of copy) actual += byte;
  if (actual !== expected) throw new Error("Mermaid package tar header checksum mismatch");
}

function extractApprovedFiles(tar) {
  const extracted = new Map();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    assertTarHeaderChecksum(header);

    const entryPath = tarPath(header);
    const size = parseTarOctal(header.subarray(124, 136), "entry size");
    const typeFlag = String.fromCharCode(header[156] || 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("Mermaid package tar entry is truncated");

    const outputName = targetEntries.get(entryPath);
    if (outputName) {
      if (typeFlag !== "\0" && typeFlag !== "0") {
        throw new Error(`Approved Mermaid package entry is not a regular file: ${entryPath}`);
      }
      if (extracted.has(outputName)) {
        throw new Error(`Duplicate Mermaid package entry: ${entryPath}`);
      }
      extracted.set(outputName, Buffer.from(tar.subarray(dataStart, dataEnd)));
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  for (const outputName of targetEntries.values()) {
    if (!extracted.has(outputName)) throw new Error(`Missing approved Mermaid package entry: ${outputName}`);
  }
  return extracted;
}

async function fetchTarball() {
  const localTarball = process.env.BRAINVAULT_MERMAID_TARBALL?.trim();
  if (localTarball) return readFile(localTarball);

  const response = await fetch(MERMAID_PACKAGE_URL, {
    redirect: "follow",
    headers: { "user-agent": "BrainVault-Mermaid-Vendor/1" }
  });
  if (!response.ok) throw new Error(`Failed to fetch Mermaid ${MERMAID_VERSION}: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxCompressedBytes) throw new Error("Mermaid package exceeds the compressed-size limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxCompressedBytes) throw new Error("Mermaid package exceeds the compressed-size limit");
  return bytes;
}

function verifyPackageIntegrity(tarball) {
  const [algorithm, expected] = MERMAID_PACKAGE_INTEGRITY.split("-", 2);
  const actual = createHash(algorithm).update(tarball).digest("base64");
  if (actual !== expected) {
    throw new Error(`Mermaid ${MERMAID_VERSION} package integrity verification failed`);
  }
}

async function main() {
  const tarball = await fetchTarball();
  verifyPackageIntegrity(tarball);
  const tar = gunzipSync(tarball, { maxOutputLength: maxUncompressedBytes });
  const extracted = extractApprovedFiles(tar);

  const vendorParent = path.resolve("public", "vendor", "mermaid");
  const outputDir = path.join(vendorParent, MERMAID_VERSION);
  await mkdir(vendorParent, { recursive: true });
  // Stage beside the final path so the final rename stays on one filesystem and
  // a failed fetch/extract cannot replace a previously verified artifact.
  const stagingDir = await mkdtemp(path.join(vendorParent, ".staging-"));
  try {
    for (const [outputName, bytes] of extracted) {
      await writeFile(path.join(stagingDir, outputName), bytes, { mode: 0o644 });
    }
    await rm(outputDir, { recursive: true, force: true });
    await rename(stagingDir, outputDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  console.log(`Vendored Mermaid ${MERMAID_VERSION} from an integrity-verified npm package.`);
}

await main();
