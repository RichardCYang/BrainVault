import assert from "node:assert/strict";

function simulateVulnerableDelete() {
  const blocks = new Set(["blk_target"]);

  const submit = () => {
    if (!blocks.delete("blk_target")) {
      const error = new Error("Block not found");
      error.status = 404;
      throw error;
    }
    const error = new Error("response lost after commit");
    error.ambiguous = true;
    throw error;
  };

  let retryAcknowledged = false;
  try {
    submit();
  } catch (error) {
    assert.equal(error.ambiguous, true);
  }
  try {
    submit();
  } catch (error) {
    assert.equal(error.status, 404);
  }

  return {
    blockDeleted: !blocks.has("blk_target"),
    retryAcknowledged
  };
}

function simulateFixedDelete() {
  const blocks = new Set(["blk_target"]);
  const receipts = new Map();
  const mutationId = "mut_delete_1";
  const requestHash = "same-request";

  const submit = ({ loseResponse = false } = {}) => {
    const receipt = receipts.get(mutationId);
    if (receipt) {
      if (receipt.requestHash !== requestHash) throw new Error("mutation collision");
      return { status: 204, replayed: true, attachmentIds: receipt.attachmentIds };
    }

    assert.equal(blocks.delete("blk_target"), true);
    receipts.set(mutationId, {
      requestHash,
      attachmentIds: ["blk_target"]
    });
    if (loseResponse) {
      const error = new Error("response lost after commit");
      error.ambiguous = true;
      throw error;
    }
    return { status: 204, replayed: false, attachmentIds: ["blk_target"] };
  };

  try {
    submit({ loseResponse: true });
  } catch (error) {
    assert.equal(error.ambiguous, true);
  }
  const replay = submit();

  return {
    blockDeleted: !blocks.has("blk_target"),
    retryAcknowledged: replay.status === 204 && replay.replayed,
    attachmentCleanupCanRepeat: replay.attachmentIds.includes("blk_target")
  };
}

const result = {
  vulnerable: simulateVulnerableDelete(),
  fixed: simulateFixedDelete()
};

assert.deepEqual(result.vulnerable, {
  blockDeleted: true,
  retryAcknowledged: false
});
assert.deepEqual(result.fixed, {
  blockDeleted: true,
  retryAcknowledged: true,
  attachmentCleanupCanRepeat: true
});

console.log(JSON.stringify(result, null, 2));
