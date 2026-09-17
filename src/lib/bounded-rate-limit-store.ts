import type { Store, Options, ClientRateLimitInfo, IncrementResponse } from "express-rate-limit";

export const defaultRateLimitMaxKeys = 10_000;
type Counter = { totalHits: number; expiresAt: number };

/** A bounded, process-local fixed-window store. Never evict a live counter:
 * doing so would let key churn reset a victim's brute-force budget. At capacity,
 * new keys fail closed through the normal 429 handler without allocating state.
 */
export class BoundedRateLimitStore implements Store {
  readonly localKeys = true;
  private readonly counters = new Map<string, Counter>();
  private readonly maxKeys: number;
  private readonly clock: () => number;
  private windowMs = 60_000;
  private lastNow = 0;

  constructor(maxKeys = defaultRateLimitMaxKeys, clock: () => number = Date.now) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new RangeError("Invalid rate-limit key capacity");
    this.maxKeys = maxKeys;
    this.clock = clock;
  }

  init(options: Options): void {
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new RangeError("Invalid rate-limit window");
    }
    this.windowMs = options.windowMs;
  }

  get size(): number { return this.counters.size; }

  private now(): number {
    // Preserve expiry ordering even when the wall clock moves backwards.
    this.lastNow = Math.max(this.lastNow, this.clock());
    return this.lastNow;
  }

  private prune(now: number): void {
    // Fixed windows and insertion order make this amortized O(1), rather than
    // scanning all live keys for each hostile request at the capacity boundary.
    for (const [key, counter] of this.counters) {
      if (counter.expiresAt > now) break;
      this.counters.delete(key);
    }
  }

  private info(counter: Counter): ClientRateLimitInfo {
    return { totalHits: counter.totalHits, resetTime: new Date(counter.expiresAt) };
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    this.prune(this.now());
    const counter = this.counters.get(key);
    return counter ? this.info(counter) : undefined;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const now = this.now();
    this.prune(now);
    let counter = this.counters.get(key);
    if (!counter) {
      if (this.counters.size >= this.maxKeys) {
        const oldest = this.counters.values().next().value as Counter;
        return { totalHits: Number.MAX_SAFE_INTEGER, resetTime: new Date(oldest.expiresAt) };
      }
      counter = { totalHits: 0, expiresAt: now + this.windowMs };
      this.counters.set(key, counter);
    }
    counter.totalHits = Math.min(Number.MAX_SAFE_INTEGER, counter.totalHits + 1);
    return this.info(counter);
  }

  async decrement(key: string): Promise<void> {
    this.prune(this.now());
    const counter = this.counters.get(key);
    if (counter && counter.totalHits > 0) counter.totalHits -= 1;
    // Retain zero-count entries until expiry: late completion callbacks must
    // not refund a newly-admitted counter for the same key within this window.
  }

  async resetKey(key: string): Promise<void> { this.counters.delete(key); }
  async resetAll(): Promise<void> { this.counters.clear(); }
  shutdown(): void { this.counters.clear(); }
}
