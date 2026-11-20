import { afterEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { schedulePreviewRender, waitForPreviewRendering } from "../public/preview-render-queue.js";
import { signAuthToken, verifyAuthToken } from "../src/lib/auth.js";
import { requireRecentAuthentication } from "../src/middleware/auth.js";
import { crc32, ZipWriter } from "../src/lib/zip.js";
import { mapPageBlocks } from "../src/lib/page-resource-limits.js";

afterEach(() => vi.unstubAllGlobals());

describe("browser preview budget", () => {
  it("coalesces updates, skips removed elements, and bounds work per frame and burst", async () => {
    const frames = [];
    vi.stubGlobal("requestAnimationFrame", (fn) => frames.push(fn));
    const render = vi.fn(), stale = vi.fn();
    const first = { isConnected: true };
    schedulePreviewRender(first, stale);
    schedulePreviewRender(first, render);
    schedulePreviewRender({ isConnected: false }, stale);
    for (let i = 0; i < 300; i++) schedulePreviewRender({ isConnected: true }, render);
    const done = waitForPreviewRendering();
    expect(frames).toHaveLength(1);
    frames.shift()();
    expect(render.mock.calls.length).toBeLessThanOrEqual(20);
    while (frames.length) frames.shift()();
    await done;
    expect(render).toHaveBeenCalledTimes(255);
    expect(stale).not.toHaveBeenCalled();
  });
});

describe("sensitive operations", () => {
  it("uses the original sign-in time across a newly signed extension", () => {
    const user = { sub: "usr_example", username: "example", authVersion: 1 };
    const fresh = verifyAuthToken(signAuthToken(user));
    const next = vi.fn();
    requireRecentAuthentication({ auth: fresh }, {}, next);
    expect(next).toHaveBeenCalledWith();
    const extended = verifyAuthToken(signAuthToken({ ...fresh, authenticatedAt: fresh.authenticatedAt - 901 }));
    requireRecentAuthentication({ auth: extended }, {}, next);
    expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ statusCode: 403, code: "RECENT_LOGIN_REQUIRED" }));
    requireRecentAuthentication({ auth: {} }, {}, next);
    expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ code: "RECENT_LOGIN_REQUIRED" }));
  });

  it("stops delivering a buffered archive entry when the delivery check fails", async () => {
    let sent = 0;
    const output = new Writable({ write(chunk, _enc, done) { sent += chunk.length; done(); } });
    const check = vi.fn(async () => { if (sent > 256 * 1024) throw new Error("session ended"); });
    const writer = new ZipWriter(output, check);
    const data = Buffer.alloc(600 * 1024);
    await expect(writer.add({ name: "notes.json", size: BigInt(data.length), crc32: crc32(data),
      source: { kind: "buffer", data } })).rejects.toThrow("session ended");
    expect(sent).toBeLessThan(data.length);
    expect(check.mock.calls.length).toBeGreaterThan(2);
    output.end();
  });
});

it("yields between server render slices and stops a projection over budget", async () => {
  let elapsed = 0;
  vi.stubGlobal("performance", { now: () => elapsed });
  const order = [];
  setImmediate(() => order.push("peer"));
  const result = await mapPageBlocks([1, 2, 3], (row) => {
    elapsed += 13;
    order.push(row);
    return row * 2;
  });
  expect(result).toEqual([2, 4, 6]);
  expect(order).toEqual([1, "peer", 2, 3]);
  await expect(mapPageBlocks([1], () => { elapsed += 15_001; }))
    .rejects.toMatchObject({ statusCode: 413, code: "PAGE_RENDER_LIMIT_EXCEEDED" });
});
