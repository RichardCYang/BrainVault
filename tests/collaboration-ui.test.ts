import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translationCatalogs } from "../public/i18n.js";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const serverApp = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const collaboration = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8");
const collaborationCaret = readFileSync(new URL("../public/collaboration-caret.js", import.meta.url), "utf8");
const exitGuard = readFileSync(new URL("../public/collaboration-exit-guard.js", import.meta.url), "utf8");
const recoveryStore = readFileSync(new URL("../public/collaboration-recovery-store.js", import.meta.url), "utf8");
const transitionLock = readFileSync(new URL("../public/page-transition-lock.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/020_page_sharing_yjs_collaboration.sql", import.meta.url),
  "utf8"
);
const lineageMigration = readFileSync(
  new URL("../migrations/021_collaboration_document_epoch.sql", import.meta.url),
  "utf8"
);
const materializationMigration = readFileSync(
  new URL("../migrations/022_server_authoritative_collaboration_materialization.sql", import.meta.url),
  "utf8"
);
const lineage = readFileSync(new URL("../src/lib/collaboration-lineage.ts", import.meta.url), "utf8");
const token = readFileSync(new URL("../src/lib/collaboration-token.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/lib/collaboration-server.ts", import.meta.url), "utf8");
const yjsValidation = readFileSync(new URL("../src/lib/yjs-validation.ts", import.meta.url), "utf8");
const materialization = readFileSync(
  new URL("../src/lib/collaboration-materialization.ts", import.meta.url),
  "utf8"
);
const collaborationProtocol = readFileSync(
  new URL("../src/lib/collaboration-protocol.ts", import.meta.url),
  "utf8"
);
const routes = readFileSync(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8");

describe("page sharing and Yjs collaboration wiring", () => {
  it("ships owner sharing controls, live status, and collaborator presence surfaces", () => {
    expect(index).toContain('id="share-page-button"');
    expect(index).toContain('id="share-page-layer"');
    expect(index).toContain('id="share-page-username"');
    expect(index).toContain('id="share-page-list"');
    expect(index).toContain('id="collaboration-indicator"');
    expect(index).toContain('id="collaboration-presence"');
    expect(styles).toContain(".share-page-layer");
    expect(styles).toContain(".collaboration-indicator");
    expect(styles).toContain(".collaboration-presence");
    expect(styles).toContain(".remote-collaboration-caret");
    expect(styles).toContain("--remote-caret-color");
  });

  it("pins Yjs and supports persisted updates, reconnect recovery, awareness, and attachment reconciliation", () => {
    expect(collaboration).toContain('const YJS_MODULE_URL = "/vendor/yjs/yjs.mjs";');
    expect(collaboration).not.toContain("https://cdn.jsdelivr.net/npm/yjs@");
    expect(index).toContain('<script type="importmap">{"imports":{"lib0/":"/vendor/yjs/lib0/","isomorphic.js":"/vendor/yjs/isomorphic/browser.mjs"}}</script>');
    expect(serverApp).toContain('app.get("/vendor/yjs/yjs.mjs"');
    expect(serverApp).toContain('    "/vendor/yjs/lib0"');
    expect(serverApp).toContain("'sha256-AQrGHmNf2ToDPODxkNyXldxWl9tWr2pnwbahY0pFneE='");
    expect(collaboration).toContain('const RECOVERY_ORIGIN = Object.freeze({ kind: "recovery" });');
    expect(collaboration.indexOf("const RECOVERY_ORIGIN")).toBeLessThan(
      collaboration.indexOf("origin !== RECOVERY_ORIGIN")
    );
    expect(collaboration).toContain("Y.applyUpdate");
    expect(collaboration).toContain("Y.encodeStateAsUpdate");
    expect(collaboration).toContain("export async function decodeCollaborationRecoveryRecords");
    expect(collaboration).toContain("needsRecovery");
    expect(collaboration).toContain("get hasUnconfirmedLocalChanges()");
    expect(collaboration).toContain("this.startupUpdatePending");
    expect(exitGuard).toContain("assertCollaborationExitSafe");
    expect(recoveryStore).toContain("brainvault.collaborationRecovery.v1");
    expect(recoveryStore).toContain("const recoverySchemaVersion = 2");
    expect(recoveryStore).toContain("documentEpoch");
    expect(recoveryStore).toContain("legacyRecoverySchemaVersion");
    expect(recoveryStore).toContain("loadPageRecords");
    expect(recoveryStore).toContain("loadAccountRecords");
    expect(recoveryStore).toContain("encodedUpdate");
    expect(transitionLock).toContain("brainvault.pageTransition.v1");
    expect(transitionLock).toContain("function acquire(pageId, kind, exclusiveId = pageId)");
    expect(transitionLock).toContain("function loadActive()");
    expect(transitionLock).toContain("async function runExclusive(pageId, action)");
    expect(app).toContain("lockManager: window.navigator.locks");
    expect(app).toContain("withPagePersistenceTransition");
    expect(app).toContain("withWorkspacePersistenceTransition");
    expect(app).toContain("refreshOrphanedCollaborationRecovery");
    expect(collaboration).toContain("persistLocalRecovery");
    expect(collaboration).toContain("restoreLocalRecovery");
    expect(collaboration.indexOf("const session = await this.api")).toBeLessThan(
      collaboration.indexOf("this.restoreLocalRecovery(documentEpoch)")
    );
    expect(collaboration).toContain("body: { documentEpochProtocol: 2 }");
    expect(collaboration).toContain('from "./collaboration-attachment-reconcile.js"');
    expect(collaboration).toContain("reconcileCanonicalAttachment(candidate, current, availableIds)");
    expect(collaboration).toContain("!this.deletedAttachments.has(id)");
    expect(collaboration).toContain("record.documentEpoch === documentEpoch");
    expect(collaboration).toContain("different document versions cannot be merged");
    expect(collaboration).toContain("clearLocalRecovery");
    expect(collaboration).toContain("The collaboration recovery state could not be encoded for synchronization");
    expect(collaboration).toContain("The collaboration snapshot could not be queued");
    expect(collaboration).toContain("if (this.sendDocumentUpdate(fullStateUpdate)) this.needsRecovery = false");
    expect(collaboration).toContain("shouldClearLocalRecoveryAfterAck(this.pendingLocalUpdates, this.needsRecovery)");
    expect(collaboration).toContain("if (this.startupUpdatePending && !this.needsRecovery)");
    expect(collaboration).toContain("if (flush && this.hasUnconfirmedLocalChanges && !this.isReady)");
    expect(app).toContain('assertCollaborationExitSafe(session, t("sharing.syncRequired"))');
    expect(app).toContain("recoverySourceId: pageDraftSourceId");
    expect(app).toContain("recoveryStore: collaborationRecoveryStore");
    expect(collaboration).toContain("canonical-attachment");
    expect(collaboration).toContain("deletedAttachments");
    expect(collaboration).toContain("A tombstone wins over a concurrently retained/re-created block");
    expect(collaboration).toContain("sendAwareness");
    expect(collaboration).toContain("control: typeof state?.control");
    expect(collaborationCaret).toContain("assignRemoteCaretColors");
    expect(collaborationCaret).toContain("getTextControlCaretRect");
    expect(app).toContain("renderRemoteCollaborationCarets");
    expect(app).toContain("getTextSelectionControlKey");
    expect(server).toContain("control: typeof source.control");
    expect(app).toContain("createPageCollaboration");
    expect(app).toContain("flushMaterialization");
    expect(collaboration).toContain("documentEpoch: snapshot.documentEpoch");
    expect(collaboration).toContain("updateId: snapshot.updateId");
    expect(collaboration).not.toContain("body: snapshot");
    expect(app).toContain("if (state.sharePageEntries.length === 1) {");
    expect(app).toContain("await flushPendingPageEdits();");
    expect(app).toContain("adoptAttachment");
  });

  it("provides all sharing strings in every supported catalog", () => {
    expect(i18n.match(/^[ \t]*sharing: \{/gm)).toHaveLength(7);
    expect(Object.keys(translationCatalogs)).toHaveLength(7);
    for (const catalog of Object.values(translationCatalogs)) {
      for (const key of ["button", "title", "usernameLabel", "peopleWithAccess", "activeEditors", "syncRequired"]) {
        expect(catalog.sharing[key]).toBeTypeOf("string");
      }

      for (const key of [
        "orphanedCollaborationRecovery",
        "destructiveCollaborationRecoveryPending",
        "workspaceTransitionBusy",
        "workspaceLocalDraftsPending"
      ]) {
        expect(catalog.status[key]).toBeTypeOf("string");
      }
    }
  });

  it("persists grants and updates and guards server commit/materialization races", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS page_shares");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS page_yjs_updates");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS page_collaboration_state");
    expect(migration).toContain("ON DELETE CASCADE");
    expect(lineageMigration).toContain("ADD COLUMN IF NOT EXISTS document_epoch");
    expect(lineageMigration).toContain("MODIFY COLUMN document_epoch VARCHAR(64) NOT NULL");
    expect(materializationMigration).toContain("ADD COLUMN IF NOT EXISTS materialization_version");
    expect(materializationMigration).toContain("NOT NULL DEFAULT 0");
    expect(lineage).toContain("ensureCollaborationState");
    expect(lineage).toContain("COLLABORATION_LINEAGE_CHANGED");
    expect(token).toContain("documentEpoch: string");
    expect(server).toContain("bootstrapWritePending");
    expect(server).toContain("pendingWrites");
    expect(server).toContain("applyValidatedYjsUpdate");
    expect(server).toContain("candidate.stateUpdate");
    expect(yjsValidation).toContain('import * as Y from "yjs"');
    expect(yjsValidation).toContain("Y.encodeStateAsUpdate");
    expect(materialization).toContain("materializeCollaborationUpdates");
    expect(materialization).toContain("createValidatedYjsDocument");
    expect(materialization).toContain("INVALID_COLLABORATION_DOCUMENT");
    expect(collaborationProtocol).toContain("currentCollaborationMaterializationVersion = 1");
    expect(collaborationProtocol).toContain("latestUpdateId !== state.materializedUpdateId");
    expect(server).toContain("room.writeQueue");
    expect(server).toContain("currentAccess = await getPageAccess");
    expect(server).toContain("assertCollaborationDocumentEpoch(collaborationState, client.documentEpoch)");
    expect(server).toContain("invalidateRoomForLineageChange");
    expect(server).toContain('collaborationWebSocketProtocol = "brainvault-yjs-v2"');
    expect(server).toContain("4011");
    expect(routes).toContain("COLLABORATION_SNAPSHOT_STALE");
    expect(routes).toContain("SELECT id, update_data");
    expect(routes).toContain("materializeCollaborationUpdates");
    expect(routes).toContain("currentCollaborationMaterializationVersion");
    expect(routes).not.toContain("body.title");
    expect(routes).not.toContain("body.blocks");
    expect(routes).not.toContain("body.deletedAttachmentIds");
    expect(routes).toContain("BLOCK_ID_CONFLICT");
    expect(routes).toContain("USE_ATTACHMENT_UPLOAD");
    expect(routes).toContain("COLLABORATION_CHANGES_PENDING");
    expect(routes).toContain("documentEpochProtocol: z.literal(2)");
    expect(routes).toContain("COLLABORATION_CLIENT_REFRESH_REQUIRED");
    expect(routes).toContain("documentEpoch: session.collaborationState.document_epoch");
    expect(routes).toContain("assertCollaborationDocumentEpoch(state, body.documentEpoch)");
  });
});
