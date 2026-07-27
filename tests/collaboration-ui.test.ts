import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const collaboration = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/020_page_sharing_yjs_collaboration.sql", import.meta.url),
  "utf8"
);
const server = readFileSync(new URL("../src/lib/collaboration-server.ts", import.meta.url), "utf8");
const yjsValidation = readFileSync(new URL("../src/lib/yjs-validation.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8");

describe("page sharing and Yjs collaboration wiring", () => {
  it("ships owner sharing controls, live status, and collaborator presence surfaces", () => {
    expect(index).toContain('id="share-page-button"');
    expect(index).toContain('id="share-page-layer"');
    expect(index).toContain('id="share-username"');
    expect(index).toContain('id="share-user-list"');
    expect(index).toContain('id="collaboration-indicator"');
    expect(index).toContain('id="collaboration-presence"');
    expect(styles).toContain(".share-page-layer");
    expect(styles).toContain(".collaboration-indicator");
    expect(styles).toContain(".collaboration-presence");
  });

  it("pins Yjs and supports persisted updates, reconnect recovery, awareness, and attachment reconciliation", () => {
    expect(collaboration).toContain("https://cdn.jsdelivr.net/npm/yjs@13.6.31/+esm");
    expect(collaboration).toContain("Y.applyUpdate");
    expect(collaboration).toContain("Y.encodeStateAsUpdate");
    expect(collaboration).toContain("needsRecovery");
    expect(collaboration).toContain("canonical-attachment");
    expect(collaboration).toContain("deletedAttachments");
    expect(collaboration).toContain("A tombstone wins over a concurrently retained/re-created block");
    expect(collaboration).toContain("sendAwareness");
    expect(app).toContain("createPageCollaboration");
    expect(app).toContain("flushMaterialization");
    expect(app).toContain("adoptAttachment");
  });

  it("provides all sharing strings in every supported catalog", () => {
    expect(i18n.match(/^[ \t]*sharing: \{/gm)).toHaveLength(7);
    for (const key of ["button", "title", "usernameLabel", "peopleWithAccess", "activeEditors", "syncRequired"]) {
      expect(i18n.match(new RegExp(`^[ \\t]*${key}:`, "gm"))).toHaveLength(7);
    }
  });

  it("persists grants and updates and guards server commit/materialization races", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS page_shares");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS page_yjs_updates");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS page_collaboration_state");
    expect(migration).toContain("ON DELETE CASCADE");
    expect(server).toContain("bootstrapWritePending");
    expect(server).toContain("pendingWrites");
    expect(server).toContain("applyValidatedYjsUpdate");
    expect(server).toContain("candidate.stateUpdate");
    expect(yjsValidation).toContain('import * as Y from "yjs"');
    expect(yjsValidation).toContain("Y.encodeStateAsUpdate");
    expect(server).toContain("room.writeQueue");
    expect(server).toContain("currentAccess = await getPageAccess");
    expect(routes).toContain("COLLABORATION_SNAPSHOT_STALE");
    expect(routes).toContain("BLOCK_ID_CONFLICT");
    expect(routes).toContain("USE_ATTACHMENT_UPLOAD");
    expect(routes).toContain("COLLABORATION_CHANGES_PENDING");
  });
});
