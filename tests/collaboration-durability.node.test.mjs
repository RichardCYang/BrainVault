import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLABORATION_RECOVERY_WRITE_FAILED,
  CollaborationRecoveryWriteError,
  commitPreparedCollaborationMutation
} from "../public/collaboration-durability.js";

const recoveryUpdate = Uint8Array.of(1, 2, 3);
const liveUpdate = Uint8Array.of(4, 5);

test("a rejected recovery write prevents the live mutation", async () => {
  let applied = false;

  await assert.rejects(
    commitPreparedCollaborationMutation({
      recoveryUpdate,
      liveUpdate,
      persistRecovery: () => null,
      applyLiveUpdate: () => { applied = true; }
    }),
    (error) => {
      assert(error instanceof CollaborationRecoveryWriteError);
      assert.equal(error.code, COLLABORATION_RECOVERY_WRITE_FAILED);
      return true;
    }
  );

  assert.equal(applied, false);
});

test("a thrown storage error is preserved as the recovery failure cause", async () => {
  const storageError = new Error("quota exceeded");
  let applied = false;

  await assert.rejects(
    commitPreparedCollaborationMutation({
      recoveryUpdate,
      liveUpdate,
      persistRecovery: () => { throw storageError; },
      applyLiveUpdate: () => { applied = true; }
    }),
    (error) => {
      assert(error instanceof CollaborationRecoveryWriteError);
      assert.equal(error.code, COLLABORATION_RECOVERY_WRITE_FAILED);
      assert.equal(error.cause, storageError);
      return true;
    }
  );

  assert.equal(applied, false);
});

test("the durability promise settles before the live update is exposed", async () => {
  const order = [];
  const generation = await commitPreparedCollaborationMutation({
    recoveryUpdate,
    liveUpdate,
    persistRecovery: async (update) => {
      order.push(["persist-start", [...update]]);
      await Promise.resolve();
      order.push(["persist-durable", [...update]]);
      return "generation-1";
    },
    applyLiveUpdate: (update) => {
      order.push(["apply", [...update]]);
    }
  });

  assert.equal(generation, "generation-1");
  assert.deepEqual(order, [
    ["persist-start", [1, 2, 3]],
    ["persist-durable", [1, 2, 3]],
    ["apply", [4, 5]]
  ]);
});

test("an unexpected live-apply failure occurs only after recovery is durable", async () => {
  const applyError = new Error("simulated apply failure");
  let durable = false;

  await assert.rejects(
    commitPreparedCollaborationMutation({
      recoveryUpdate,
      liveUpdate,
      persistRecovery: async () => {
        durable = true;
        return "generation-2";
      },
      applyLiveUpdate: () => { throw applyError; }
    }),
    (error) => error === applyError
  );

  assert.equal(durable, true);
});

test("empty updates are rejected before storage or live state is touched", async () => {
  let persisted = false;
  let applied = false;

  await assert.rejects(
    commitPreparedCollaborationMutation({
      recoveryUpdate: new Uint8Array(),
      liveUpdate,
      persistRecovery: () => {
        persisted = true;
        return "generation";
      },
      applyLiveUpdate: () => { applied = true; }
    }),
    /recoveryUpdate must contain at least one byte/
  );

  assert.equal(persisted, false);
  assert.equal(applied, false);
});
