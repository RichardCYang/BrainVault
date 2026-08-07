import assert from "node:assert/strict";
import {
  getCollaborationAvatarData,
  maxCollaborationAvatarDataUrlBytes
} from "../src/lib/collaboration-presence.ts";
import {
  assessCollaborationHistoryReplay,
  assessCollaborationUpdatePersistence,
  maxCollaborationRetainedHistoryBytes,
  maxCollaborationRetainedHistoryEntries,
  minCollaborationSnapshotHistoryEntries,
  shouldCompactCollaborationHistory
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

const incrementalUpdateBytes = 1024;
const sustainedAttackMinutes = 24 * 60;
const sustainedAttackUpdates = framesPerMinute * sustainedAttackMinutes;
const legacyHistoryEntries = sustainedAttackUpdates;
const legacyHistoryBytes = sustainedAttackUpdates * incrementalUpdateBytes;
const compactedStateBytes = 256 * 1024;
let fixedHistoryEntries = 0;
let fixedHistoryBytes = 0;
let serverCompactions = 0;
for (let index = 0; index < sustainedAttackUpdates; index += 1) {
  const compact = shouldCompactCollaborationHistory({
    clientSnapshot: false,
    historyEntries: fixedHistoryEntries,
    historyBytes: fixedHistoryBytes,
    nextUpdateBytes: incrementalUpdateBytes
  });
  if (compact) {
    serverCompactions += 1;
    fixedHistoryEntries = 1;
    fixedHistoryBytes = compactedStateBytes;
  } else {
    fixedHistoryEntries += 1;
    fixedHistoryBytes += incrementalUpdateBytes;
  }
  assert.ok(fixedHistoryEntries <= maxCollaborationRetainedHistoryEntries);
  assert.ok(fixedHistoryBytes <= maxCollaborationRetainedHistoryBytes);
}
assert.ok(serverCompactions > 0);
assert.deepEqual(
  assessCollaborationHistoryReplay({
    historyEntries: legacyHistoryEntries,
    historyBytes: legacyHistoryBytes
  }),
  { accepted: false, reason: "entry-limit" }
);

// A byte cap equal to the maximum document size would rewrite a full 16 MiB
// state after every tiny edit once the document reached that size. The final
// policy reserves a delta window and separates cooperative (200) from forced
// compaction, so the guard itself does not become a write-amplification DoS.
const nearLimitStateBytes = maxSnapshotBytes;
const legacyForcedEntryLimit = minCollaborationSnapshotHistoryEntries;
const legacyForcedByteLimit = maxSnapshotBytes;
let legacyLargeDocumentEntries = 1;
let legacyLargeDocumentBytes = nearLimitStateBytes;
let legacyLargeDocumentCompactions = 0;
let fixedLargeDocumentEntries = 1;
let fixedLargeDocumentBytes = nearLimitStateBytes;
let fixedLargeDocumentCompactions = 0;
for (let index = 0; index < sustainedAttackUpdates; index += 1) {
  const legacyCompact = legacyLargeDocumentEntries >= legacyForcedEntryLimit
    || incrementalUpdateBytes > legacyForcedByteLimit - legacyLargeDocumentBytes;
  if (legacyCompact) {
    legacyLargeDocumentCompactions += 1;
    legacyLargeDocumentEntries = 1;
    legacyLargeDocumentBytes = nearLimitStateBytes;
  } else {
    legacyLargeDocumentEntries += 1;
    legacyLargeDocumentBytes += incrementalUpdateBytes;
  }

  const fixedCompact = shouldCompactCollaborationHistory({
    clientSnapshot: false,
    historyEntries: fixedLargeDocumentEntries,
    historyBytes: fixedLargeDocumentBytes,
    nextUpdateBytes: incrementalUpdateBytes
  });
  if (fixedCompact) {
    fixedLargeDocumentCompactions += 1;
    fixedLargeDocumentEntries = 1;
    fixedLargeDocumentBytes = nearLimitStateBytes;
  } else {
    fixedLargeDocumentEntries += 1;
    fixedLargeDocumentBytes += incrementalUpdateBytes;
  }
}
const legacyLargeDocumentSnapshotBytes = legacyLargeDocumentCompactions * nearLimitStateBytes;
const fixedLargeDocumentSnapshotBytes = fixedLargeDocumentCompactions * nearLimitStateBytes;
assert.ok(legacyLargeDocumentCompactions / fixedLargeDocumentCompactions > 1_000);
assert.ok(fixedLargeDocumentBytes <= maxCollaborationRetainedHistoryBytes);

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
  historyRetention: {
    attackDurationHours: sustainedAttackMinutes / 60,
    incrementalUpdateBytes,
    legacyEntries: legacyHistoryEntries,
    legacyMiB: Number((legacyHistoryBytes / 1024 ** 2).toFixed(2)),
    fixedEntries: fixedHistoryEntries,
    fixedMiB: Number((fixedHistoryBytes / 1024 ** 2).toFixed(2)),
    serverCompactions,
    retainedEntryLimit: maxCollaborationRetainedHistoryEntries,
    retainedMiBLimit: maxCollaborationRetainedHistoryBytes / 1024 ** 2
  },
  largeDocumentCompaction: {
    stateMiB: nearLimitStateBytes / 1024 ** 2,
    legacyCompactions: legacyLargeDocumentCompactions,
    fixedCompactions: fixedLargeDocumentCompactions,
    legacySnapshotWriteTiB: Number((legacyLargeDocumentSnapshotBytes / 1024 ** 4).toFixed(2)),
    fixedSnapshotWriteGiB: Number((fixedLargeDocumentSnapshotBytes / 1024 ** 3).toFixed(2))
  },
  cookie: { ambiguousDuplicateAccepted: false },
  logging: { original: sensitiveSearchUrl, sanitized: stripUrlQueryAndFragment(sensitiveSearchUrl) }
}, null, 2));
