import assert from "node:assert/strict";

function simulateVulnerableDelete() {
  const pages = new Set(["pag_target"]);

  const submit = () => {
    if (!pages.delete("pag_target")) {
      const error = new Error("Page not found");
      error.status = 404;
      throw error;
    }
    const error = new Error("response lost after commit");
    error.ambiguous = true;
    throw error;
  };

  try {
    submit();
  } catch (error) {
    assert.equal(error.ambiguous, true);
  }

  let retryAcknowledged = false;
  try {
    submit();
  } catch (error) {
    assert.equal(error.status, 404);
  }

  return { pageDeleted: !pages.has("pag_target"), retryAcknowledged };
}

function simulateFixedDelete() {
  const pages = new Set(["pag_target"]);
  const receipts = new Map();
  const mutationId = "mut_page_delete_1";
  const requestHash = "same-request";

  const submit = ({ loseResponse = false } = {}) => {
    const receipt = receipts.get(mutationId);
    if (receipt) {
      if (receipt.requestHash !== requestHash) throw new Error("mutation collision");
      return { status: 204, replayed: true, pageIds: receipt.pageIds };
    }

    assert.equal(pages.delete("pag_target"), true);
    receipts.set(mutationId, { requestHash, pageIds: ["pag_target"] });
    if (loseResponse) {
      const error = new Error("response lost after commit");
      error.ambiguous = true;
      throw error;
    }
    return { status: 204, replayed: false, pageIds: ["pag_target"] };
  };

  try {
    submit({ loseResponse: true });
  } catch (error) {
    assert.equal(error.ambiguous, true);
  }
  const replay = submit();

  return {
    pageDeleted: !pages.has("pag_target"),
    retryAcknowledged: replay.status === 204 && replay.replayed,
    relationalDeleteRepeated: false
  };
}

const result = {
  vulnerable: simulateVulnerableDelete(),
  fixed: simulateFixedDelete()
};

assert.deepEqual(result.vulnerable, { pageDeleted: true, retryAcknowledged: false });
assert.deepEqual(result.fixed, {
  pageDeleted: true,
  retryAcknowledged: true,
  relationalDeleteRepeated: false
});

console.log(JSON.stringify(result, null, 2));
