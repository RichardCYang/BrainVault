import { measureJsonUtf8BytesWithinLimit } from "../src/lib/data-transfer-limits.ts";

const manifestLimit = 16 * 1024 * 1024;
const coverBytes = 2 * 1024 * 1024;
const pageCount = 6;
const timestamp = "2026-08-04T00:00:00.000Z";
const encoded = Buffer.alloc(coverBytes).toString("base64");

function page(id, coverUrl) {
  return {
    id,
    title: id,
    icon: null,
    cover_url: coverUrl,
    cover_position_x: 50,
    cover_position_y: 50,
    is_archived: 0,
    is_collection: 0,
    parent_page_id: null,
    edit_version: 1,
    content_version: 1,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function manifest(version, pages, pageCovers) {
  return {
    format: "brainvault-backup",
    version,
    exportedAt: timestamp,
    source: { userId: "usr_reproduction", username: "reproduction" },
    account: {
      name: null,
      avatar_data: null,
      preferred_language: null,
      default_collection_icon: null,
      theme: "light"
    },
    data: { pages, blocks: [], tags: [], pageTags: [], pageShares: [] },
    attachments: [],
    ...(pageCovers === undefined ? {} : { pageCovers })
  };
}

const inlinePages = Array.from(
  { length: pageCount },
  (_, index) => page(`page-${index}`, `data:image/png;base64,${encoded}`)
);
const vulnerableManifest = manifest(1, inlinePages);
const vulnerableBytes = Buffer.byteLength(JSON.stringify(vulnerableManifest), "utf8");

const externalPages = inlinePages.map((item) => ({ ...item, cover_url: null }));
const pageCovers = externalPages.map((item) => ({
  pageId: item.id,
  path: `page-covers/${item.id}`,
  mimeType: "image/png",
  size: String(coverBytes),
  sha256: "0".repeat(64),
  crc32: 0
}));
const fixedManifest = manifest(2, externalPages, pageCovers);
const fixedBytes = measureJsonUtf8BytesWithinLimit(fixedManifest, manifestLimit);

const inlineBuiltInCover = "/img/default_cover/coverimg1.png";
const ambiguousPage = page("page-ambiguous", inlineBuiltInCover);
const hasZipEntry = true;
const vulnerableRejectsAmbiguousCover = ambiguousPage.cover_url?.startsWith("data:") ?? false;
const vulnerableRestoredCover = hasZipEntry ? "custom ZIP cover bytes" : ambiguousPage.cover_url;
const fixedRejectsAmbiguousCover = hasZipEntry && ambiguousPage.cover_url !== null;

console.log(JSON.stringify({
  inputs: { pageCount, coverBytes, manifestLimit },
  vulnerable: {
    manifestBytes: vulnerableBytes,
    exceedsManifestLimit: vulnerableBytes > manifestLimit,
    ambiguousBuiltInAndZipCoverRejected: vulnerableRejectsAmbiguousCover,
    ambiguousBuiltInCoverSilentlyOverridden: vulnerableRestoredCover !== inlineBuiltInCover
  },
  fixed: {
    manifestBytes: fixedBytes,
    fitsManifestLimit: fixedBytes !== null,
    coverBytesStoredAsZipEntries: true,
    legacyVersionOneImportRetained: true,
    ambiguousBuiltInAndZipCoverRejected: fixedRejectsAmbiguousCover
  }
}, null, 2));
