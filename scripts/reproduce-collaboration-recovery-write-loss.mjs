import {
  CollaborationRecoveryWriteError,
  commitPreparedCollaborationMutation
} from "../public/collaboration-durability.js";

function reproduceVulnerableOrder() {
  const server = { value: "before edit" };
  const recovery = { value: "before edit", writeSucceeded: false };
  const live = { value: server.value };
  live.value = "critical edit";
  recovery.writeSucceeded = false;
  const reloaded = recovery.writeSucceeded ? recovery.value : server.value;
  return {
    liveBeforeCrash: live.value,
    serverBeforeCrash: server.value,
    recoveryWriteSucceeded: recovery.writeSucceeded,
    reloaded,
    permanentLossWindowReproduced: reloaded !== live.value
  };
}

async function reproduceFixedStorageFailure() {
  const server = { value: "before edit" };
  const live = { value: server.value };
  let rejectedWithDurabilityError = false;
  try {
    await commitPreparedCollaborationMutation({
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
    permanentLossWindowClosed: rejectedWithDurabilityError && live.value === server.value
  };
}

async function reproduceFixedSuccess() {
  const server = { value: "before edit" };
  const recovery = { value: null, generation: null };
  const live = { value: server.value };
  const order = [];

  const generation = await commitPreparedCollaborationMutation({
    recoveryUpdate: Uint8Array.of(1),
    liveUpdate: Uint8Array.of(2),
    persistRecovery: async () => {
      order.push("persist-full-recovery");
      await Promise.resolve();
      recovery.value = "critical edit";
      recovery.generation = "generation-1";
      order.push("recovery-durable");
      return recovery.generation;
    },
    applyLiveUpdate: () => {
      order.push("apply-live-update");
      live.value = "critical edit";
    }
  });

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
    durableBeforeVisible: order.indexOf("recovery-durable") < order.indexOf("apply-live-update"),
    acknowledgedEditSurvivesReload: server.value === "critical edit"
  };
}

const vulnerable = reproduceVulnerableOrder();
const fixedStorageFailure = await reproduceFixedStorageFailure();
const fixedSuccess = await reproduceFixedSuccess();

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
