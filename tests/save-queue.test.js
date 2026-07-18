import { describe, expect, it } from "vitest";
import { createLatestWriteQueue } from "../public/save-queue.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Latest write queue", () => {
  it("serializes writes and coalesces queued values to the latest edit", async () => {
    const first = deferred();
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const queue = createLatestWriteQueue(async (value) => {
      calls.push(value);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (value === "first") await first.promise;
      active -= 1;
      return value;
    });

    const saving = queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("latest");
    await Promise.resolve();
    expect(calls).toEqual(["first"]);

    first.resolve();
    await saving;
    expect(calls).toEqual(["first", "latest"]);
    expect(maxActive).toBe(1);
    expect(queue.busy).toBe(false);
  });

  it("retries a failed in-flight task before a newer queued edit", async () => {
    const firstAttempt = deferred();
    const calls = [];
    let firstCalls = 0;
    const queue = createLatestWriteQueue(async (value) => {
      calls.push(value);
      if (value === "first" && firstCalls++ === 0) await firstAttempt.promise;
      return value;
    });

    const saving = queue.enqueue("first");
    queue.enqueue("latest");
    await Promise.resolve();
    firstAttempt.reject(new Error("response lost after commit"));

    await expect(saving).rejects.toThrow("response lost after commit");
    await expect(queue.flush()).resolves.toBe("latest");
    expect(calls).toEqual(["first", "first", "latest"]);
    expect(queue.busy).toBe(false);
  });

  it("does not resurrect an in-flight task discarded at an authentication boundary", async () => {
    const firstAttempt = deferred();
    const calls = [];
    const queue = createLatestWriteQueue(async (value) => {
      calls.push(value);
      if (value === "old-account") await firstAttempt.promise;
      return value;
    });

    const saving = queue.enqueue("old-account");
    await Promise.resolve();
    queue.discard();
    firstAttempt.reject(new Error("session expired"));

    await expect(saving).rejects.toThrow("session expired");
    expect(queue.busy).toBe(false);
    await expect(queue.enqueue("new-account")).resolves.toBe("new-account");
    expect(calls).toEqual(["old-account", "new-account"]);
  });

  it("preserves a failed task for an explicit retry", async () => {
    let attempts = 0;
    const queue = createLatestWriteQueue(async (value) => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return value;
    });

    await expect(queue.enqueue("draft")).rejects.toThrow("offline");
    expect(queue.busy).toBe(true);
    await expect(queue.flush()).resolves.toBe("draft");
    expect(attempts).toBe(2);
  });
});
