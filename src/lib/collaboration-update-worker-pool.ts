import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { CollaborationMaterialization } from "./collaboration-materialization.js";
import { CollaborationDocumentError } from "./collaboration-document.js";
import { InvalidYjsUpdateError } from "./yjs-validation.js";

const maxPendingValidationTasks = 64;
const maxPendingValidationBytes = 128 * 1024 * 1024;
const validationTaskTimeoutMs = 5_000;
const maxValidationWorkers = 2;

type ValidationRequest = {
  currentState: Uint8Array;
  update: Uint8Array;
  maxStateBytes: number;
  includeMaterialization?: boolean;
};

export type CollaborationValidationResult = {
  stateUpdate: Buffer;
  incrementalUpdate: Buffer;
  changed: boolean;
  materialization: CollaborationMaterialization | null;
};

type WorkerRequest = {
  id: number;
  currentState: Uint8Array;
  update: Uint8Array;
  maxStateBytes: number;
  includeMaterialization: boolean;
};

type WorkerSuccess = {
  id: number;
  ok: true;
  stateUpdate: Uint8Array;
  incrementalUpdate: Uint8Array;
  changed: boolean;
  materialization: CollaborationMaterialization | null;
};

type WorkerFailure = {
  id: number;
  ok: false;
  kind: "invalid-yjs" | "invalid-document" | "internal";
  code?: string;
  message: string;
};

type WorkerResponse = WorkerSuccess | WorkerFailure;

type PendingTask = {
  id: number;
  request: WorkerRequest;
  validationBytes: number;
  resolve: (result: CollaborationValidationResult) => void;
  reject: (error: unknown) => void;
};

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

function workerModuleUrl() {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./collaboration-update-worker${extension}`, import.meta.url);
}

function resolveWorkerCount() {
  const parallelism = availableParallelism();
  return Math.max(1, Math.min(maxValidationWorkers, parallelism > 1 ? parallelism - 1 : 1));
}

function toWorkerError(response: WorkerFailure) {
  if (response.kind === "invalid-yjs") return new InvalidYjsUpdateError(response.message);
  if (response.kind === "invalid-document") {
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
  private closed = false;

  constructor(workerCount = resolveWorkerCount()) {
    this.workerCount = Math.max(1, Math.min(maxValidationWorkers, Math.floor(workerCount)));
  }

  validate(request: ValidationRequest): Promise<CollaborationValidationResult> {
    if (this.closed) return Promise.reject(new Error("Collaboration validation pool is closed"));
    this.ensureWorkers();
    const activeTasks = this.slots.reduce((count, slot) => count + (slot.activeTask ? 1 : 0), 0);
    const validationBytes = request.currentState.byteLength + request.update.byteLength;
    if (
      activeTasks + this.queue.length >= maxPendingValidationTasks
      || validationBytes > maxPendingValidationBytes - this.pendingValidationBytes
    ) {
      return Promise.reject(new CollaborationValidationCapacityError());
    }

    const id = this.nextTaskId++;
    const workerRequest: WorkerRequest = {
      id,
      currentState: request.currentState,
      update: request.update,
      maxStateBytes: request.maxStateBytes,
      includeMaterialization: request.includeMaterialization === true
    };
    return new Promise((resolve, reject) => {
      this.pendingValidationBytes += validationBytes;
      this.queue.push({ id, request: workerRequest, validationBytes, resolve, reject });
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
      this.releaseTaskBytes(task);
      task.reject(error);
    }
    await Promise.allSettled(this.slots.map(async (slot) => {
      slot.failed = true;
      if (slot.timeout) clearTimeout(slot.timeout);
      slot.timeout = null;
      if (slot.activeTask) {
        this.releaseTaskBytes(slot.activeTask);
        slot.activeTask.reject(error);
      }
      slot.activeTask = null;
      slot.worker.removeAllListeners();
      await slot.worker.terminate();
    }));
  }

  private ensureWorkers() {
    while (this.slots.length < this.workerCount) {
      this.slots.push(this.createWorkerSlot(this.slots.length));
    }
  }

  private createWorkerSlot(index: number): WorkerSlot {
    const worker = new Worker(workerModuleUrl(), {
      name: `brainvault-collab-${index + 1}`
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

    slot.activeTask = null;
    if (slot.timeout) clearTimeout(slot.timeout);
    slot.timeout = null;
    this.releaseTaskBytes(task);
    slot.worker.unref();
    if (response.ok) {
      task.resolve({
        stateUpdate: Buffer.from(response.stateUpdate),
        incrementalUpdate: Buffer.from(response.incrementalUpdate),
        changed: response.changed,
        materialization: response.materialization
      });
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
      this.releaseTaskBytes(slot.activeTask);
      slot.activeTask.reject(error);
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

  private releaseTaskBytes(task: PendingTask) {
    this.pendingValidationBytes = Math.max(0, this.pendingValidationBytes - task.validationBytes);
  }

  private dispatch() {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.failed || slot.activeTask || !this.queue.length) continue;
      const task = this.queue.shift();
      if (!task) return;
      slot.activeTask = task;
      slot.worker.ref();
      const timeout = setTimeout(() => {
        if (slot.activeTask?.id !== task.id) return;
        this.failWorkerSlot(slot, new CollaborationValidationTimeoutError());
      }, validationTaskTimeoutMs);
      timeout.unref();
      slot.timeout = timeout;
      try {
        slot.worker.postMessage(task.request);
      } catch (error) {
        if (slot.timeout) clearTimeout(slot.timeout);
        slot.timeout = null;
        slot.activeTask = null;
        this.releaseTaskBytes(task);
        slot.worker.unref();
        task.reject(error);
        this.failWorkerSlot(slot, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
