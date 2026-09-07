#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function hashRequest(expectedVersion, value) {
  return createHash("sha256")
    .update(JSON.stringify({ expectedVersion, value }), "utf8")
    .digest("hex");
}

function createEntity() {
  return {
    version: 5,
    value: "original",
    lastMutationId: null,
    lastMutationHash: null
  };
}

function submit(entity, { expectedVersion, mutationId, value }) {
  const requestHash = hashRequest(expectedVersion, value);
  if (entity.lastMutationId === mutationId) {
    if (entity.lastMutationHash === requestHash) {
      return { kind: "replay", version: entity.version, value: entity.value };
    }
    return { kind: "mutation-id-reused" };
  }
  if (entity.version !== expectedVersion) {
    return { kind: "conflict", version: entity.version, value: entity.value };
  }
  entity.value = value;
  entity.version += 1;
  entity.lastMutationId = mutationId;
  entity.lastMutationHash = requestHash;
  return { kind: "committed", version: entity.version, value: entity.value };
}

function retryAfterResponseLoss({ pinExpectedVersion, withNewerCanonicalWrite }) {
  const entity = createEntity();
  const task = {
    mutationId: "mut_local",
    value: "local edit",
    observedVersion: entity.version,
    requestExpectedVersion: undefined
  };

  const pickExpectedVersion = () => {
    if (pinExpectedVersion && task.requestExpectedVersion !== undefined) {
      return task.requestExpectedVersion;
    }
    const selected = entity.version;
    if (pinExpectedVersion) task.requestExpectedVersion = selected;
    return selected;
  };

  const firstExpectedVersion = pickExpectedVersion();
  const first = submit(entity, {
    expectedVersion: firstExpectedVersion,
    mutationId: task.mutationId,
    value: task.value
  });
  assert.equal(first.kind, "committed");
  // The HTTP response is lost, so the queue retains the task as ambiguous.

  if (withNewerCanonicalWrite) {
    const remote = submit(entity, {
      expectedVersion: entity.version,
      mutationId: "mut_remote",
      value: "newer canonical edit"
    });
    assert.equal(remote.kind, "committed");
  }

  const retryExpectedVersion = pickExpectedVersion();
  let retry = submit(entity, {
    expectedVersion: retryExpectedVersion,
    mutationId: task.mutationId,
    value: task.value
  });

  // This mirrors submitWithFreshMutationIdOnReuse(): a mismatched request hash
  // rotates the id and immediately submits the same payload again.
  if (retry.kind === "mutation-id-reused") {
    task.mutationId = "mut_rotated";
    retry = submit(entity, {
      expectedVersion: retryExpectedVersion,
      mutationId: task.mutationId,
      value: task.value
    });
  }

  return {
    firstExpectedVersion,
    retryExpectedVersion,
    retryKind: retry.kind,
    finalVersion: entity.version,
    finalValue: entity.value
  };
}

const result = {
  duplicateAfterCanonicalRefresh: {
    vulnerable: retryAfterResponseLoss({ pinExpectedVersion: false, withNewerCanonicalWrite: false }),
    fixed: retryAfterResponseLoss({ pinExpectedVersion: true, withNewerCanonicalWrite: false })
  },
  staleOverwriteAfterNewerWrite: {
    vulnerable: retryAfterResponseLoss({ pinExpectedVersion: false, withNewerCanonicalWrite: true }),
    fixed: retryAfterResponseLoss({ pinExpectedVersion: true, withNewerCanonicalWrite: true })
  }
};

assert.equal(result.duplicateAfterCanonicalRefresh.vulnerable.retryKind, "committed");
assert.equal(result.duplicateAfterCanonicalRefresh.vulnerable.finalVersion, 7);
assert.equal(result.duplicateAfterCanonicalRefresh.fixed.retryKind, "replay");
assert.equal(result.duplicateAfterCanonicalRefresh.fixed.finalVersion, 6);

assert.equal(result.staleOverwriteAfterNewerWrite.vulnerable.retryKind, "committed");
assert.equal(result.staleOverwriteAfterNewerWrite.vulnerable.finalValue, "local edit");
assert.equal(result.staleOverwriteAfterNewerWrite.fixed.retryKind, "conflict");
assert.equal(result.staleOverwriteAfterNewerWrite.fixed.finalValue, "newer canonical edit");

console.log(JSON.stringify(result, null, 2));
