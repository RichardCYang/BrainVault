/** Process-local, conservative byte reservations; not an RSS/heap measurement. */
export class CollaborationMemoryBudget {
  private bytes = 0;
  readonly maximumBytes: number;
  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError("Collaboration memory budget must be a positive safe integer");
    }
    this.maximumBytes = maximumBytes;
  }
  get reservedBytes() { return this.bytes; }
  reserve(bytes: number): CollaborationMemoryReservation | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maximumBytes - this.bytes) return null;
    this.bytes += bytes;
    return new CollaborationMemoryReservation(bytes, (released) => { this.bytes -= released; });
  }
}

export class CollaborationMemoryReservation {
  private bytes: number;
  private readonly returnBytes: (bytes: number) => void;
  constructor(bytes: number, returnBytes: (bytes: number) => void) {
    this.bytes = bytes;
    this.returnBytes = returnBytes;
  }
  shrinkTo(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.bytes) {
      throw new RangeError("Invalid collaboration memory reservation shrink");
    }
    this.returnBytes(this.bytes - bytes);
    this.bytes = bytes;
  }
  release() { this.shrinkTo(0); }
}
