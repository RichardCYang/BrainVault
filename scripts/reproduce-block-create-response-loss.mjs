import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createLegacyStore() {
  const blocks = [];
  const files = new Set();
  let sequence = 0;
  return {
    blocks,
    files,
    create(kind) {
      const id = `blk_${++sequence}`;
      blocks.push({ id, kind });
      if (kind === "ATTACHMENT") files.add(id);
      return id;
    }
  };
}

function createIdempotentStore() {
  const blocks = [];
  const files = new Set();
  const receipts = new Map();
  let sequence = 0;
  return {
    blocks,
    files,
    create(mutationId, request, kind) {
      const requestHash = hash(request);
      const existing = receipts.get(mutationId);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new Error("MUTATION_ID_REUSED");
        return existing.blockId;
      }
      const blockId = `blk_${++sequence}`;
      receipts.set(mutationId, { requestHash, blockId });
      blocks.push({ id: blockId, kind });
      if (kind === "ATTACHMENT") files.add(blockId);
      return blockId;
    }
  };
}

function loseResponseAfterCommit(create) {
  create();
  throw new Error("response connection lost after commit");
}

const ordinaryRequest = { kind: "BLOCK", pageId: "page_1", markdown: "" };
const attachmentRequest = {
  kind: "ATTACHMENT",
  pageId: "page_1",
  file: { name: "report.pdf", size: 7, sha256: "abc" }
};

const vulnerableBlocks = createLegacyStore();
try {
  loseResponseAfterCommit(() => vulnerableBlocks.create("BLOCK"));
} catch {}
vulnerableBlocks.create("BLOCK");

const fixedBlocks = createIdempotentStore();
let fixedBlockId;
try {
  loseResponseAfterCommit(() => {
    fixedBlockId = fixedBlocks.create("mut_block", ordinaryRequest, "BLOCK");
  });
} catch {}
const replayedBlockId = fixedBlocks.create("mut_block", ordinaryRequest, "BLOCK");

const vulnerableAttachments = createLegacyStore();
try {
  loseResponseAfterCommit(() => vulnerableAttachments.create("ATTACHMENT"));
} catch {}
vulnerableAttachments.create("ATTACHMENT");

const fixedAttachments = createIdempotentStore();
let fixedAttachmentId;
try {
  loseResponseAfterCommit(() => {
    fixedAttachmentId = fixedAttachments.create("mut_attachment", attachmentRequest, "ATTACHMENT");
  });
} catch {}
const replayedAttachmentId = fixedAttachments.create("mut_attachment", attachmentRequest, "ATTACHMENT");

assert.equal(vulnerableBlocks.blocks.length, 2);
assert.equal(fixedBlocks.blocks.length, 1);
assert.equal(replayedBlockId, fixedBlockId);
assert.equal(vulnerableAttachments.blocks.length, 2);
assert.equal(vulnerableAttachments.files.size, 2);
assert.equal(fixedAttachments.blocks.length, 1);
assert.equal(fixedAttachments.files.size, 1);
assert.equal(replayedAttachmentId, fixedAttachmentId);
assert.throws(
  () => fixedAttachments.create("mut_attachment", { ...attachmentRequest, file: { ...attachmentRequest.file, sha256: "changed" } }, "ATTACHMENT"),
  /MUTATION_ID_REUSED/
);

console.log(JSON.stringify({
  vulnerable: {
    ordinaryBlockCountAfterLostResponseRetry: vulnerableBlocks.blocks.length,
    attachmentBlockCountAfterLostResponseRetry: vulnerableAttachments.blocks.length,
    attachmentFileCountAfterLostResponseRetry: vulnerableAttachments.files.size
  },
  fixed: {
    ordinaryBlockCountAfterLostResponseRetry: fixedBlocks.blocks.length,
    ordinaryReplayReturnedOriginalId: replayedBlockId === fixedBlockId,
    attachmentBlockCountAfterLostResponseRetry: fixedAttachments.blocks.length,
    attachmentFileCountAfterLostResponseRetry: fixedAttachments.files.size,
    attachmentReplayReturnedOriginalId: replayedAttachmentId === fixedAttachmentId,
    changedPayloadCollisionRejected: true
  }
}, null, 2));
