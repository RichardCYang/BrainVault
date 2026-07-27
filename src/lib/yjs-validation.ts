import * as Y from "yjs";

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
};

function encodeBoundedState(document: Y.Doc, maxStateBytes: number) {
  const stateUpdate = Y.encodeStateAsUpdate(document);
  if (stateUpdate.byteLength > maxStateBytes) {
    throw new InvalidYjsUpdateError("The resulting collaboration document is too large");
  }
  return stateUpdate;
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
    for (const update of updates) Y.applyUpdate(document, update);
    encodeBoundedState(document, maxStateBytes);
    return document;
  } catch (error) {
    document.destroy();
    if (error instanceof InvalidYjsUpdateError) throw error;
    throw new InvalidYjsUpdateError("Stored collaboration history is not a valid Yjs document", { cause: error });
  }
}

/**
 * Apply an untrusted client update to an isolated copy of the current room.
 * The live room is only replaced after the candidate update commits to SQL.
 */
export function applyValidatedYjsUpdate(
  currentDocument: Y.Doc,
  update: Uint8Array,
  maxStateBytes: number
): ValidatedYjsUpdate {
  const candidate = new Y.Doc();
  try {
    const currentState = encodeBoundedState(currentDocument, maxStateBytes);
    Y.applyUpdate(candidate, currentState);
    Y.applyUpdate(candidate, update);
    return {
      document: candidate,
      stateUpdate: encodeBoundedState(candidate, maxStateBytes)
    };
  } catch (error) {
    candidate.destroy();
    if (error instanceof InvalidYjsUpdateError) throw error;
    throw new InvalidYjsUpdateError(undefined, { cause: error });
  }
}
