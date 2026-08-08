export type AttachmentUploadAdmission =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; reason: "principal-active" | "server-capacity" }>;

export class AttachmentUploadAdmissionLease {
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

export class AttachmentUploadAdmissionGate {
  private readonly activePrincipals = new Set<string>();
  readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError("Attachment upload concurrency must be a positive safe integer");
    }
    this.maxConcurrent = maxConcurrent;
  }

  tryAcquire(principal: string): AttachmentUploadAdmission {
    if (!principal) throw new TypeError("Attachment upload principal is required");
    if (this.activePrincipals.has(principal)) {
      return { accepted: false, reason: "principal-active" };
    }
    if (this.activePrincipals.size >= this.maxConcurrent) {
      return { accepted: false, reason: "server-capacity" };
    }
    this.activePrincipals.add(principal);
    return { accepted: true };
  }

  release(principal: string) {
    this.activePrincipals.delete(principal);
  }

  get activeCount() {
    return this.activePrincipals.size;
  }
}
