import { reconcileCanonicalAttachment } from "../public/collaboration-attachment-reconcile.js";

function location(block) {
  return {
    parentBlockId: block.parentBlockId ?? null,
    sortOrder: Number(block.sortOrder ?? 0)
  };
}

// This models the previous browser implementation: every collaboration reconnect
// copied all attachment fields, including mutable location, from the relational
// session payload into the already-replayed Yjs document.
function vulnerableReconnectMerge(canonicalAttachment, availableIds) {
  return {
    ...canonicalAttachment,
    parentBlockId: canonicalAttachment.parentBlockId
      && availableIds.has(canonicalAttachment.parentBlockId)
        ? canonicalAttachment.parentBlockId
        : null
  };
}

const staleSqlAttachment = {
  id: "att_1",
  type: "ATTACHMENT",
  markdown: "server-owned.pdf",
  checked: false,
  parentBlockId: "section_before",
  sortOrder: 7,
  metadata: {
    attachment: {
      originalName: "server-owned.pdf",
      mimeType: "application/pdf",
      size: 4096
    }
  }
};

// The move has already received a server ACK and is present in durable Yjs
// history, but the delayed relational materializer has not copied it to SQL yet.
const durableYjsAttachment = {
  ...staleSqlAttachment,
  markdown: "client-forged-name.pdf",
  parentBlockId: "section_after",
  sortOrder: 1,
  metadata: {
    attachment: {
      originalName: "client-forged-name.pdf",
      mimeType: "text/plain",
      size: 1
    }
  }
};

const activeIds = new Set(["section_before", "section_after", "att_1"]);
const vulnerableAfterReconnect = vulnerableReconnectMerge(staleSqlAttachment, activeIds);
// The reconnect merge is emitted as a new local Yjs update, receives an ACK, and
// is then used by the server-authoritative materializer. Therefore the stale SQL
// location becomes durable and overwrites the previously acknowledged move.
const vulnerableAfterMaterialization = { ...vulnerableAfterReconnect };

const fixedAfterReconnect = reconcileCanonicalAttachment(
  staleSqlAttachment,
  durableYjsAttachment,
  activeIds
);
const fixedMissingAttachment = reconcileCanonicalAttachment(
  staleSqlAttachment,
  null,
  activeIds
);
const fixedUnavailableParent = reconcileCanonicalAttachment(
  staleSqlAttachment,
  { ...durableYjsAttachment, parentBlockId: "deleted_parent", sortOrder: 3 },
  activeIds
);

const expectedMovedLocation = location(durableYjsAttachment);
const staleSqlLocation = location(staleSqlAttachment);

const result = {
  scenario: {
    acknowledgedYjsLocation: expectedMovedLocation,
    notYetMaterializedSqlLocation: staleSqlLocation,
    reconnectOccursBeforeRelationalMaterialization: true
  },
  vulnerable: {
    reconnectPublishedLocation: location(vulnerableAfterReconnect),
    materializedLocation: location(vulnerableAfterMaterialization),
    staleSqlLocationRepublishedAsNewYjsUpdate:
      JSON.stringify(location(vulnerableAfterReconnect)) === JSON.stringify(staleSqlLocation),
    acknowledgedMoveSurvived:
      JSON.stringify(location(vulnerableAfterMaterialization)) === JSON.stringify(expectedMovedLocation),
    permanentLossWindowReproduced:
      JSON.stringify(location(vulnerableAfterMaterialization)) !== JSON.stringify(expectedMovedLocation)
  },
  fixed: {
    reconnectPublishedLocation: location(fixedAfterReconnect),
    acknowledgedMoveSurvived:
      JSON.stringify(location(fixedAfterReconnect)) === JSON.stringify(expectedMovedLocation),
    canonicalImmutableContentPreserved:
      fixedAfterReconnect.markdown === staleSqlAttachment.markdown
      && JSON.stringify(fixedAfterReconnect.metadata) === JSON.stringify(staleSqlAttachment.metadata),
    missingAttachmentUsesSqlLocation:
      JSON.stringify(location(fixedMissingAttachment)) === JSON.stringify(staleSqlLocation),
    unavailableCurrentParentFailsClosedToRoot:
      fixedUnavailableParent.parentBlockId === null && fixedUnavailableParent.sortOrder === 3,
    permanentLossWindowClosed:
      JSON.stringify(location(fixedAfterReconnect)) === JSON.stringify(expectedMovedLocation)
  }
};

console.log(JSON.stringify(result, null, 2));
