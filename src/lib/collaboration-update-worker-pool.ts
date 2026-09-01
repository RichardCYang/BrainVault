import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { CollaborationMaterialization } from "./collaboration-materialization.js";
import { CollaborationDocumentError } from "./collaboration-document.js";
import { maxCollaborationHistoryReplayBytes } from "./collaboration-update-policy.js";
import { InvalidYjsUpdateError } from "./yjs-validation.js";

const maxPendingValidationTasks = 64;
const maxPendingValidationBytes = 128 * 1024 * 1024;
const maxPendingValidationTasksPerPrincipal = 1;
const maxPendingValidationBytesPerPrincipal = 32 * 1024 * 1024;
const maxPendingHistoryReplayBytesPerPrincipal = maxCollaborationHistoryReplayBytes;
const validationTaskTimeoutMs = 5_000;
const historyReplayTaskTimeoutMs = 30_000;
const maxValidationWorkers = 2;
const validationWorkerOldGenerationMb = 128;
const validationWorkerYoungGenerationMb = 32;

type ValidationRequest = {
  principalKey: string;
  currentState: Uint8Array;
  update: Uint8Array;
  maxStateBytes: number;
  includeMaterialization?: boolean;
};

type HistoryReplayRequest = {
  principalKey: string;
  updates: Uint8Array[];
  maxStateBytes: number;
};

export type CollaborationValidationResult = {
  stateUpdate: Buffer;
  incrementalUpdate: Buffer;
  changed: boolean;
  materialization: CollaborationMaterialization | null;
};

export type CollaborationHistoryReplayResult = {
  stateUpdate: Buffer;
};

type WorkerValidationRequest = {
  id: number;
  kind: "validation";
  currentState: Uint8Array;
  update: Uint8Array;
  maxStateBytes: number;
  includeMaterialization: boolean;
};

type WorkerHistoryReplayRequest = {
  id: number;
  kind: "history-replay";
  updates: Uint8Array[];
  maxStateBytes: number;
};

type WorkerRequest = WorkerValidationRequest | WorkerHistoryReplayRequest;

type WorkerValidationSuccess = {
  id: number;
  kind: "validation";
  ok: true;
  stateUpdate: Uint8Array;
  incrementalUpdate: Uint8Array;
  changed: boolean;
  materialization: CollaborationMaterialization | null;
};

type WorkerHistoryReplaySuccess = {
  id: number;
  kind: "history-replay";
  ok: true;
  stateUpdate: Uint8Array;
};

type WorkerFailure = {
  id: number;
  task: WorkerRequest["kind"];
  ok: false;
  errorKind: "invalid-yjs" | "invalid-document" | "internal";
  code?: string;
  message: string;
};

type WorkerResponse = WorkerValidationSuccess | WorkerHistoryReplaySuccess | WorkerFailure;

type PendingTaskBase = {
  id: number;
  principalKey: string;
  validationBytes: number;
  timeoutMs: number;
  reject: (error: unknown) => void;
};

type PendingValidationTask = PendingTaskBase & {
  kind: "validation";
  request: WorkerValidationRequest;
  resolve: (result: CollaborationValidationResult) => void;
};

type PendingHistoryReplayTask = PendingTaskBase & {
  kind: "history-replay";
  request: WorkerHistoryReplayRequest;
  resolve: (result: CollaborationHistoryReplayResult) => void;
};

type PendingTask = PendingValidationTask | PendingHistoryReplayTask;

type WorkerSlot = {
  worker: Worker;
  activeTask: PendingTask | null;
  timeout: NodeJS.Timeout | null;
  failed: boolean;
};

export class CollaborationValidationCapacityError extends Error {
  constructor() {
    super("Collaboration validation capacity exceeded");
    this.name = "CollaborationValidationCapacityError";
  }
}

export class CollaborationValidationTimeoutError extends Error {
  constructor() {
    super("Collaboration update exceeded the validation time budget");
    this.name = "CollaborationValidationTimeoutError";
  }
}

export class CollaborationValidationResourceLimitError extends Error {
  constructor() {
    super("Collaboration update exceeded the validation memory budget");
    this.name = "CollaborationValidationResourceLimitError";
  }
}

function workerModuleUrl() {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./collaboration-update-worker${extension}`, import.meta.url);
}

function resolveWorkerCount() {
  const parallelism = availableParallelism();
  return Math.max(1, Math.min(maxValidationWorkers, parallelism > 1 ? parallelism - 1 : 1));
}

function isWorkerOutOfMemoryError(error: Error) {
  return "code" in error
    && (error as Error & { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY";
}

function toWorkerError(response: WorkerFailure) {
  if (response.errorKind === "invalid-yjs") return new InvalidYjsUpdateError(response.message);
  if (response.errorKind === "invalid-document") {
    return new CollaborationDocumentError(
      response.code ?? "INVALID_COLLABORATION_DOCUMENT",
      response.message
    );
  }
  return new Error(response.message);
}

export class CollaborationValidationPool {
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingTask[] = [];
  private readonly workerCount: number;
  private nextTaskId = 1;
  private pendingValidationBytes = 0;
  private readonly pendingValidationTasksByPrincipal = new Map<string, number>();
  private readonly pendingValidationBytesByPrincipal = new Map<string, number>();
  private closed = false;

  constructor(workerCount = resolveWorkerCount()) {
    this.workerCount = Math.max(1, Math.min(maxValidationWorkers, Math.floor(workerCount)));
  }

  validate(request: ValidationRequest): Promise<CollaborationValidationResult> {
    if (this.closed) return Promise.reject(new Error("Collaboration validation pool is closed"));
    const principalKey = request.principalKey.trim();
    if (!principalKey) return Promise.reject(new CollaborationValidationCapacityError());
    const validationBytes = request.currentState.byteLength + request.update.byteLength;
    if (!this.admitTask(principalKey, validationBytes, maxPendingValidationBytesPerPrincipal)) {
      return Promise.reject(new CollaborationValidationCapacityError());
    }

    const id = this.nextTaskId++;
    const workerRequest: WorkerValidationRequest = {
      id,
      kind: "validation",
      currentState: request.currentState,
      update: request.update,
      maxStateBytes: request.maxStateBytes,
      includeMaterialization: request.includeMaterialization === true
    };
    return new Promise((resolve, reject) => {
      this.queue.push({
        id,
        kind: "validation",
        principalKey,
        request: workerRequest,
        validationBytes,
        timeoutMs: validationTaskTimeoutMs,
        resolve,
        reject
      });
      this.dispatch();
    });
  }

  replayHistory(request: HistoryReplayRequest): Promise<CollaborationHistoryReplayResult> {
    if (this.closed) return Promise.reject(new Error("Collaboration validation pool is closed"));
    const principalKey = request.principalKey.trim();
    if (!principalKey) return Promise.reject(new CollaborationValidationCapacityError());
    const validationBytes = request.updates.reduce((total, update) => total + update.byteLength, 0);
    if (!this.admitTask(principalKey, validationBytes, maxPendingHistoryReplayBytesPerPrincipal)) {
      return Promise.reject(new CollaborationValidationCapacityError());
    }

    const id = this.nextTaskId++;
    const workerRequest: WorkerHistoryReplayRequest = {
      id,
      kind: "history-replay",
      updates: request.updates,
      maxStateBytes: request.maxStateBytes
    };
    return new Promise((resolve, reject) => {
      this.queue.push({
        id,
        kind: "history-replay",
        principalKey,
        request: workerRequest,
        validationBytes,
        timeoutMs: historyReplayTaskTimeoutMs,
        resolve,
        reject
      });
      this.dispatch();
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Collaboration validation pool is closed");
    while (this.queue.length) {
      const task = this.queue.shift();
      if (!task) break;
      this.releaseTaskAccounting(task);
      task.reject(error);
    }
    await Promise.allSettled(this.slots.map(async (slot) => {
      slot.failed = true;
      if (slot.timeout) clearTimeout(slot.timeout);
      slot.timeout = null;
      if (slot.activeTask) {
        this.releaseTaskAccounting(slot.activeTask);
        slot.activeTask.reject(error);
      }
      slot.activeTask = null;
      slot.worker.removeAllListeners();
      await slot.worker.terminate();
    }));
  }

  private admitTask(principalKey: string, validationBytes: number, principalByteLimit: number) {
    this.ensureWorkers();
    const activeTasks = this.slots.reduce((count, slot) => count + (slot.activeTask ? 1 : 0), 0);
    const principalTasks = this.pendingValidationTasksByPrincipal.get(principalKey) ?? 0;
    const principalBytes = this.pendingValidationBytesByPrincipal.get(principalKey) ?? 0;
    if (
      !Number.isSafeInteger(validationBytes)
      || validationBytes < 0
      || activeTasks + this.queue.length >= maxPendingValidationTasks
      || validationBytes > maxPendingValidationBytes - this.pendingValidationBytes
      || principalTasks >= maxPendingValidationTasksPerPrincipal
      || validationBytes > principalByteLimit - principalBytes
    ) {
      return false;
    }

    this.pendingValidationBytes += validationBytes;
    this.pendingValidationTasksByPrincipal.set(principalKey, principalTasks + 1);
    this.pendingValidationBytesByPrincipal.set(principalKey, principalBytes + validationBytes);
    return true;
  }

  private ensureWorkers() {
    while (this.slots.length < this.workerCount) {
      this.slots.push(this.createWorkerSlot(this.slots.length));
    }
  }

  private createWorkerSlot(index: number): WorkerSlot {
    const worker = new Worker(workerModuleUrl(), {
      name: `brainvault-collab-${index + 1}`,
      resourceLimits: {
        maxOldGenerationSizeMb: validationWorkerOldGenerationMb,
        maxYoungGenerationSizeMb: validationWorkerYoungGenerationMb,
        stackSizeMb: 4
      }
    });
    const slot: WorkerSlot = { worker, activeTask: null, timeout: null, failed: false };
    worker.on("message", (response: WorkerResponse) => this.handleWorkerMessage(slot, response));
    worker.on("error", (error) => this.failWorkerSlot(slot, error));
    worker.on("exit", (code) => {
      if (!this.closed && !slot.failed) {
        this.failWorkerSlot(slot, new Error(`Collaboration validation worker exited with code ${code}`));
      }
    });
    worker.unref();
    return slot;
  }

  private handleWorkerMessage(slot: WorkerSlot, response: WorkerResponse) {
    const task = slot.activeTask;
    if (!task || task.id !== response.id) {
      this.failWorkerSlot(slot, new Error("Collaboration validation worker returned an unexpected response"));
      return;
    }
    if (response.ok ? task.kind !== response.kind : task.kind !== response.task) {
      this.failWorkerSlot(slot, new Error("Collaboration validation worker returned a mismatched task response"));
      return;
    }

    slot.activeTask = null;
    if (slot.timeout) clearTimeout(slot.timeout);
    slot.timeout = null;
    this.releaseTaskAccounting(task);
    slot.worker.unref();
    if (response.ok) {
      if (task.kind === "validation" && response.kind === "validation") {
        task.resolve({
          stateUpdate: Buffer.from(response.stateUpdate),
          incrementalUpdate: Buffer.from(response.incrementalUpdate),
          changed: response.changed,
          materialization: response.materialization
        });
      } else if (task.kind === "history-replay" && response.kind === "history-replay") {
        task.resolve({ stateUpdate: Buffer.from(response.stateUpdate) });
      }
    } else {
      task.reject(toWorkerError(response));
    }
    this.dispatch();
  }

  private failWorkerSlot(slot: WorkerSlot, error: Error) {
    if (slot.failed) return;
    slot.failed = true;
    if (slot.timeout) clearTimeout(slot.timeout);
    slot.timeout = null;
    if (slot.activeTask) {
      this.releaseTaskAccounting(slot.activeTask);
      slot.activeTask.reject(
        isWorkerOutOfMemoryError(error) ? new CollaborationValidationResourceLimitError() : error
      );
    }
    slot.activeTask = null;
    slot.worker.removeAllListeners();
    void slot.worker.terminate();

    if (!this.closed) {
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots[index] = this.createWorkerSlot(index);
      this.dispatch();
    }
  }

  private releaseTaskAccounting(task: PendingTask) {
    this.pendingValidationBytes = Math.max(0, this.pendingValidationBytes - task.validationBytes);

    const principalTasks = Math.max(0, (this.pendingValidationTasksByPrincipal.get(task.principalKey) ?? 0) - 1);
    if (principalTasks === 0) this.pendingValidationTasksByPrincipal.delete(task.principalKey);
    else this.pendingValidationTasksByPrincipal.set(task.principalKey, principalTasks);

    const principalBytes = Math.max(0, (this.pendingValidationBytesByPrincipal.get(task.principalKey) ?? 0) - task.validationBytes);
    if (principalBytes === 0) this.pendingValidationBytesByPrincipal.delete(task.principalKey);
    else this.pendingValidationBytesByPrincipal.set(task.principalKey, principalBytes);
  }

  private takeNextTask(activeHistoryReplay: boolean) {
    const validationIndex = this.queue.findIndex((task) => task.kind === "validation");
    if (validationIndex >= 0) return this.queue.splice(validationIndex, 1)[0];
    if (activeHistoryReplay) return null;
    const replayIndex = this.queue.findIndex((task) => task.kind === "history-replay");
    return replayIndex >= 0 ? this.queue.splice(replayIndex, 1)[0] : null;
  }

  private dispatch() {
    if (this.closed) return;
    let activeHistoryReplay = this.slots.some((slot) => slot.activeTask?.kind === "history-replay");
    for (const slot of this.slots) {
      if (slot.failed || slot.activeTask || !this.queue.length) continue;
      const task = this.takeNextTask(activeHistoryReplay);
      if (!task) continue;
      if (task.kind === "history-replay") activeHistoryReplay = true;
      slot.activeTask = task;
      slot.worker.ref();
      const timeout = setTimeout(() => {
        if (slot.activeTask?.id !== task.id) return;
        const error = task.kind === "history-replay"
          ? new Error("Collaboration history replay exceeded the validation time budget")
          : new CollaborationValidationTimeoutError();
        this.failWorkerSlot(slot, error);
      }, task.timeoutMs);
      timeout.unref();
      slot.timeout = timeout;
      try {
        slot.worker.postMessage(task.request);
      } catch (error) {
        if (slot.timeout) clearTimeout(slot.timeout);
        slot.timeout = null;
        slot.activeTask = null;
        this.releaseTaskAccounting(task);
        slot.worker.unref();
        task.reject(error);
        this.failWorkerSlot(slot, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
