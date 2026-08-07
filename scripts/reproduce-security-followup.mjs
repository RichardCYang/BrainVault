import assert from "node:assert/strict";
import {
  getCollaborationAvatarData,
  maxCollaborationAvatarDataUrlBytes
} from "../src/lib/collaboration-presence.ts";
import {
  assessCollaborationUpdatePersistence,
  minCollaborationSnapshotHistoryEntries
} from "../src/lib/collaboration-update-policy.ts";
import {
  legacyAuthSessionCookieName,
  readUniqueCookieValue
} from "../src/lib/session-cookie-policy.ts";
import { stripUrlQueryAndFragment } from "../src/lib/access-log.ts";

const maxProfileAvatarBytes = 512 * 1024;
const rawBase64Length = Math.ceil(maxProfileAvatarBytes / 3) * 4;
const maxAvatarDataUrl = `data:image/png;base64,${"A".repeat(rawBase64Length)}`;
const legacyAwareness = JSON.stringify({
  type: "awareness-update",
  connectionId: "attacker",
  user: { id: "u", username: "u", name: "u", avatarData: maxAvatarDataUrl },
  state: { blockId: "b", field: "content", control: null, selection: { anchor: 1, head: 1 } },
  synced: true
});
const fixedAwareness = JSON.stringify({
  type: "awareness-update",
  connectionId: "attacker",
  state: { blockId: "b", field: "content", control: null, selection: { anchor: 1, head: 1 } },
  synced: true
});
const peers = 63;
const framesPerMinute = 600;
const legacyPresenceFanoutBytesPerMinute = Buffer.byteLength(legacyAwareness) * peers * framesPerMinute;
const fixedPresenceFanoutBytesPerMinute = Buffer.byteLength(fixedAwareness) * peers * framesPerMinute;
assert.equal(getCollaborationAvatarData(maxAvatarDataUrl), null);
assert.ok(maxCollaborationAvatarDataUrlBytes < Buffer.byteLength(maxAvatarDataUrl));
assert.ok(legacyPresenceFanoutBytesPerMinute / fixedPresenceFanoutBytesPerMinute > 1_000);

const maxSnapshotBytes = 16 * 1024 * 1024;
const legacySnapshotFanoutBytes = maxSnapshotBytes * 64;
const fixedCompactionControlBytes = Buffer.byteLength(JSON.stringify({ type: "compaction-complete", updateId: 1 })) * peers;
assert.deepEqual(
  assessCollaborationUpdatePersistence({ snapshot: false, documentChanged: false, historyEntries: 500 }),
  { action: "ignore", reason: "no-document-change" }
);
assert.deepEqual(
  assessCollaborationUpdatePersistence({ snapshot: true, documentChanged: false, historyEntries: 1 }),
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
assert.ok(legacySnapshotFanoutBytes / fixedCompactionControlBytes > 100_000);

const ambiguousCookie = `${legacyAuthSessionCookieName}=parent-domain; ${legacyAuthSessionCookieName}=host-only`;
assert.equal(readUniqueCookieValue(ambiguousCookie, legacyAuthSessionCookieName), null);
const sensitiveSearchUrl = "/api/search?q=board+acquisition+target";
assert.equal(stripUrlQueryAndFragment(sensitiveSearchUrl), "/api/search");

console.log(JSON.stringify({
  presence: {
    legacyBytesPerMessage: Buffer.byteLength(legacyAwareness),
    fixedBytesPerMessage: Buffer.byteLength(fixedAwareness),
    legacyFanoutGiBPerMinute: Number((legacyPresenceFanoutBytesPerMinute / 1024 ** 3).toFixed(2)),
    fixedFanoutMiBPerMinute: Number((fixedPresenceFanoutBytesPerMinute / 1024 ** 2).toFixed(2))
  },
  compaction: {
    legacyFanoutMiBPerAcceptedSnapshot: Number((legacySnapshotFanoutBytes / 1024 ** 2).toFixed(2)),
    fixedControlBytesPerAcceptedSnapshot: fixedCompactionControlBytes,
    minimumHistoryEntries: minCollaborationSnapshotHistoryEntries
  },
  cookie: { ambiguousDuplicateAccepted: false },
  logging: { original: sensitiveSearchUrl, sanitized: stripUrlQueryAndFragment(sensitiveSearchUrl) }
}, null, 2));
