import * as Y from "yjs";
import { assertYjsDeleteSetBudget } from "./yjs-delete-set-budget.js";

export class InvalidYjsUpdateError extends Error {
  readonly code = "INVALID_YJS_UPDATE";

  constructor(message = "The collaboration update is not a valid Yjs document update", options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidYjsUpdateError";
  }
}

export type ValidatedYjsUpdate = {
  document: Y.Doc;
  stateUpdate: Uint8Array;
  incrementalUpdate: Uint8Array;
  changed: boolean;
};

// Yjs 13.x allocates an array sized from an update-declared struct count while
// applying V1 updates. Run the public lazy metadata parser first so malformed
// counts are rejected before Y.applyUpdate reaches that allocation path. A
// separate client-section cap also prevents a tiny payload from declaring an
// excessive number of top-level update sections.
const maxYjsClientSections = 100_000;
const maxYjsTotalStructs = 100_000;

class BoundedUpdateDecoderV1 extends Y.UpdateDecoderV1 {
  private structsRead = 0;

  readInfo() {
    this.structsRead += 1;
    if (this.structsRead > maxYjsTotalStructs) {
      throw new InvalidYjsUpdateError("The collaboration update declares too many structs");
    }
    return super.readInfo();
  }
}

function assertLeadingClientSectionCount(update: Uint8Array) {
  let value = 0;
  let multiplier = 1;

  for (let index = 0; index < update.byteLength && index < 8; index += 1) {
    const byte = update[index];
    const digit = byte & 0x7f;
    if (digit > Math.floor((maxYjsClientSections - value) / multiplier)) {
      throw new InvalidYjsUpdateError("The collaboration update declares too many client sections");
    }
    value += digit * multiplier;
    if ((byte & 0x80) === 0) return;
    multiplier *= 128;
  }

  throw new InvalidYjsUpdateError("The collaboration update header is malformed");
}

function assertUpdatePreflight(update: Uint8Array, maxStateBytes: number) {
  if (!update.byteLength || update.byteLength > maxStateBytes) {
    throw new InvalidYjsUpdateError("The collaboration update is too large or empty");
  }

  assertLeadingClientSectionCount(update);
  try {
    // Yjs's lazy metadata reader calls UpdateDecoderV1.readInfo exactly once
    // per encoded struct. Supplying a bounded decoder lets us stop after a
    // fixed aggregate struct budget without materializing the update. This is
    // deliberately checked before applyUpdate, whose V1 decoder eagerly
    // allocates an array sized from the attacker-controlled per-section count.
    // Keep this decoder local to the invocation: parseUpdateMetaV2 consumes
    // structs only and leaves restDecoder at the delete-set boundary. Reuse
    // that exact cursor rather than re-parsing or importing private Yjs APIs.
    const decoderHolder: { value?: BoundedUpdateDecoderV1 } = {};
    class PreflightDecoderV1 extends BoundedUpdateDecoderV1 {
      constructor(...args: ConstructorParameters<typeof Y.UpdateDecoderV1>) {
        super(...args);
        decoderHolder.value = this;
      }
    }
    const metadata = Y.parseUpdateMetaV2(update, PreflightDecoderV1);
    if (!decoderHolder.value) throw new InvalidYjsUpdateError("The collaboration decoder was not initialized");
    assertYjsDeleteSetBudget(decoderHolder.value.restDecoder);
    if (metadata.from.size > maxYjsClientSections || metadata.to.size > maxYjsClientSections) {
      throw new InvalidYjsUpdateError("The collaboration update references too many clients");
    }
    for (const [client, clock] of [...metadata.from, ...metadata.to]) {
      if (!Number.isSafeInteger(client) || client < 0 || !Number.isSafeInteger(clock) || clock < 0) {
        throw new InvalidYjsUpdateError("The collaboration update metadata is invalid");
      }
    }
  } catch (error) {
    if (error instanceof InvalidYjsUpdateError) throw error;
    throw new InvalidYjsUpdateError("The collaboration update encoding is malformed", { cause: error });
  }
}

function encodeBoundedState(document: Y.Doc, maxStateBytes: number) {
  const stateUpdate = Y.encodeStateAsUpdate(document);
  if (stateUpdate.byteLength > maxStateBytes) {
    throw new InvalidYjsUpdateError("The resulting collaboration document is too large");
  }
  // The persisted canonical state must satisfy the same structural budget as
  // client input. Otherwise multiple individually valid updates can combine
  // into a server-generated state that this server can no longer replay.
  assertUpdatePreflight(stateUpdate, maxStateBytes);
  return stateUpdate;
}

function rebuildValidatedYjsHistory(
  document: Y.Doc,
  updates: Iterable<Uint8Array>,
  maxStateBytes: number
) {
  for (const update of updates) {
    assertUpdatePreflight(update, maxStateBytes);
    Y.applyUpdate(document, update);
    // Individually bounded delete-only updates can accumulate in pendingDs.
    // Check their combined canonical encoding before applying another history
    // row. Ordinary, fully integrated histories avoid this extra encoding.
    if (document.store.pendingDs !== null) encodeBoundedState(document, maxStateBytes);
  }
  return encodeBoundedState(document, maxStateBytes);
}

/**
 * Rebuild a room document from the ordered, persisted update log. Invalid or
 * over-sized history is rejected before any client receives it.
 */
export function createValidatedYjsDocument(
  updates: Iterable<Uint8Array>,
  maxStateBytes: number
) {
  const document = new Y.Doc();
  try {
    rebuildValidatedYjsHistory(document, updates, maxStateBytes);
    return document;
  } catch (error) {
    document.destroy();
    if (error instanceof InvalidYjsUpdateError) throw error;
    throw new InvalidYjsUpdateError("Stored collaboration history is not a valid Yjs document", { cause: error });
  }
}

/**
 * Rebuild persisted history and return only its canonical state update. This is
 * the worker-friendly form used by room loading so CPU-heavy Yjs replay never
 * runs on Node's shared event loop.
 */
export function createValidatedYjsStateUpdate(
  updates: Iterable<Uint8Array>,
  maxStateBytes: number
) {
  const document = new Y.Doc();
  try {
    return rebuildValidatedYjsHistory(document, updates, maxStateBytes);
  } catch (error) {
    if (error instanceof InvalidYjsUpdateError) throw error;
    throw new InvalidYjsUpdateError("Stored collaboration history is not a valid Yjs document", { cause: error });
  } finally {
    document.destroy();
  }
}

/**
 * Apply an untrusted client update to an isolated copy of the current room.
 * The live room is only replaced after the candidate update commits to SQL.
 */
export function applyValidatedYjsStateUpdate(
  currentStateInput: Uint8Array,
  update: Uint8Array,
  maxStateBytes: number
): ValidatedYjsUpdate {
  const candidate = new Y.Doc();
  try {
    const currentState = Buffer.from(currentStateInput);
    if (currentState.byteLength > maxStateBytes) {
      throw new InvalidYjsUpdateError("The current collaboration document is too large");
    }

    // Reject malformed client bytes before spending work rebuilding the room's
    // current state. The current canonical state is checked as well so legacy
    // or corrupted persisted data cannot bypass the same decoder guard.
    assertUpdatePreflight(update, maxStateBytes);
    assertUpdatePreflight(currentState, maxStateBytes);
    Y.applyUpdate(candidate, currentState);
    const currentStateVector = Y.encodeStateVector(candidate);
    Y.applyUpdate(candidate, update);
    const stateUpdate = encodeBoundedState(candidate, maxStateBytes);
    const incrementalUpdate = Y.encodeStateAsUpdate(candidate, currentStateVector);
    // Pending Yjs structs can be re-emitted when an incremental encoding is
    // generated. Validate the exact row candidate before callers persist it.
    assertUpdatePreflight(incrementalUpdate, maxStateBytes);
    return {
      document: candidate,
      stateUpdate,
      incrementalUpdate,
      changed: !Buffer.from(currentState).equals(Buffer.from(stateUpdate))
    };
  } catch (error) {
    candidate.destroy();
    if (error instanceof InvalidYjsUpdateError) throw error;
    throw new InvalidYjsUpdateError(undefined, { cause: error });
  }
}

export function applyValidatedYjsUpdate(
  currentDocument: Y.Doc,
  update: Uint8Array,
  maxStateBytes: number,
  canonicalCurrentState?: Uint8Array
): ValidatedYjsUpdate {
  // The collaboration room caches the server-generated canonical state. Using
  // it here avoids re-encoding a potentially large document before every
  // small update while preserving the isolated-candidate commit boundary.
  const currentState = canonicalCurrentState === undefined
    ? encodeBoundedState(currentDocument, maxStateBytes)
    : canonicalCurrentState;
  return applyValidatedYjsStateUpdate(currentState, update, maxStateBytes);
}
