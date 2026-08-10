import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAuthSessionCookieName,
  legacyAuthSessionCookieName,
  readUniqueCookieValue,
  secureAuthSessionCookieName
} from "../src/lib/session-cookie-policy.ts";
import {
  developmentAccessLogFormat,
  productionAccessLogFormat,
  stripUrlQueryAndFragment
} from "../src/lib/access-log.ts";
import {
  getCollaborationAvatarData,
  maxCollaborationAvatarDataUrlBytes
} from "../src/lib/collaboration-presence.ts";
import {
  assessAttachmentFileCountLimit,
  assessAttachmentStorageLimit
} from "../src/lib/attachment-storage-limit.ts";
import { isPrivateAddress } from "../src/lib/network-address.ts";
import {
  assessCollaborationHistoryReplay,
  assessCollaborationUpdatePersistence,
  maxCollaborationHistoryReplayBytes,
  maxCollaborationHistoryReplayEntries,
  maxCollaborationRetainedHistoryBytes,
  maxCollaborationRetainedHistoryEntries,
  minCollaborationSnapshotHistoryEntries,
  shouldCompactCollaborationHistory
} from "../src/lib/collaboration-update-policy.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8").replace(/\r\n/g, "\n");

test("deprecated IPv6 site-local addresses remain blocked as non-public SSRF targets", () => {
  assert.equal(isPrivateAddress("fec0::1"), true);
  assert.equal(isPrivateAddress("feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), true);
  assert.equal(isPrivateAddress("ff00::1"), true);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("attachment storage quotas use overflow-safe bigint accounting", () => {
  assert.deepEqual(assessAttachmentStorageLimit(900n, 100n, 1_000n), { accepted: true, nextBytes: 1_000n });
  assert.deepEqual(assessAttachmentStorageLimit(900n, 101n, 1_000n), { accepted: false, reason: "quota-exceeded" });
  assert.deepEqual(
    assessAttachmentStorageLimit(2n ** 100n, 1n, 2n ** 100n),
    { accepted: false, reason: "quota-exceeded" }
  );
  assert.throws(() => assessAttachmentStorageLimit(-1n, 0n, 1n), /non-negative/);
  assert.deepEqual(assessAttachmentFileCountLimit(4_999, 1, 5_000), { accepted: true, nextFiles: 5_000 });
  assert.deepEqual(
    assessAttachmentFileCountLimit(5_000, 1, 5_000),
    { accepted: false, reason: "file-count-exceeded" }
  );
  assert.throws(() => assessAttachmentFileCountLimit(0.5, 1, 5_000), /safe integers/);
});

test("secure sessions use a __Host cookie and ambiguous duplicate cookies fail closed", () => {
  assert.equal(getAuthSessionCookieName(false), legacyAuthSessionCookieName);
  assert.equal(getAuthSessionCookieName(true), secureAuthSessionCookieName);
  assert.equal(secureAuthSessionCookieName, "__Host-brainvault_session");
  assert.equal(readUniqueCookieValue("theme=dark; brainvault_session=valid", legacyAuthSessionCookieName), "valid");
  assert.equal(
    readUniqueCookieValue(
      "brainvault_session=parent-domain; theme=dark; brainvault_session=host-only",
      legacyAuthSessionCookieName
    ),
    null
  );
  assert.equal(readUniqueCookieValue("brainvault_session=%E0%A4%A", legacyAuthSessionCookieName), null);
});

test("access log tokens remove note search terms and referrer query data", () => {
  assert.equal(stripUrlQueryAndFragment("/api/search?q=merger+notes&page=2"), "/api/search");
  assert.equal(stripUrlQueryAndFragment("https://vault.example/page?token=secret#fragment"), "https://vault.example/page");
  assert.equal(stripUrlQueryAndFragment("?q=secret"), "-");
  assert.match(productionAccessLogFormat, /:safe-url/);
  assert.match(productionAccessLogFormat, /:safe-referrer/);
  assert.doesNotMatch(productionAccessLogFormat, /:url\b|:referrer\b/);
  assert.match(developmentAccessLogFormat, /:safe-url/);
});

test("collaboration identity payloads have a strict avatar budget", () => {
  const atLimit = "a".repeat(maxCollaborationAvatarDataUrlBytes);
  const overLimit = `${atLimit}a`;
  assert.equal(getCollaborationAvatarData(atLimit), atLimit);
  assert.equal(getCollaborationAvatarData(overLimit), null);
  assert.equal(getCollaborationAvatarData(null), null);
});

test("Yjs replay and compaction policy rejects resource-amplifying no-op work", () => {
  assert.deepEqual(
    assessCollaborationUpdatePersistence({ snapshot: false, documentChanged: false, historyEntries: 500 }),
    { action: "ignore", reason: "no-document-change" }
  );
  assert.deepEqual(
    assessCollaborationUpdatePersistence({ snapshot: false, documentChanged: true, historyEntries: 0 }),
    { action: "persist" }
  );
  assert.deepEqual(
    assessCollaborationUpdatePersistence({
      snapshot: true,
      documentChanged: true,
      historyEntries: minCollaborationSnapshotHistoryEntries
    }),
    { action: "reject", reason: "snapshot-changed-document" }
  );
  assert.deepEqual(
    assessCollaborationUpdatePersistence({
      snapshot: true,
      documentChanged: false,
      historyEntries: minCollaborationSnapshotHistoryEntries - 1
    }),
    { action: "reject", reason: "snapshot-too-early" }
  );
  assert.deepEqual(
    assessCollaborationUpdatePersistence({
      snapshot: true,
      documentChanged: false,
      historyEntries: minCollaborationSnapshotHistoryEntries
    }),
    { action: "persist" }
  );
});

test("server-enforced Yjs history retention bounds durable replay work", () => {
  assert.ok(maxCollaborationRetainedHistoryEntries > minCollaborationSnapshotHistoryEntries);
  assert.deepEqual(
    shouldCompactCollaborationHistory({
      clientSnapshot: false,
      historyEntries: maxCollaborationRetainedHistoryEntries - 1,
      historyBytes: 1024,
      nextUpdateBytes: 1024
    }),
    false
  );
  assert.equal(
    shouldCompactCollaborationHistory({
      clientSnapshot: false,
      historyEntries: maxCollaborationRetainedHistoryEntries,
      historyBytes: 1024,
      nextUpdateBytes: 1024
    }),
    true
  );
  assert.equal(
    shouldCompactCollaborationHistory({
      clientSnapshot: false,
      historyEntries: 1,
      historyBytes: maxCollaborationRetainedHistoryBytes,
      nextUpdateBytes: 1
    }),
    true
  );
  assert.equal(
    shouldCompactCollaborationHistory({
      clientSnapshot: true,
      historyEntries: 1,
      historyBytes: 1,
      nextUpdateBytes: 1
    }),
    true
  );

  assert.deepEqual(
    assessCollaborationHistoryReplay({
      historyEntries: maxCollaborationRetainedHistoryEntries,
      historyBytes: maxCollaborationRetainedHistoryBytes
    }),
    { accepted: true, compact: false }
  );
  assert.deepEqual(
    assessCollaborationHistoryReplay({
      historyEntries: maxCollaborationRetainedHistoryEntries + 1,
      historyBytes: maxCollaborationRetainedHistoryBytes + 1
    }),
    { accepted: true, compact: true }
  );
  assert.deepEqual(
    assessCollaborationHistoryReplay({
      historyEntries: maxCollaborationHistoryReplayEntries + 1,
      historyBytes: 1
    }),
    { accepted: false, reason: "entry-limit" }
  );
  assert.deepEqual(
    assessCollaborationHistoryReplay({
      historyEntries: 1,
      historyBytes: maxCollaborationHistoryReplayBytes + 1
    }),
    { accepted: false, reason: "byte-limit" }
  );
  assert.deepEqual(
    assessCollaborationHistoryReplay({ historyEntries: -1, historyBytes: 0 }),
    { accepted: false, reason: "invalid-metrics" }
  );
});

test("the production wiring preserves identity while removing repeated high-cost fan-out", () => {
  const server = read("src/lib/collaboration-server.ts");
  const client = read("public/collaboration.js");
  const yjsValidation = read("src/lib/yjs-validation.ts");
  const collaborationRoutes = read("src/routes/collaboration.routes.ts");
  const sessionCookie = read("src/lib/session-cookie.ts");
  const app = read("src/app.ts");
  const attachmentSource = read("src/lib/attachments.ts");
  const blockRoutes = read("src/routes/block.routes.ts");
  const dataTransfer = read("src/lib/data-transfer.ts");
  const envSource = read("src/config/env.ts");

  assert.match(yjsValidation, /changed: !Buffer\.from\(currentState\)\.equals\(Buffer\.from\(stateUpdate\)\)/);
  assert.match(server, /persistenceDecision\.action === "ignore"/);
  assert.match(server, /persistenceDecision\.action === "reject"/);
  assert.match(server, /shouldCompactCollaborationHistory/);
  assert.match(server, /durableSnapshot \? \[row\]/);
  assert.match(server, /SUM\(OCTET_LENGTH\(update_data\)\)/);
  assert.match(
    server,
    /UPDATE page_yjs_updates[\s\S]*SET update_data = \?, is_snapshot = 1[\s\S]*WHERE page_id = \? AND id = \?/
  );
  assert.match(server, /const envelope = updateEnvelope\(result\.updateId, update\)/);
  assert.match(server, /updateEnvelope\(room\.maxUpdateId, room\.stateUpdate\)/);
  assert.doesNotMatch(server, /for \(const row of room\.history\) connection\.sendBinary/);
  assert.match(yjsValidation, /canonicalCurrentState/);
  assert.match(collaborationRoutes, /COLLABORATION_HISTORY_REPLAY_LIMIT/);
  assert.match(collaborationRoutes, /SUM\(OCTET_LENGTH\(update_data\)\)/);
  assert.match(server, /type: "compaction-complete"/);
  assert.match(server, /publicPresence\(client, includeIdentity\)/);
  assert.match(server, /includeIdentity: true/);
  assert.match(client, /this\.presence\.set\(message\.connectionId, \{ \.\.\.previous, \.\.\.message \}\)/);
  assert.match(client, /message\.type === "compaction-complete"/);
  assert.match(sessionCookie, /getAuthSessionCookieName\(secureSessionCookie\)/);
  assert.match(sessionCookie, /readUniqueCookieValue/);
  assert.match(app, /productionAccessLogFormat : developmentAccessLogFormat/);
  assert.doesNotMatch(app, /morgan\([^\n]*(?:"combined"|"dev")/);
  assert.match(envSource, /ATTACHMENT_STORAGE_MAX_MB:[^\n]+default\(2048\)/);
  assert.match(attachmentSource, /getAttachmentStorageUsage/);
  assert.match(attachmentSource, /ATTACHMENT_STORAGE_QUOTA_EXCEEDED/);
  assert.match(attachmentSource, /ATTACHMENT_FILE_COUNT_LIMIT_EXCEEDED/);
  assert.match(blockRoutes, /currentAttachmentUsage\.bytes/);
  assert.match(blockRoutes, /currentAttachmentUsage\.files/);
  assert.match(dataTransfer, /assertAttachmentStorageLimit\([\s\S]*?restoredAttachmentBytes[\s\S]*?manifest\.attachments\.length \+ retainedAttachments\.length[\s\S]*?\)/);
});
