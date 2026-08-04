export type DataImportAdmission =
  | Readonly<{ accepted: true }>
  | Readonly<{ accepted: false; reason: "principal-active" | "server-capacity" }>;

export class DataImportAdmissionGate {
  private readonly activePrincipals = new Set<string>();
  readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError("Data import concurrency must be a positive safe integer");
    }
    this.maxConcurrent = maxConcurrent;
  }

  tryAcquire(principal: string): DataImportAdmission {
    if (!principal) throw new TypeError("Data import principal is required");
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
