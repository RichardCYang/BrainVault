import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { enforceAbsoluteRequestDeadline } from "../src/lib/request-deadline.ts";

class FakeRequest extends EventEmitter {
  destroyedWith = null;

  destroy(error) {
    this.destroyedWith = error ?? null;
    return this;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("an absolute request deadline fires despite continued socket activity", async () => {
  const request = new FakeRequest();
  enforceAbsoluteRequestDeadline(request, 20, () => Object.assign(new Error("deadline"), {
    code: "BOOKMARK_FETCH_TIMEOUT"
  }));

  for (let index = 0; index < 4; index += 1) {
    request.emit("activity");
    await sleep(10);
  }

  assert.equal(request.destroyedWith?.code, "BOOKMARK_FETCH_TIMEOUT");
});

test("closing a request cancels its absolute deadline", async () => {
  const request = new FakeRequest();
  enforceAbsoluteRequestDeadline(request, 20, () => new Error("deadline"));
  request.emit("close");
  await sleep(40);

  assert.equal(request.destroyedWith, null);
});
