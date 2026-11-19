import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { changedAccordionImages } from "../src/lib/accordion-image-references.js";
import { assertAttachmentStorageLimit, maxAttachmentStorageBytes } from "../src/lib/attachments.js";
import { DataImportAdmissionGate } from "../src/lib/data-import-admission.js";
import { iconMutationValueSchema } from "../src/lib/icon-value.js";
import { isNewPasswordUncommon } from "../src/lib/password-policy.js";
import { dataExportConcurrencyLimit, finishDataExportProcessing } from "../src/middleware/data-rate-limit.js";

describe("workspace resource boundaries", () => {
  it("keeps the reserved attachment capacity available for the owner", () => {
    const used = maxAttachmentStorageBytes * 3n / 4n;
    expect(() => assertAttachmentStorageLimit(used, 1n, 1, 1, true)).toThrow();
    expect(assertAttachmentStorageLimit(used, 1n, 1, 1).bytes).toBe(used + 1n);
  });

  it("bounds multipart intake independently of server-side restores", () => {
    const gate = new DataImportAdmissionGate(1);
    expect(gate.tryAcquire("upload1").accepted).toBe(true);
    expect(gate.tryAcquire("upload2").accepted).toBe(true);
    expect(gate.tryAcquire("upload3")).toEqual({ accepted: false, reason: "server-capacity" });
    expect(gate.tryAcquire("snapshot", false).accepted).toBe(true);
    expect(gate.tryBeginProcessing("snapshot").accepted).toBe(true);
    gate.release("upload1");
    expect(gate.tryAcquire("upload3").accepted).toBe(true);
  });

  it.each(["close-first", "work-first"])("holds export capacity through work and delivery (%s)", (order) => {
    const req = Object.assign(new EventEmitter(), { user: { id: order } });
    const response = () => Object.assign(new EventEmitter(), { status: vi.fn().mockReturnThis(), json: vi.fn() });
    const res = response();
    const accept = vi.fn();
    dataExportConcurrencyLimit(req as never, res as never, accept);
    expect(accept).toHaveBeenCalledOnce();
    if (order === "close-first") res.emit("close");
    else finishDataExportProcessing(res as never);
    const busy = response();
    dataExportConcurrencyLimit(req as never, busy as never, vi.fn());
    expect(busy.status).toHaveBeenCalledWith(429);
    if (order === "close-first") finishDataExportProcessing(res as never);
    else res.emit("finish");
    const next = response();
    dataExportConcurrencyLimit(req as never, next as never, accept);
    expect(accept).toHaveBeenCalledTimes(2);
    finishDataExportProcessing(next as never);
    next.emit("finish");
  });

  it("preserves a legacy accordion image only on its original item", () => {
    const icon = "image: data:image/png;base64,iVBORw0KGgo=";
    const metadata = (id: string) => ({ accordion: { items: [{ id, icon }] } });
    expect(changedAccordionImages("ACCORDION", metadata("a"), metadata("a"))).toEqual([]);
    expect(changedAccordionImages("ACCORDION", metadata("b"), metadata("a"))).toEqual([icon.replace(": ", ":")]);
    expect(iconMutationValueSchema.safeParse(icon).success).toBe(false);
  });

  it("rejects keyboard prefixes with numeric suffixes and accepts a longer passphrase", () => {
    expect(isNewPasswordUncommon("Qwerty12345!")).toBe(false);
    expect(isNewPasswordUncommon("oranges under winter skies")).toBe(true);
  });
});
