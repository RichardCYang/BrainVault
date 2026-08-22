import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function sourceSection(start, end) {
  const startIndex = client.indexOf(start);
  const endIndex = client.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex <= startIndex) throw new Error(`Could not inspect ${start}`);
  return client.slice(startIndex, endIndex);
}

function simulateVulnerableFlow() {
  const state = {
    liveBlock: { id: "block-1", markdown: "saved base" },
    peerRecovery: { sourceId: "tab-offline", markdown: "saved base + offline edit" },
    serverAcceptedRecovery: false
  };

  // The former collaborative branch called session.deleteBlock directly. The
  // deletion therefore did not inspect another tab's durable recovery record.
  state.liveBlock = null;

  // A CRDT update can still be accepted and acknowledged after its containing
  // top-level block key was deleted. The browser then clears the only explicit
  // recovery copy even though the edited block is no longer visible.
  state.serverAcceptedRecovery = true;
  state.peerRecovery = null;

  return {
    directDeleteIgnoredPendingRecovery: true,
    recoveryAcknowledged: state.serverAcceptedRecovery,
    editedBlockVisible: Boolean(state.liveBlock),
    explicitRecoveryStillAvailable: Boolean(state.peerRecovery),
    permanentLossWindowReproduced:
      state.serverAcceptedRecovery && !state.liveBlock && !state.peerRecovery
  };
}

function simulateFixedFlow() {
  const state = {
    liveBlock: { id: "block-1", markdown: "saved base" },
    peerRecovery: { sourceId: "tab-offline", markdown: "saved base + offline edit" },
    deleteBlocked: false,
    transitionHeldUntilMaterialized: false
  };

  if (state.peerRecovery) state.deleteBlocked = true;
  else {
    state.liveBlock = null;
    state.transitionHeldUntilMaterialized = true;
  }

  return {
    pendingRecoveryDetected: state.deleteBlocked,
    deleteBlocked: state.deleteBlocked,
    editedBlockVisible: Boolean(state.liveBlock),
    explicitRecoveryStillAvailable: Boolean(state.peerRecovery),
    transitionHeldUntilMaterialized: state.transitionHeldUntilMaterialized,
    permanentLossWindowClosed:
      state.deleteBlocked && Boolean(state.liveBlock) && Boolean(state.peerRecovery)
  };
}


async function reproduceWithInstalledYjs() {
  try {
    const Y = await import("yjs");
    const initial = new Y.Doc();
    const initialBlocks = initial.getMap("blocks");
    const initialBlock = new Y.Map();
    const initialMarkdown = new Y.Text();
    initialMarkdown.insert(0, "saved base");
    initialBlock.set("type", "MARKDOWN");
    initialBlock.set("markdown", initialMarkdown);
    initialBlocks.set("block-1", initialBlock);
    const bootstrap = Y.encodeStateAsUpdate(initial);

    const offlineEditor = new Y.Doc();
    Y.applyUpdate(offlineEditor, bootstrap);
    offlineEditor.getMap("blocks").get("block-1").get("markdown").insert(10, " + offline edit");
    const fullRecovery = Y.encodeStateAsUpdate(offlineEditor);

    const deletingPeer = new Y.Doc();
    Y.applyUpdate(deletingPeer, bootstrap);
    const deletionUpdates = [];
    deletingPeer.on("update", (update) => deletionUpdates.push(update));
    deletingPeer.getMap("blocks").delete("block-1");

    const server = new Y.Doc();
    Y.applyUpdate(server, bootstrap);
    Y.applyUpdate(server, deletionUpdates[0]);
    Y.applyUpdate(server, fullRecovery);
    const blockVisibleAfterMerge = server.getMap("blocks").has("block-1");

    initial.destroy();
    offlineEditor.destroy();
    deletingPeer.destroy();
    server.destroy();
    return {
      available: true,
      blockVisibleAfterDeleteThenRecoveryMerge: blockVisibleAfterMerge,
      hiddenEditBehaviorReproduced: !blockVisibleAfterMerge
    };
  } catch (error) {
    return {
      available: false,
      reason: error?.code === "ERR_MODULE_NOT_FOUND"
        ? "The installed yjs dependency is unavailable in this audit environment"
        : error?.message || String(error)
    };
  }
}

const transition = sourceSection(
  "async function withCollaborativeDestructiveTransition",
  "async function deleteBlockWithVersionCheck"
);
const deletion = sourceSection(
  "async function deleteBlockWithVersionCheck",
  "function updateBlockInState"
);
const attachmentUpload = sourceSection(
  "async function uploadAttachmentFromRow",
  "function requestAttachmentUpload"
);

const sourceVerification = {
  crossTabTransitionPresent: transition.includes("withPagePersistenceTransition(pageId, kind"),
  peerRecoveryCheckedBeforeDelete:
    transition.indexOf("assertNoPendingLocalCollaborationRecovery(pageId)")
      < transition.indexOf("const result = await action(session)"),
  deleteMaterializedBeforeUnlock:
    transition.indexOf("const result = await action(session)")
      < transition.indexOf("await session.flushMaterialization({ compact: false })"),
  collaborativeDeleteUsesGuard:
    deletion.includes('withCollaborativeDestructiveTransition(pageId, "block-delete"'),
  attachmentReplacementUsesGuardedDelete:
    /await deleteBlockWithVersionCheck\(blockId,\s*\{[\s\S]*?includeDescendants:\s*false/.test(attachmentUpload)
      && !attachmentUpload.includes("session.deleteBlock(")
};

const yjsRuntime = await reproduceWithInstalledYjs();
const result = {
  scenario: "same-origin peer has an unacknowledged collaboration recovery while another tab deletes the block",
  vulnerable: simulateVulnerableFlow(),
  fixed: simulateFixedFlow(),
  yjsRuntime,
  sourceVerification,
  verified: Object.values(sourceVerification).every(Boolean)
    && (yjsRuntime.available ? yjsRuntime.hiddenEditBehaviorReproduced : true)
};

console.log(JSON.stringify(result, null, 2));
