import {
  CollaborationRecoveryWriteError,
  commitPreparedCollaborationMutation
} from "../public/collaboration-durability.js";

function reproduceVulnerableOrder() {
  const server = { value: "before edit" };
  const recovery = { value: "before edit", writeSucceeded: false };
  const live = { value: server.value };

  // Vulnerable order: mutate the only live copy first, then attempt recovery.
  live.value = "critical edit";
  recovery.writeSucceeded = false;

  // The socket drops before the server can durably accept the update, and the
  // tab crashes. Reload can observe only the old server/recovery copies.
  const reloaded = recovery.writeSucceeded ? recovery.value : server.value;
  return {
    liveBeforeCrash: live.value,
    serverBeforeCrash: server.value,
    recoveryWriteSucceeded: recovery.writeSucceeded,
    reloaded,
    permanentLossWindowReproduced: reloaded !== live.value
  };
}

function reproduceFixedStorageFailure() {
  const server = { value: "before edit" };
  const live = { value: server.value };
  let rejectedWithDurabilityError = false;

  try {
    commitPreparedCollaborationMutation({
      recoveryUpdate: Uint8Array.of(1),
      liveUpdate: Uint8Array.of(2),
      persistRecovery: () => null,
      applyLiveUpdate: () => { live.value = "critical edit"; }
    });
  } catch (error) {
    rejectedWithDurabilityError = error instanceof CollaborationRecoveryWriteError;
  }

  return {
    rejectedWithDurabilityError,
    liveAfterRejectedEdit: live.value,
    serverAfterRejectedEdit: server.value,
    unprotectedEditBecameVisible: live.value !== server.value,
    permanentLossWindowClosed:
      rejectedWithDurabilityError
      && live.value === server.value
  };
}

function reproduceFixedSuccess() {
  const server = { value: "before edit" };
  const recovery = { value: null, generation: null };
  const live = { value: server.value };
  const order = [];

  const generation = commitPreparedCollaborationMutation({
    recoveryUpdate: Uint8Array.of(1),
    liveUpdate: Uint8Array.of(2),
    persistRecovery: () => {
      order.push("persist-full-recovery");
      recovery.value = "critical edit";
      recovery.generation = "generation-1";
      return recovery.generation;
    },
    applyLiveUpdate: () => {
      order.push("apply-live-update");
      live.value = "critical edit";
    }
  });

  // Model a durable server acknowledgement, after which the browser copy may
  // be cleared without losing the edit.
  order.push("server-commit-and-ack");
  server.value = live.value;
  recovery.value = null;
  order.push("clear-recovery");

  return {
    generation,
    order,
    serverAfterAck: server.value,
    recoveryAfterAck: recovery.value,
    reloaded: server.value,
    durableBeforeVisible: order.indexOf("persist-full-recovery") < order.indexOf("apply-live-update"),
    acknowledgedEditSurvivesReload: server.value === "critical edit"
  };
}

const vulnerable = reproduceVulnerableOrder();
const fixedStorageFailure = reproduceFixedStorageFailure();
const fixedSuccess = reproduceFixedSuccess();

console.log(JSON.stringify({
  vulnerable,
  fixed: {
    storageFailure: fixedStorageFailure,
    success: fixedSuccess,
    permanentLossWindowClosed:
      fixedStorageFailure.permanentLossWindowClosed
      && fixedSuccess.durableBeforeVisible
      && fixedSuccess.acknowledgedEditSurvivesReload
  }
}, null, 2));
