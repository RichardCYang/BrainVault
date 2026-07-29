// @ts-check

export const COLLABORATION_RECOVERY_WRITE_FAILED = "COLLABORATION_RECOVERY_WRITE_FAILED";

export class CollaborationRecoveryWriteError extends Error {
  constructor(
    message = "The browser could not save a local collaboration recovery copy",
    { cause } = {}
  ) {
    super(message);
    this.name = "CollaborationRecoveryWriteError";
    this.code = COLLABORATION_RECOVERY_WRITE_FAILED;
    if (cause !== undefined) this.cause = cause;
  }
}

function asNonEmptyUpdate(value, label) {
  const update = value instanceof Uint8Array ? value : new Uint8Array(value ?? 0);
  if (!update.byteLength) throw new TypeError(`${label} must contain at least one byte`);
  return update;
}

/**
 * Makes a prepared browser recovery snapshot durable before exposing its
 * corresponding incremental update to the live Yjs document.
 *
 * @param {{
 *   recoveryUpdate: Uint8Array | ArrayBuffer | ArrayLike<number>,
 *   liveUpdate: Uint8Array | ArrayBuffer | ArrayLike<number>,
 *   persistRecovery: (update: Uint8Array) => unknown,
 *   applyLiveUpdate: (update: Uint8Array) => void
 * }} options
 * @returns {string}
 */
export function commitPreparedCollaborationMutation({
  recoveryUpdate,
  liveUpdate,
  persistRecovery,
  applyLiveUpdate
}) {
  if (typeof persistRecovery !== "function") throw new TypeError("persistRecovery must be a function");
  if (typeof applyLiveUpdate !== "function") throw new TypeError("applyLiveUpdate must be a function");

  const durableUpdate = asNonEmptyUpdate(recoveryUpdate, "recoveryUpdate");
  const incrementalUpdate = asNonEmptyUpdate(liveUpdate, "liveUpdate");
  let generation;
  try {
    generation = persistRecovery(durableUpdate);
  } catch (error) {
    throw new CollaborationRecoveryWriteError(undefined, { cause: error });
  }
  if (typeof generation !== "string" || generation.length === 0) {
    throw new CollaborationRecoveryWriteError();
  }

  // Deliberately last: a caller may expose or transmit the live update only
  // after the full-document recovery candidate is known to be durable.
  applyLiveUpdate(incrementalUpdate);
  return generation;
}
