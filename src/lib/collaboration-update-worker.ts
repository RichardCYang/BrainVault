import { parentPort } from "node:worker_threads";
import {
  readCollaborationMaterialization,
  type CollaborationMaterialization
} from "./collaboration-materialization.js";
import { CollaborationDocumentError } from "./collaboration-document.js";
import {
  applyValidatedYjsStateUpdate,
  InvalidYjsUpdateError
} from "./yjs-validation.js";

type CollaborationValidationRequest = {
  id: number;
  currentState: Uint8Array;
  update: Uint8Array;
  maxStateBytes: number;
  includeMaterialization: boolean;
};

type CollaborationValidationSuccess = {
  id: number;
  ok: true;
  stateUpdate: Uint8Array;
  incrementalUpdate: Uint8Array;
  changed: boolean;
  materialization: CollaborationMaterialization | null;
};

type CollaborationValidationFailure = {
  id: number;
  ok: false;
  kind: "invalid-yjs" | "invalid-document" | "internal";
  code?: string;
  message: string;
};

if (!parentPort) throw new Error("Collaboration validation worker requires a parent port");

parentPort.on("message", (request: CollaborationValidationRequest) => {
  let candidate: ReturnType<typeof applyValidatedYjsStateUpdate> | null = null;
  try {
    candidate = applyValidatedYjsStateUpdate(
      request.currentState,
      request.update,
      request.maxStateBytes
    );
    const materialization = candidate.changed || request.includeMaterialization
      ? readCollaborationMaterialization(candidate.document)
      : null;
    const stateUpdate = Uint8Array.from(candidate.stateUpdate);
    const incrementalUpdate = Uint8Array.from(candidate.incrementalUpdate);
    const response: CollaborationValidationSuccess = {
      id: request.id,
      ok: true,
      stateUpdate,
      incrementalUpdate,
      changed: candidate.changed,
      materialization: request.includeMaterialization ? materialization : null
    };
    parentPort.postMessage(response, [stateUpdate.buffer, incrementalUpdate.buffer]);
  } catch (error) {
    let response: CollaborationValidationFailure;
    if (error instanceof InvalidYjsUpdateError) {
      response = {
        id: request.id,
        ok: false,
        kind: "invalid-yjs",
        message: error.message
      };
    } else if (error instanceof CollaborationDocumentError) {
      response = {
        id: request.id,
        ok: false,
        kind: "invalid-document",
        code: error.code,
        message: error.message
      };
    } else {
      response = {
        id: request.id,
        ok: false,
        kind: "internal",
        message: error instanceof Error ? error.message : "Collaboration validation failed"
      };
    }
    parentPort.postMessage(response);
  } finally {
    candidate?.document.destroy();
  }
});
