// Deterministic model of the collaboration->direct destructive-mode race fixed by
// the client fences in public/app.js. This does not mutate a real workspace.
const expectedSource = Object.freeze({
  id: "target",
  version: 1,
  markdown: ""
});
const peerEditedSource = Object.freeze({
  id: "target",
  version: 2,
  markdown: "important collaborator edit"
});

function vulnerableEmptyDelete({ modeAtCommit, currentSource }) {
  if (modeAtCommit === "collaborative") {
    return {
      deleted: currentSource.version === expectedSource.version
        && currentSource.markdown === expectedSource.markdown
    };
  }

  // Former behavior: switching to direct mode rebuilt expectedVersions from
  // the *current* state, so the newer peer edit itself became deletion consent.
  const freshlySnapshottedVersion = currentSource.version;
  return {
    deleted: currentSource.version === freshlySnapshottedVersion,
    freshlySnapshottedVersion
  };
}

function fixedEmptyDelete({ modeAtCommit, currentSource }) {
  if (modeAtCommit !== "collaborative") {
    return {
      deleted: false,
      reason: "collaborative-intent-crossed-mode-boundary"
    };
  }
  return vulnerableEmptyDelete({ modeAtCommit, currentSource });
}

function vulnerableAttachmentReplacement({ collaborativeAtStart, modeAtCommit, currentSource }) {
  const replaceCurrentBlock = true;
  if (collaborativeAtStart && modeAtCommit === "direct" && replaceCurrentBlock) {
    // Former UI branch reached direct deleteBlockWithVersionCheck(), whose
    // current-version snapshot could authorize deleting the peer-edited source.
    return {
      sourceDeleted: vulnerableEmptyDelete({
        modeAtCommit,
        currentSource
      }).deleted,
      attachmentPreserved: true
    };
  }
  return { sourceDeleted: false, attachmentPreserved: true };
}

function fixedAttachmentReplacement({ collaborativeAtStart, modeAtCommit }) {
  if (collaborativeAtStart && modeAtCommit === "direct") {
    return {
      sourceDeleted: false,
      attachmentPreserved: true,
      canonicalRefresh: true
    };
  }
  return { sourceDeleted: false, attachmentPreserved: true, canonicalRefresh: false };
}

const scenario = {
  steps: [
    "Owner opens a shared page with an empty source block.",
    "Owner starts an empty-block delete or an attachment upload intended to replace that empty block.",
    "The destructive operation waits while collaboration persistence/HTTP work is in flight.",
    "A collaborator edits the source block; then the last share is removed, switching the page to direct mode.",
    "The delayed operation resumes."
  ],
  vulnerableDelete: vulnerableEmptyDelete({
    modeAtCommit: "direct",
    currentSource: peerEditedSource
  }),
  fixedDelete: fixedEmptyDelete({
    modeAtCommit: "direct",
    currentSource: peerEditedSource
  }),
  vulnerableAttachmentReplacement: vulnerableAttachmentReplacement({
    collaborativeAtStart: true,
    modeAtCommit: "direct",
    currentSource: peerEditedSource
  }),
  fixedAttachmentReplacement: fixedAttachmentReplacement({
    collaborativeAtStart: true,
    modeAtCommit: "direct"
  }),
  peerEditedMarkdown: peerEditedSource.markdown
};

console.log(JSON.stringify(scenario, null, 2));
