import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const client = read("../public/app.js");
const index = read("../public/index.html");
const styles = read("../public/styles.css");
const themeBootstrap = read("../public/theme-bootstrap.js");
const blockModules = ["database-block.js", "gantt-block.js", "timetable-block.js"].map((name) => read(`../public/${name}`));

function installDom() {
  const { window } = parseHTML("<!doctype html><html><body><button id=\"opener\">open</button></body></html>");
  const dialogPrototype = Object.getPrototypeOf(window.document.createElement("dialog"));
  // linkedom has no modal dialog implementation; model the parts the module uses.
  dialogPrototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  dialogPrototype.close = function close(value) {
    if (!this.hasAttribute("open")) return;
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
  window.HTMLElement.prototype.focus = function focus() {
    window.lastFocused = this;
  };
  window.HTMLInputElement.prototype.select = function select() {};
  const previous = { document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  return { window, restore: () => Object.assign(globalThis, previous) };
}

async function nextDialog() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dialog = document.querySelector("dialog.app-dialog");
    if (dialog) return dialog;
    await new Promise((resolve) => setTimeout(resolve));
  }
  throw new Error("dialog did not open");
}

describe("themed confirm and prompt dialogs", () => {
  let dom;
  let dialogs;

  beforeEach(async () => {
    dom = installDom();
    dialogs = await import("../public/app-dialog.js");
  });

  afterEach(() => {
    // Never leave a dialog open: the module serializes dialogs through one queue.
    document.querySelectorAll("dialog.app-dialog").forEach((dialog) => dialog.close("cancel"));
    dom.restore();
  });

  it("resolves true only for the confirm action and removes the dialog", async () => {
    const pending = dialogs.showConfirmDialog({ title: "Delete?", message: "Gone for good", confirmLabel: "Delete", danger: true });
    const dialog = await nextDialog();
    expect(dialog.textContent).toContain("Gone for good");
    const [cancel, confirm] = dialog.querySelectorAll(".app-dialog-actions button");
    // Implicit submission must never pick Cancel, and destructive confirms start on Cancel.
    expect(cancel.getAttribute("type")).toBe("button");
    expect(confirm.getAttribute("type")).toBe("submit");
    expect(confirm.className).toBe("app-dialog-danger");
    expect(dom.window.lastFocused).toBe(cancel);
    dialog.close("confirm");
    await expect(pending).resolves.toBe(true);
    expect(document.querySelector("dialog.app-dialog")).toBeNull();
  });

  it("treats Escape and Cancel as a refusal", async () => {
    const escaped = dialogs.showConfirmDialog({ message: "First" });
    (await nextDialog()).close();
    await expect(escaped).resolves.toBe(false);

    const cancelled = dialogs.showConfirmDialog({ message: "Second" });
    (await nextDialog()).querySelector(".secondary").click();
    await expect(cancelled).resolves.toBe(false);
  });

  it("returns the typed prompt value, or null when cancelled", async () => {
    const pending = dialogs.showPromptDialog({ title: "Code", defaultValue: "12", inputMode: "numeric", autocomplete: "one-time-code", maxLength: 6 });
    const input = (await nextDialog()).querySelector("input");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    input.value = "123456";
    document.querySelector("dialog.app-dialog").close("confirm");
    await expect(pending).resolves.toBe("123456");

    const cancelled = dialogs.showPromptDialog({ title: "Name" });
    (await nextDialog()).close("cancel");
    await expect(cancelled).resolves.toBeNull();
  });

  it("shows one dialog at a time", async () => {
    const first = dialogs.showConfirmDialog({ message: "one" });
    const second = dialogs.showConfirmDialog({ message: "two" });
    await nextDialog();
    await new Promise((resolve) => setTimeout(resolve));
    expect(document.querySelectorAll("dialog.app-dialog")).toHaveLength(1);
    document.querySelector("dialog.app-dialog").close("confirm");
    await first;
    const next = await nextDialog();
    expect(next.textContent).toContain("two");
    next.close();
    await expect(second).resolves.toBe(false);
  });
});

describe("usability wiring", () => {
  it("replaces every native dialog, including the recovered-draft guard", () => {
    const nativeCalls = client.match(/\b(?:window|globalThis)\.(?:confirm|prompt|alert)\(/g) ?? [];
    expect(nativeCalls).toHaveLength(0);
    // The synchronous guard keeps the server copy and offers the themed choice instead.
    expect(client).toContain("return recoveredDraftOverwriteApproved;");
    expect(client).toContain('setStatus(t("status.draftConflictEditBlocked"), true, getDraftConflictStatusOptions());');
    for (const source of blockModules) {
      expect(source).not.toMatch(/\bwindow\.(?:confirm|prompt)\(/);
      expect(source).toContain('import { showConfirmDialog } from "./app-dialog.js";');
    }
  });

  it("re-checks the intent after awaited confirmations", () => {
    expect(client).toContain("const trigger = event.currentTarget;");
    expect(client).toMatch(/state\.selectedPage\?\.id !== pageIdAtPrompt/);
    expect(client).toMatch(/state\.selectedPage\?\.id !== pageIdAtIntent \|\| !getBlockById\(blockId\)/);
    expect(client).toContain("function isBlockDeletionTrivial(row, blockId)");
  });

  it("offers an archive with restore and an undo toast after archiving", () => {
    expect(index).toContain('id="archive-open-button"');
    expect(index).toContain('id="archive-dialog"');
    expect(client).toContain("fetchAllPageSummaries({ archived: true })");
    expect(client).toContain("body: { isArchived: false, expectedVersion, mutationId: task.mutationId }");
    expect(client).toMatch(/label: t\("status\.undo"\),\s*onSelect: \(\) => void restoreArchivedPage\(pageId, archivedVersion/);
  });

  it("keeps errors visible, pauses dismissal on hover/focus, and lets users close toasts", () => {
    expect(client).toContain("const statusErrorDismissDelay = 0;");
    expect(client).toContain('elements.status.addEventListener("pointerenter", pauseStatusDismiss);');
    expect(client).toContain('dismissButton.className = "status-dismiss";');
    expect(styles).toMatch(/\.status:not\(:empty\)\s*\{[^}]*pointer-events: auto;/);
  });

  it("makes the workspace inert behind every full-screen layer", () => {
    expect(client).not.toMatch(/elements\.shell\.inert = (true|false)/);
    expect(client).toMatch(/function syncWorkspaceShellInert\(\)[\s\S]*state\.sharePageOpen[\s\S]*state\.shareCollectionOpen/);
  });

  it("follows the operating system theme when the preference is system", () => {
    expect(index).toContain('<option value="system" data-i18n="account.themeSystem">');
    expect(themeBootstrap).toContain('matchMedia?.("(prefers-color-scheme: dark)")');
    expect(client).toContain('if (getActiveTheme() === "system") applyTheme("system", { persist: false });');
    expect(read("../migrations/084_user_theme_system_preference.sql")).toContain("ENUM('light', 'dark', 'system')");
  });
});
