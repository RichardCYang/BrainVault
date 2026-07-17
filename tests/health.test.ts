import express from "express";
import request from "supertest";
import { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { renderBlockHtml, renderMarkdown } from "../src/lib/markdown.js";
import { closeDb } from "../src/lib/db.js";
import { getTableData } from "../src/lib/table.js";
import { getValidatedQuery, validate } from "../src/middleware/validate.js";

afterAll(async () => {
  await closeDb();
});

describe("BrainVault web shell and health endpoint", () => {
  it("serves the web UI at /", async () => {
    const response = await request(createApp()).get("/").expect(200);

    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain("BrainVault");
    expect(response.text).toContain('data-i18n="auth.username"');
    expect(response.text).toContain('name="username" type="text" autocomplete="username"');
    expect(response.text).toContain('id="auth-submit" type="submit" data-auth-mode="login"');
    expect(response.text).toContain("New to BrainVault?");
    expect(response.text).toContain('id="auth-switch-link" href="#signup"');
    expect(response.text).toContain('id="default-collection-button"');
    expect(response.text).toContain('id="add-document-button"');
    expect(response.text).toContain('id="page-list" class="document-tree"');
    expect(response.text).toContain('id="collection-list" class="collection-list"');
    expect(response.text).toContain('data-i18n="collection.heading"');
    expect(response.text).toContain("Untitled");
    expect(response.text).not.toContain('id="new-page-parent"');
    expect(response.text).not.toContain('id="new-page-title"');
    expect(response.text).toContain('class="document-editor"');
    expect(response.text).toContain('id="document-editor-heading"');
    expect(response.text).toContain('id="block-list" class="block-list block-row-editor"');
    expect(response.text).toContain('data-i18n-aria-label="page.editorAria"');
    expect(response.text).not.toContain('id="append-block-button"');
    expect(response.text).not.toContain('id="render-preview"');
    expect(response.text).not.toContain('id="refresh-preview-button"');
    expect(response.text).not.toContain('렌더링 미리보기');
    expect(response.text).toContain('id="slash-menu" class="slash-menu hidden"');
    expect(response.text).toContain('id="block-context-menu" class="block-context-menu hidden"');
    expect(response.text).toContain('id="callout-type-group" class="callout-type-group hidden"');
    expect(response.text).toContain('data-action="change-callout-type" data-callout-type="idea" role="menuitemradio"');
    expect(response.text).toContain('data-action="change-callout-type" data-callout-type="danger" role="menuitemradio"');
    expect(response.text).toContain('data-action="insert-block-before" role="menuitem"');
    expect(response.text).toContain('data-i18n="menu.insertBefore"');
    expect(response.text).toContain('data-action="insert-block-after" role="menuitem"');
    expect(response.text).toContain('data-i18n="menu.insertAfter"');
    expect(response.text).toContain('data-action="save-block" role="menuitem"');
    expect(response.text).toContain('data-action="delete-block" class="danger-menu-item" role="menuitem"');
    expect(response.text).toContain('id="inline-toolbar" class="inline-toolbar hidden"');
    expect(response.text).toContain('data-format="bold"');
    expect(response.text).toContain('data-format="color" data-color="#63a1f2"');
    expect(response.text).toContain('data-i18n-html="page.editorHelp"');
    expect(response.text).toContain("Press <kbd>Enter</kbd> for a new block");
    expect(response.text).not.toContain('id="new-block-form"');
    expect(response.text).not.toContain('type="email"');
    expect(response.text).not.toContain('data-auth-mode="register" class="secondary"');
    expect(response.text).not.toContain("회원가입 옵션");
    expect(response.text).toContain("/app.js");
    expect(response.text).toContain('id="account-settings-dialog"');
    expect(response.text).toContain('id="language-select"');
    expect(response.text).toContain('data-i18n="account.languageTitle"');
    expect(response.text.indexOf('id="language-select"')).toBeGreaterThan(response.text.indexOf('id="account-settings-layer"'));
    expect(response.text.indexOf('id="language-select"')).toBeGreaterThan(response.text.indexOf('id="search-form"'));
  });


  it("serves the sky-blue document-first workspace theme", async () => {
    const response = await request(createApp()).get("/styles.css").expect(200);

    expect(response.headers["content-type"]).toContain("text/css");
    const css = response.text.replace(/\r\n/g, "\n");
    expect(css).toContain("--sidebar: #eff8ff");
    expect(css).toContain("--ink: #26384a");
    expect(css).toContain("--accent: #bfe5ff");
    expect(css).toContain("--accent-soft: #eaf7ff");
    expect(css).toContain("--radius-lg: 10px");
    expect(css).toContain("--radius-md: 6px");
    expect(css).toContain(".auth-switch");
    expect(css).not.toContain(".language-switcher");
    expect(css).toContain(".account-settings-layer");
    expect(css).toContain(".account-settings-dialog");
    expect(css).toContain("color: var(--muted);");
    expect(css).toContain(".sidebar-nav");
    expect(css).toContain(".default-collection");
    expect(css).toContain(".default-collection {\n  border: 0;");
    expect(css).toContain(".collection-title-button");
    expect(css).toContain(".count-pill {\n  display: inline-flex;");
    expect(css).toContain(".sidebar-add-button");
    expect(css).toContain(".document-tree");
    expect(css).toContain(".document-editor");
    expect(css).toContain(".editor-block-row");
    expect(css).toContain("grid-template-columns: 0 minmax(0, 1fr)");
    expect(css).toContain(".editor-block-row.is-menu-open");
    expect(css).toContain("pointer-events: none;");
    expect(css).toContain('[data-block-type="HEADING_1"]');
    expect(css).toContain('[data-block-type="CODE"]');
    expect(css).toContain('[data-block-type="TABLE"]');
    expect(css).toContain('[data-block-type="DATABASE"]');
    expect(css).toContain(".table-block-grid");
    expect(css).toContain(".table-block-surface");
    expect(css).toContain(".table-edge-add-row");
    expect(css).toContain(".table-edge-add-column");
    expect(css).toContain(".table-cell-input");
    expect(css).toContain(".rendered-table");
    expect(css).toContain(".database-block-editor");
    expect(css).toContain(".rendered-database");
    expect(css).not.toContain(".preview {");
    expect(css).toContain(".slash-menu-item");
    expect(css).toContain(".inline-toolbar");
    expect(css).toContain("background: #eaf7ff;");
    expect(css).not.toContain("background: #2f3437;");
    expect(css).toContain(".color-sky");
    expect(css).not.toContain(".add-block-button");
    expect(css).toContain("--depth");
    expect(css).toContain("min-height: 1.72rem");
    expect(css).toContain("grid-template-columns: 0 minmax(0, 1fr);\n  column-gap: 0;\n  align-items: center;");
    expect(css).toContain("height: 1.55rem;\n  align-self: center;");
    expect(css).toContain(".block-editor-host {\n  display: grid;\n  min-width: 0;\n  align-items: center;");
    expect(css).toContain("padding: 0.1875rem 0;");
    expect(css).toContain("line-height: 1.5");
    expect(css).toContain("touch-action: none");
    expect(css).toContain(".block-drop-indicator");
    expect(css).toContain("cursor: grab");
    expect(css).toContain(".block-row-input::placeholder");
    expect(css).toContain(".block-row-input:focus::placeholder");
    expect(css).toContain(".block-context-menu");
    expect(css).toContain('.editor-block-row[data-block-type="CALLOUT"][data-callout-type="warning"]');
    expect(css).toContain('.callout-type-group button[aria-checked="true"]');
    expect(css).toContain(".rendered-callout--danger");
    expect(css).toContain("box-shadow: inset 0 0 0 2px rgba(36, 118, 184, 0.28)");
    expect(css).toContain(".block-row-input:focus-visible");
    expect(css).toContain("outline: none;");
  });

  it("serves web UI assets", async () => {
    const response = await request(createApp()).get("/app.js").expect(200);

    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.text).toContain("brainvault.token");
    expect(response.text).toContain("username:");
    expect(response.text).toContain("setAuthMode");
    expect(response.text).toContain('window.location.hash === "#signup"');
    expect(response.text).toContain("activeTag");
    expect(response.text).toContain("buildPageTree");
    expect(response.text).toContain("createUntitledPage");
    expect(response.text).toContain("savePageTitleNow");
    expect(response.text).not.toContain("counts?.blocks");
    expect(response.text).not.toContain("} blocks");
    expect(response.text).toContain("default-collection-button");
    expect(response.text).toContain("slashCommands");
    expect(response.text).toContain("getSlashContext");
    expect(response.text).toContain("applySlashCommand");
    expect(response.text).toContain("getTextareaSelection");
    expect(response.text).toContain("applyInlineFormat");
    expect(response.text).toContain("inlineToolbar");
    expect(response.text).not.toContain("loadPreview");
    expect(response.text).not.toContain("renderPreview");
    expect(response.text).not.toContain("refreshPreviewButton");
    expect(response.text).toContain("insertBlockRelative");
    expect(response.text).toContain('placement === "before" ? referenceIndex : referenceIndex + 1');
    expect(response.text).toContain('button.dataset.action === "insert-block-before"');
    expect(response.text).toContain('button.dataset.action === "insert-block-after"');
    expect(response.text).toContain("appendBlock");
    expect(response.text).toContain("deleteEmptyBlock");
    expect(response.text).toContain('event.key === "Backspace"');
    expect(response.text).toContain('event.inputType !== "deleteContentBackward"');
    expect(response.text).toContain("persistBlockOrder");
    expect(response.text).toContain("getBlockInsertionIndex");
    expect(response.text).toContain("setPointerCapture");
    expect(response.text).toContain('addEventListener("pointerdown"');
    expect(response.text).toContain("/blocks/reorder");
    expect(response.text).toContain('t("status.blockOrderChanged")');
    expect(response.text).toContain("openBlockContextMenu");
    expect(response.text).toContain('handle.dataset.action = "open-block-menu"');
    expect(response.text).toContain("calloutTypePresets");
    expect(response.text).toContain('{ type: "TABLE", command: "/table"');
    expect(response.text).toContain('{ type: "DATABASE", command: "/database"');
    expect(response.text).toContain("createTableEditor");
    expect(response.text).toContain("createDatabaseEditor");
    expect(response.text).toContain("extractDatabaseData");
    expect(response.text).toContain('addColumnButton.classList.add("table-edge-add", "table-edge-add-column")');
    expect(response.text).toContain('addRowButton.classList.add("table-edge-add", "table-edge-add-row")');
    expect(response.text).toContain('t("table.addColumn")');
    expect(response.text).toContain('t("table.addRow")');
    expect(response.text).not.toContain('makeTableActionButton("table-add-row", "+ 행"');
    expect(response.text).not.toContain('makeTableActionButton("table-add-column", "+ 열"');
    expect(response.text).toContain("handleTableAction");
    expect(response.text).toContain("handleTableCellKeydown");
    expect(response.text).toContain('event.key === "ArrowDown"');
    expect(response.text).toContain('button.dataset.action.startsWith("table-")');
    expect(response.text).toContain("syncCalloutTypeMenu");
    expect(response.text).toContain("changeCalloutType");
    expect(response.text).toContain('body: { ...task.payload, expectedVersion: currentVersion }');
    expect(response.text).toContain("closeBlockContextMenu");
    expect(response.text).not.toContain("state.user.email");
    expect(response.text).toContain('from "./i18n.js"');
    expect(response.text).toContain("openAccountSettings");
    expect(response.text).toContain('api("/api/auth/profile"');
    expect(response.text).toContain('api("/api/auth/password"');
  });

  it("serves the database block editor module", async () => {
    const response = await request(createApp()).get("/database-block.js").expect(200);

    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.text).toContain("createDatabaseEditor");
    expect(response.text).toContain("normalizeDatabaseData");
    expect(response.text).toContain("applyDatabaseView");
    expect(response.text).toContain('view.type === "board"');
  });

  it("serves the browser i18n catalog", async () => {
    const response = await request(createApp()).get("/i18n.js").expect(200);

    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.text).toContain("brainvault.language");
    expect(response.text).toContain("navigator?.languages");
    expect(response.text).toContain('code: "en"');
    expect(response.text).toContain('code: "ja"');
    expect(response.text).toContain('code: "ko"');
    expect(response.text).toContain('code: "fr"');
    expect(response.text).toContain('code: "de"');
    expect(response.text).toContain('code: "es"');
    expect(response.text).toContain('code: "pt"');
    expect(response.text).toContain("detectBrowserLanguage");
    expect(response.text).toContain("applyDocumentTranslations");
  });


  it("allows localhost origins for the bundled web UI", async () => {
    const response = await request(createApp())
      .get("/health")
      .set("Host", "localhost:4000")
      .set("Origin", "http://localhost:4000")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:4000");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not throw noisy CORS errors for disallowed browser origins", async () => {
    const response = await request(createApp())
      .get("/health")
      .set("Origin", "https://not-allowed.example")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });


  it("documents the legacy email column compatibility fix", async () => {
    const fs = await import("node:fs/promises");
    const schemaSource = await fs.readFile("src/lib/schema.ts", "utf8");
    const migrationSource = await fs.readFile("migrations/002_users_username.sql", "utf8");

    expect(schemaSource).toContain("ALTER TABLE users MODIFY COLUMN email VARCHAR(255) NULL DEFAULT NULL");
    expect(schemaSource).toContain("ER_NO_DEFAULT_FOR_FIELD");
    expect(migrationSource).not.toContain("email =");
  });


  it("includes migrations for the TABLE, KANBAN, DATABASE, BOOKMARK, AI chat, and math block enums", async () => {
    const fs = await import("node:fs/promises");
    const baseline = await fs.readFile("migrations/001_init.sql", "utf8");
    const tableMigration = await fs.readFile("migrations/003_blocks_table_type.sql", "utf8");
    const kanbanMigration = await fs.readFile("migrations/004_blocks_kanban_type.sql", "utf8");
    const databaseMigration = await fs.readFile("migrations/006_blocks_database_type.sql", "utf8");
    const bookmarkMigration = await fs.readFile("migrations/007_blocks_bookmark_type.sql", "utf8");
    const aiChatMigration = await fs.readFile("migrations/011_blocks_ai_chat_type.sql", "utf8");
    const mathMigration = await fs.readFile("migrations/012_blocks_math_type.sql", "utf8");

    expect(baseline).toContain("'CALLOUT', 'TABLE', 'KANBAN', 'DATABASE', 'BOOKMARK', 'AI_CHAT', 'MATH', 'CODE'");
    expect(tableMigration).toContain("MODIFY COLUMN type ENUM");
    expect(tableMigration).toContain("'TABLE'");
    expect(kanbanMigration).toContain("MODIFY COLUMN type ENUM");
    expect(kanbanMigration).toContain("'KANBAN'");
    expect(databaseMigration).toContain("MODIFY COLUMN type ENUM");
    expect(databaseMigration).toContain("'DATABASE'");
    expect(bookmarkMigration).toContain("MODIFY COLUMN type ENUM");
    expect(bookmarkMigration).toContain("'BOOKMARK'");
    expect(aiChatMigration).toContain("MODIFY COLUMN type ENUM");
    expect(aiChatMigration).toContain("'AI_CHAT'");
    expect(mathMigration).toContain("MODIFY COLUMN type ENUM");
    expect(mathMigration).toContain("'MATH'");
  });

  it("validates query strings without mutating Express 5 req.query", async () => {
    const app = express();
    const querySchema = z.object({
      page: z.coerce.number().int().min(1).default(1),
      archived: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
    });

    app.get("/query-check", validate({ query: querySchema }), (req, res) => {
      res.json({ query: getValidatedQuery<z.infer<typeof querySchema>>(req) });
    });

    const response = await request(app).get("/query-check?page=2&archived=true").expect(200);

    expect(response.body).toEqual({ query: { page: 2, archived: true } });
  });

  it("renders persistent callout type classes from block metadata", () => {
    expect(renderBlockHtml("CALLOUT", "주의 내용", false, { calloutType: "warning" })).toContain(
      'class="rendered-callout rendered-callout--warning"'
    );
    expect(renderBlockHtml("CALLOUT", "기본 내용", false, { calloutType: "unknown" })).toContain(
      'class="rendered-callout rendered-callout--idea"'
    );
  });

  it("renders editable table metadata as sanitized table HTML", () => {
    const html = renderBlockHtml("TABLE", "", false, {
      table: {
        rows: [
          ["이름", "상태"],
          ["BrainVault", "<script>alert(1)</script>완료"]
        ],
        headerRow: true,
        headerColumn: true
      }
    });

    expect(html).toContain('class="rendered-table"');
    expect(html).toContain('<th scope="col" class="rendered-table-header">이름</th>');
    expect(html).toContain('<th scope="row" class="rendered-table-header">BrainVault</th>');
    expect(html).toContain("완료");
    expect(html).not.toContain("script");
  });

  it("normalizes malformed table metadata to a bounded rectangular grid", () => {
    const table = getTableData({
      table: {
        rows: [["A"], ["B", "C"]],
        headerRow: true,
        headerColumn: false
      }
    });

    expect(table.rows).toEqual([
      ["A", ""],
      ["B", "C"]
    ]);
    expect(table.headerRow).toBe(true);
  });

  it("allows safe inline text color spans while sanitizing unsafe styles", () => {
    const html = renderMarkdown('<span style="color: #63a1f2">하늘색</span><span style="position:absolute">위험</span><script>alert(1)</script>');

    expect(html).toContain("하늘색");
    expect(html).toContain("color");
    expect(html).toContain("#63a1f2");
    expect(html).toContain("위험");
    expect(html).not.toContain("position");
    expect(html).not.toContain("script");
  });

  it("returns service metadata", async () => {
    const response = await request(createApp()).get("/health").expect(200);

    expect(response.body).toEqual({ ok: true, name: "BrainVault", version: "1.0.0" });
  });
});
