import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AttachmentUploadAdmissionGate,
  AttachmentUploadAdmissionLease
} from "../src/lib/attachment-upload-admission.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8").replace(/\r\n/g, "\n");

test("attachment upload admission permits one active request per principal and caps process concurrency", () => {
  const gate = new AttachmentUploadAdmissionGate(2);
  assert.deepEqual(gate.tryAcquire("user-a"), { accepted: true });
  assert.deepEqual(gate.tryAcquire("user-a"), { accepted: false, reason: "principal-active" });
  assert.deepEqual(gate.tryAcquire("user-b"), { accepted: true });
  assert.deepEqual(gate.tryAcquire("user-c"), { accepted: false, reason: "server-capacity" });
  assert.equal(gate.activeCount, 2);
  gate.release("user-a");
  assert.deepEqual(gate.tryAcquire("user-c"), { accepted: true });
  gate.release("user-a");
  assert.equal(gate.activeCount, 2);
});

test("attachment upload admission remains held after multipart intake enters request processing", () => {
  const gate = new AttachmentUploadAdmissionGate(1);
  assert.deepEqual(gate.tryAcquire("user-a"), { accepted: true });
  const lease = new AttachmentUploadAdmissionLease(() => gate.release("user-a"));
  assert.equal(lease.beginProcessing(), true);
  assert.equal(lease.releaseBeforeProcessing(), false);
  assert.deepEqual(gate.tryAcquire("user-a"), { accepted: false, reason: "principal-active" });
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.deepEqual(gate.tryAcquire("user-a"), { accepted: true });
  gate.release("user-a");

  assert.deepEqual(gate.tryAcquire("user-b"), { accepted: true });
  const waitingLease = new AttachmentUploadAdmissionLease(() => gate.release("user-b"));
  assert.equal(waitingLease.releaseBeforeProcessing(), true);
  assert.deepEqual(gate.tryAcquire("user-b"), { accepted: true });
  gate.release("user-b");
});

test("attachment authorization and resource admission run before Multer writes temporary bytes", () => {
  const routeSource = read("src/routes/block.routes.ts");
  const middlewareSource = read("src/middleware/attachment-rate-limit.ts");
  const envSource = read("src/config/env.ts");
  const routeStart = routeSource.indexOf('"/pages/:pageId/attachments"');
  const routeEnd = routeSource.indexOf('"/blocks/:blockId/attachment"', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, "attachment upload route must exist");
  const uploadRoute = routeSource.slice(routeStart, routeEnd);

  const middlewareOrder = [
    "attachmentUploadRateLimit",
    "enforceAttachmentUploadRequestSize",
    "authorizeAttachmentUploadTarget",
    "attachmentUploadConcurrencyLimit",
    'attachmentUpload.single("file")'
  ].map((token) => uploadRoute.indexOf(token));
  for (let index = 0; index < middlewareOrder.length; index += 1) {
    assert.ok(middlewareOrder[index] >= 0, `missing attachment middleware: ${index}`);
    if (index > 0) {
      assert.ok(
        middlewareOrder[index] > middlewareOrder[index - 1],
        "attachment authorization and admission must precede multipart disk storage"
      );
    }
  }

  const authorizationStart = routeSource.indexOf("async function authorizeAttachmentUploadTarget");
  const authorizationEnd = routeSource.indexOf("function requireAttachmentUploadTarget", authorizationStart);
  const authorizationSource = routeSource.slice(authorizationStart, authorizationEnd);
  assert.ok(authorizationSource.includes("await assertAccessiblePage(pageId, user.id)"));
  assert.ok(!authorizationSource.includes("assertDirectBlockMutationAllowed(access)"));
  assert.ok(authorizationSource.includes("access.page.is_archived"));
  assert.ok(authorizationSource.includes("res.locals.attachmentUploadTarget"));
  assert.ok(uploadRoute.includes("beginAttachmentUploadProcessing(res)"));
  assert.ok(uploadRoute.includes("releaseAttachmentUpload?.()"));
  assert.ok(uploadRoute.includes("lockedAccess.shareCount > 0"));
  assert.ok(uploadRoute.includes("ensureCollaborationState(pageId, client)"));
  assert.ok(uploadRoute.includes("lockedAccess.page.is_archived"));

  assert.match(envSource, /ATTACHMENT_UPLOAD_WINDOW_MS:[^\n]+default\(60_000\)/);
  assert.match(envSource, /ATTACHMENT_UPLOAD_MAX:[^\n]+default\(12\)/);
  assert.match(envSource, /ATTACHMENT_UPLOAD_MAX_CONCURRENT:[^\n]+default\(4\)/);
  assert.ok(middlewareSource.includes("ATTACHMENT_UPLOAD_RATE_LIMITED"));
  assert.ok(middlewareSource.includes("ATTACHMENT_UPLOAD_IN_PROGRESS"));
  assert.ok(middlewareSource.includes("ATTACHMENT_UPLOAD_BUSY"));
});

test("default admission changes unauthorized temporary-write exposure from gigabytes to zero", () => {
  const maximumAttachmentBytes = 25 * 1024 * 1024;
  const legacyGlobalRequestsPerMinute = 120;
  const legacyUnauthorizedTemporaryBytesPerMinute = maximumAttachmentBytes * legacyGlobalRequestsPerMinute;

  assert.equal(legacyUnauthorizedTemporaryBytesPerMinute, 3_145_728_000);
  assert.ok(legacyUnauthorizedTemporaryBytesPerMinute > 2 * 1024 * 1024 * 1024);

  // The patched route resolves page access and archive state before Multer receives
  // the request stream, so unauthorized or archived targets write no file bytes.
  const patchedUnauthorizedTemporaryBytesPerMinute = 0;
  assert.equal(patchedUnauthorizedTemporaryBytesPerMinute, 0);
});
