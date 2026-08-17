function createState() {
  return {
    attachmentGeneration: 1,
    liveAttachmentBlocks: new Set(["att_1"]),
    files: new Set(["att_1"])
  };
}

function commitDelete(state, attachmentId) {
  const authorizedGeneration = state.attachmentGeneration;
  state.liveAttachmentBlocks.delete(attachmentId);
  return { attachmentId, authorizedGeneration };
}

function restoreRetainedAttachment(state, attachmentId) {
  state.attachmentGeneration += 1;
  // A restore replaces the whole filesystem generation. Retained attachments are
  // deliberately allowed to exist without a live ATTACHMENT block row.
  state.liveAttachmentBlocks = new Set();
  state.files = new Set([attachmentId]);
}

function vulnerableCleanup(state, cleanup) {
  if (!state.liveAttachmentBlocks.has(cleanup.attachmentId)) {
    state.files.delete(cleanup.attachmentId);
  }
}

function fixedCleanup(state, cleanup) {
  if (state.attachmentGeneration !== cleanup.authorizedGeneration) return;
  if (!state.liveAttachmentBlocks.has(cleanup.attachmentId)) {
    state.files.delete(cleanup.attachmentId);
  }
}

const vulnerable = createState();
const vulnerableCleanupRequest = commitDelete(vulnerable, "att_1");
restoreRetainedAttachment(vulnerable, "att_1");
vulnerableCleanup(vulnerable, vulnerableCleanupRequest);

const fixed = createState();
const fixedCleanupRequest = commitDelete(fixed, "att_1");
restoreRetainedAttachment(fixed, "att_1");
fixedCleanup(fixed, fixedCleanupRequest);

const sameGeneration = createState();
const sameGenerationCleanup = commitDelete(sameGeneration, "att_1");
fixedCleanup(sameGeneration, sameGenerationCleanup);

const liveBlock = createState();
const liveBlockCleanup = {
  attachmentId: "att_1",
  authorizedGeneration: liveBlock.attachmentGeneration
};
fixedCleanup(liveBlock, liveBlockCleanup);

// A failed attachment INSERT can leave its already-moved file behind for a
// post-rollback cleanup. A backup may retain that orphan and a restore may make
// the same path meaningful again before the old request reacquires the user lock.
const vulnerableUploadRollback = createState();
const failedUploadCleanup = {
  attachmentId: "att_1",
  authorizedGeneration: vulnerableUploadRollback.attachmentGeneration
};
vulnerableUploadRollback.liveAttachmentBlocks.delete("att_1");
restoreRetainedAttachment(vulnerableUploadRollback, "att_1");
vulnerableCleanup(vulnerableUploadRollback, failedUploadCleanup);

const fixedUploadRollback = createState();
const fixedFailedUploadCleanup = {
  attachmentId: "att_1",
  authorizedGeneration: fixedUploadRollback.attachmentGeneration
};
fixedUploadRollback.liveAttachmentBlocks.delete("att_1");
restoreRetainedAttachment(fixedUploadRollback, "att_1");
fixedCleanup(fixedUploadRollback, fixedFailedUploadCleanup);

process.stdout.write(JSON.stringify({
  vulnerability: {
    oldCleanupDeletesRestoredRetainedAttachment: !vulnerable.files.has("att_1"),
    failedUploadRollbackDeletesRestoredRetainedAttachment:
      !vulnerableUploadRollback.files.has("att_1")
  },
  fixed: {
    restoreAdvancesAttachmentGeneration: fixed.attachmentGeneration === 2,
    staleCleanupSkipsNewGeneration: fixed.files.has("att_1"),
    failedUploadRollbackSkipsNewGeneration: fixedUploadRollback.files.has("att_1"),
    sameGenerationCleanupStillRemovesDeletedAttachment: !sameGeneration.files.has("att_1"),
    sameGenerationCleanupStillPreservesLiveAttachment: liveBlock.files.has("att_1")
  }
}));
