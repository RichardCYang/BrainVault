import { parentPort } from "node:worker_threads";
import {
  readCollaborationMaterialization,
  type CollaborationMaterialization
} from "./collaboration-materialization.js";
import { CollaborationDocumentError } from "./collaboration-document.js";
import {
  applyValidatedYjsStateUpdate,
  createValidatedYjsStateUpdate,
  InvalidYjsUpdateError
} from "./yjs-validation.js";

type CollaborationUpdateValidationRequest = {
  id: number;
  kind: "validation";
  currentState: Uint8Array;
  update: Uint8Array;
  maxStateBytes: number;
  includeMaterialization: boolean;
};

type CollaborationHistoryReplayRequest = {
  id: number;
  kind: "history-replay";
  updates: Uint8Array[];
  maxStateBytes: number;
};

type CollaborationWorkerRequest =
  | CollaborationUpdateValidationRequest
  | CollaborationHistoryReplayRequest;

type CollaborationUpdateValidationSuccess = {
  id: number;
  kind: "validation";
  ok: true;
  stateUpdate: Uint8Array;
  incrementalUpdate: Uint8Array;
  changed: boolean;
  materialization: CollaborationMaterialization | null;
};

type CollaborationHistoryReplaySuccess = {
  id: number;
  kind: "history-replay";
  ok: true;
  stateUpdate: Uint8Array;
};

type CollaborationWorkerFailure = {
  id: number;
  task: CollaborationWorkerRequest["kind"];
  ok: false;
  errorKind: "invalid-yjs" | "invalid-document" | "internal";
  code?: string;
  message: string;
};

const workerParentPort = parentPort;
if (!workerParentPort) throw new Error("Collaboration validation worker requires a parent port");

function toFailure(request: CollaborationWorkerRequest, error: unknown): CollaborationWorkerFailure {
  if (error instanceof InvalidYjsUpdateError) {
    return {
      id: request.id,
      task: request.kind,
      ok: false,
      errorKind: "invalid-yjs",
      message: error.message
    };
  }
  if (error instanceof CollaborationDocumentError) {
    return {
      id: request.id,
      task: request.kind,
      ok: false,
      errorKind: "invalid-document",
      code: error.code,
      message: error.message
    };
  }
  return {
    id: request.id,
    task: request.kind,
    ok: false,
    errorKind: "internal",
    message: error instanceof Error ? error.message : "Collaboration validation failed"
  };
}

workerParentPort.on("message", (request: CollaborationWorkerRequest) => {
  if (request.kind === "history-replay") {
    try {
      const stateUpdate = Uint8Array.from(
        createValidatedYjsStateUpdate(request.updates, request.maxStateBytes)
      );
      const response: CollaborationHistoryReplaySuccess = {
        id: request.id,
        kind: "history-replay",
        ok: true,
        stateUpdate
      };
      workerParentPort.postMessage(response, [stateUpdate.buffer]);
    } catch (error) {
      workerParentPort.postMessage(toFailure(request, error));
    }
    return;
  }

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
    const response: CollaborationUpdateValidationSuccess = {
      id: request.id,
      kind: "validation",
      ok: true,
      stateUpdate,
      incrementalUpdate,
      changed: candidate.changed,
      materialization: request.includeMaterialization ? materialization : null
    };
    workerParentPort.postMessage(response, [stateUpdate.buffer, incrementalUpdate.buffer]);
  } catch (error) {
    workerParentPort.postMessage(toFailure(request, error));
  } finally {
    candidate?.document.destroy();
  }
});
