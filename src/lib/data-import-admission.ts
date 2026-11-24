export type DataImportAdmission =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; reason: "principal-active" | "server-capacity" }>;

export type DataImportProcessingAdmission =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; reason: "server-capacity" | "principal-inactive" }>;

export class DataImportAdmissionLease {
  private state: "waiting" | "processing" | "released" = "waiting";
  private readonly releaseAdmission: () => void;

  constructor(releaseAdmission: () => void) {
    this.releaseAdmission = releaseAdmission;
  }

  beginProcessing() {
    if (this.state !== "waiting") return false;
    this.state = "processing";
    return true;
  }

  releaseBeforeProcessing() {
    if (this.state !== "waiting") return false;
    return this.release();
  }

  release() {
    if (this.state === "released") return false;
    this.state = "released";
    this.releaseAdmission();
    return true;
  }
}

export class DataImportAdmissionGate {
  private readonly activePrincipals = new Set<string>();
  private readonly processingPrincipals = new Set<string>();
  private snapshotRestorePrincipal: string | null = null;
  private snapshotRestoreProcessing = false;
  readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError("Data import concurrency must be a positive safe integer");
    }
    this.maxConcurrent = maxConcurrent;
  }

  // Reserve the principal before multipart parsing so one account cannot start
  // overlapping uploads. This reservation intentionally does not consume a
  // global processing slot while network bytes are still arriving.
  tryAcquire(principal: string, needsUpload = true): DataImportAdmission {
    if (!principal) throw new TypeError("Data import principal is required");
    if (this.activePrincipals.has(principal)) {
      return { accepted: false, reason: "principal-active" };
    }
    if (!needsUpload && this.snapshotRestorePrincipal !== null) {
      return { accepted: false, reason: "server-capacity" };
    }
    const waitingUploads = this.activePrincipals.size - this.processingPrincipals.size
      - Number(this.snapshotRestorePrincipal !== null);
    if (needsUpload && waitingUploads >= this.maxConcurrent * 2) {
      return { accepted: false, reason: "server-capacity" };
    }
    this.activePrincipals.add(principal);
    if (!needsUpload) this.snapshotRestorePrincipal = principal;
    return { accepted: true };
  }

  tryBeginProcessing(principal: string): DataImportProcessingAdmission {
    if (!this.activePrincipals.has(principal)) {
      return { accepted: false, reason: "principal-inactive" };
    }
    if (this.snapshotRestorePrincipal === principal) {
      this.snapshotRestoreProcessing = true;
      return { accepted: true };
    }
    if (this.processingPrincipals.has(principal)) return { accepted: true };
    // Keep a worker for restoring an existing server snapshot even while all
    // workers for uploaded archives are busy.
    if (this.processingPrincipals.size >= Math.max(1, this.maxConcurrent - 1)) {
      return { accepted: false, reason: "server-capacity" };
    }
    this.processingPrincipals.add(principal);
    return { accepted: true };
  }

  release(principal: string) {
    this.processingPrincipals.delete(principal);
    if (this.snapshotRestorePrincipal === principal) {
      this.snapshotRestorePrincipal = null;
      this.snapshotRestoreProcessing = false;
    }
    this.activePrincipals.delete(principal);
  }

  get activeCount() {
    return this.activePrincipals.size;
  }

  get processingCount() {
    return this.processingPrincipals.size + Number(this.snapshotRestoreProcessing);
  }
}
