import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderBlockHtml, sanitizeRenderedBlockHtml, sanitizeRenderedClass } from "../src/lib/markdown.js";
import { getKanbanData } from "../src/lib/kanban.js";
import { assertStructuredBlockMetadataIntegrity } from "../src/lib/structured-metadata-integrity.js";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import request from "supertest";
import katex from "katex";
import { createApp } from "../src/app.js";
import { admitRecoveryUpload, beginRecoveryUploadProcessing } from "../src/middleware/recovery-upload.js";
import { maxRecoveryCandidateBytes } from "../src/lib/recovery-candidates.js";
import { parseBackupManifest } from "../src/lib/data-transfer.js";
import { maxRestoredPageVersionRevision, recordPageVersion } from "../src/lib/page-version-history.js";

const state = vi.hoisted(() => ({
  queryOne: vi.fn(), execute: vi.fn(), grant: true, revokeDuringStore: false
}));
vi.mock("../src/lib/db.js", () => {
  const client = { queryOne: state.queryOne, execute: state.execute, query: async () => [] };
  return { db: client, transaction: async (fn) => fn(client) };
});
vi.mock("../src/middleware/auth.js", async (original) => ({
  ...await original(),
  requireAuth: (req, _res, next) => {
    req.user = { id: req.get("x-test-user") || "usr_recovery", username: "recovery" };
    req.auth = { authVersion: 1, workspaceGeneration: 1, sessionId: "ses_recovery" };
    next();
  }
}));
vi.mock("node:os", async (original) => {
  const actual = await original();
  return { ...actual, default: { ...actual, networkInterfaces: () => ({}) } };
});


const uploadPath = "/api/recovery/pages/pag_review/candidates?kind=DIRECT_DRAFT&sourceId=draft&generation=local";
let userSequence = 0;
function upload(app = createApp()) {
  return request(app).post(uploadPath).set("x-test-user", `usr_http_${++userSequence}`)
    .set("Content-Type", "application/octet-stream");
}

beforeEach(() => {
  state.grant = true;
  state.revokeDuringStore = false;
  state.execute.mockReset().mockResolvedValue({ affectedRows: 1 });
  state.queryOne.mockReset().mockImplementation(async (sql, args) => {
    if (sql.includes("FROM page_recovery_grants")) {
      if (!state.grant || (state.revokeDuringStore && sql.includes("FOR UPDATE"))) return null;
      return { owner_id: args[1] };
    }
    if (sql.includes("FROM users")) return { id: args[0], auth_version: 1, attachment_generation: 1 };
    if (sql.includes("FROM user_auth_sessions")) return { id: "ses_recovery" };
    if (sql.includes("COUNT(*)")) return { candidate_count: 0, payload_bytes: 0 };
    return null;
  });
});

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const sanitizer = read("public/rendered-html-sanitizer.js").replace("export function renderServerBlockHtml", "function renderServerBlockHtml");
function browserSanitize(html, allowAiControls = false) {
  const { document, Element, Node } = parseHTML("<html><body><div id='target'></div></body></html>");
  const context = vm.createContext({ document, Element, Node, URL });
  vm.runInContext(sanitizer, context);
  const target = document.querySelector("#target");
  context.renderServerBlockHtml(target, html, { allowAiControls });
  return target;
}

describe("BV-2026-001 content classes", () => {
  const chromeClasses = ["account-settings-layer", "account-settings-backdrop", "account-settings-dialog",
    "share-page-layer", "emoji-picker-layer", "mobile-sidebar-backdrop", "kanban-card-style-panel",
    "database-property-menu", "is-open", "is-dragging"];

  it.each(chromeClasses)("removes %s from fresh Markdown and legacy caches in both sanitizers", (token) => {
    const payload = `<div class='${token} rendered-code-shell'><a class='${token}' href='https://example.com/login'>Sign in</a></div>`;
    const fresh = renderBlockHtml("MARKDOWN", payload);
    const cached = sanitizeRenderedBlockHtml("MARKDOWN", payload);
    for (const html of [fresh, cached, browserSanitize(payload).innerHTML]) {
      expect(html).not.toContain(token);
      expect(html).toContain("rendered-code-shell");
      expect(html).toContain("Sign in");
    }
  });

  it("applies identical class rules in the browser and server, including decoded entities", () => {
    const tokens = [...chromeClasses, "rendered-table", "language-csharp", "math-expression", "math-expression--display",
      "youtube-video-iframe", "visually-hidden", "is-active", "is-current", "is-complete", "is-weekend", "is-today", "rendered-X", "kanban-layer", "language-x:evil"];
    const input = tokens.join(" \t\n");
    const result = browserSanitize(`<span class='${input}'></span>`).firstElementChild.getAttribute("class");
    expect(result).toBe(sanitizeRenderedClass(input));
    expect(browserSanitize('<div class="account-settings-&#108;ayer"></div>').firstElementChild.hasAttribute("class")).toBe(false);
  });

  it("preserves math, code, table, toggle, YouTube and AI pagination rendering", () => {
    const markdown = renderBlockHtml("MARKDOWN", '$x$\n\n```js\nlet n = 1;\n```\n\n| A |\n|---|\n| B |');
    const html = browserSanitize(markdown).innerHTML;
    expect(html).toContain('class="math-expression math-expression--inline"');
    expect(html).toContain('class="language-javascript"');
    expect(html).toContain("<table>");
    const legacy = '<details class="rendered-toggle"><summary class="rendered-toggle-summary">Toggle</summary></details>'
      + '<iframe class="youtube-video-iframe" src="https://www.youtube-nocookie.com/embed/abcdefghijk"></iframe>'
      + '<section class="rendered-ai-chat-turn is-active"><button type="button" class="rendered-ai-chat-page is-current" data-ai-chat-page="0">1</button></section>';
    const result = browserSanitize(sanitizeRenderedBlockHtml("AI_CHAT", legacy), true);
    expect(result.querySelector(".rendered-toggle-summary")?.textContent).toBe("Toggle");
    expect(result.querySelector(".youtube-video-iframe")).toBeTruthy();
    expect(result.querySelector(".rendered-ai-chat-page.is-current")?.getAttribute("data-ai-chat-page")).toBe("0");
    const states = '<table><tbody><tr class="is-complete"><td>Done</td></tr></tbody></table><span class="rendered-gantt-day is-weekend is-today">6</span>';
    expect(browserSanitize(sanitizeRenderedBlockHtml("TIMETABLE", states)).querySelector("tr.is-complete")).toBeTruthy();
    expect(browserSanitize(sanitizeRenderedBlockHtml("GANTT", states)).querySelector(".is-weekend.is-today")).toBeTruthy();
  });
});

describe("BV-2026-002 Kanban focus", () => {
  const source = read("public/app.js");
  const replaceSource = source.slice(source.indexOf("function replaceKanbanData("), source.indexOf("function findKanbanCard("));
  it.each(["focusCardId", "focusStyleCardId", "focusColumnId"])("focuses the exact stored ID for %s", (option) => {
    const id = 'x"] , .other, [data-x="';
    const metadata = { kanban: { columns: [{ id, title: "column", color: "gray", cards: [{ id, title: "card" }] }] } };
    expect(() => assertStructuredBlockMetadataIntegrity("KANBAN", metadata)).not.toThrow();
    expect(getKanbanData(metadata).columns[0].cards[0].id).toBe(id);
    const { document } = parseHTML('<div id="row"><div class="block-editor-host"></div></div>');
    const row = document.querySelector("#row");
    const editor = document.createElement("div");
    editor.innerHTML = '<div class="kanban-column"><input class="kanban-column-title"><div class="kanban-card"><input class="kanban-card-title"><details class="kanban-card-style-menu"><summary>Style</summary></details></div></div>';
    editor.querySelector(".kanban-card").dataset.cardId = id;
    editor.querySelector(".kanban-column").dataset.columnId = id;
    const target = editor.querySelector(option === "focusCardId" ? ".kanban-card-title" : option === "focusColumnId" ? ".kanban-column-title" : "summary");
    target.focus = vi.fn(); target.select = vi.fn();
    const context = vm.createContext({
      requireWritablePage: () => true, promoteBlockDraftConflict: () => true,
      normalizeKanbanData: (value) => value, createKanbanEditor: () => editor,
      scheduleBlockSave: vi.fn(), requestAnimationFrame: (fn) => fn(),
      closeKanbanCardStyleMenus: vi.fn(), positionKanbanCardStylePanel: vi.fn()
    });
    vm.runInContext(replaceSource, context);
    expect(() => context.replaceKanbanData(row, metadata.kanban, { [option]: id })).not.toThrow();
    expect(target.focus).toHaveBeenCalledOnce();
    if (option !== "focusStyleCardId") expect(target.select).toHaveBeenCalledOnce();
    else expect(editor.querySelector("details").open).toBe(true);
  });
});

describe("report A: actual recovery HTTP route", () => {
  it("rejects a missing grant before the client sends any of its declared 20 MiB body", async () => {
    state.grant = false;
    const server = createApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    let pending;
    try {
      const response = await new Promise((resolve, reject) => {
        pending = http.request({
          hostname: "127.0.0.1", port: server.address().port, path: uploadPath, method: "POST",
          headers: { "Content-Type": "application/octet-stream", "Content-Length": maxRecoveryCandidateBytes }
        }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (part) => { body += part; });
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        pending.on("error", reject);
        pending.setTimeout(2000, () => pending.destroy(new Error("Server waited for an unauthorized body")));
        pending.flushHeaders();
      });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("RECOVERY_GRANT_NOT_FOUND");
      expect(state.execute).not.toHaveBeenCalled();
    } finally {
      pending?.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("persists valid bytes and rechecks a revoked grant inside the durable transaction", async () => {
    const payload = Buffer.from("browser recovery bytes");
    const success = await upload().send(payload).expect(201);
    expect(success.body.candidate.payloadSha256).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(state.execute.mock.calls.some(([sql]) => sql.includes("INSERT INTO page_recovery_candidates"))).toBe(true);
    state.execute.mockClear();
    state.revokeDuringStore = true;
    const revoked = await upload().send(payload).expect(404);
    expect(revoked.body.error.code).toBe("RECOVERY_GRANT_NOT_FOUND");
    expect(state.execute.mock.calls.some(([sql]) => sql.includes("INSERT INTO page_recovery_candidates"))).toBe(false);
  });

  it("rejects forged JSON before the global JSON parser and compressed payloads before preflight", async () => {
    const json = await upload().set("Content-Type", "application/json").send("{invalid-json").expect(415);
    expect(json.body.error.code).toBe("INVALID_RECOVERY_CONTENT_TYPE");
    await upload().set("Content-Encoding", "gzip").send(Buffer.from("gzip")).expect(415);
    expect(state.queryOne).not.toHaveBeenCalled();
  });

  it("enforces the actual byte limit for chunked requests with no Content-Length", async () => {
    const server = createApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const status = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1", port: server.address().port, path: uploadPath, method: "POST",
          headers: { "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked", "x-test-user": "usr_chunked" }
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        req.on("error", reject);
        req.end(Buffer.alloc(maxRecoveryCandidateBytes + 1));
      });
      expect(status).toBe(413);
      expect(state.execute).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("bounds account request churn across pages and releases capacity after rejected preflights", async () => {
    state.grant = false;
    const app = createApp();
    for (let i = 0; i < 11; i++) {
      const response = await request(app).post(uploadPath.replace("pag_review", `pag_${i}`))
        .set("x-test-user", "usr_rate_churn").set("Content-Type", "application/octet-stream")
        .send(Buffer.from("draft"));
      expect(response.status).toBe(i < 10 ? 404 : 429);
      if (i === 10) expect(response.body.error.code).toBe("RECOVERY_UPLOAD_RATE_LIMITED");
    }
    await upload(app).send(Buffer.from("draft")).expect(404);
  });
});

it("keeps processing capacity occupied on disconnect until storage completes, and releases exactly once", () => {
  const active = [];
  function admit(id) {
    const req = Object.assign(new EventEmitter(), { user: { id } });
    const res = Object.assign(new EventEmitter(), { setHeader: vi.fn() });
    const next = vi.fn();
    admitRecoveryUpload(req, res, next);
    if (!next.mock.calls[0][0]) active.push(res);
    return { req, res, error: next.mock.calls[0][0] };
  }
  try {
    const first = admit("usr_gate_a");
    expect(first.error).toBeUndefined();
    expect(admit("usr_gate_a").error.code).toBe("RECOVERY_UPLOAD_BUSY");
    const second = admit("usr_gate_b");
    expect(admit("usr_gate_c").error.code).toBe("RECOVERY_UPLOAD_BUSY");
    const release = beginRecoveryUploadProcessing(first.res);
    first.res.emit("close");
    first.req.emit("aborted");
    expect(admit("usr_gate_a").error.code).toBe("RECOVERY_UPLOAD_BUSY");
    expect(admit("usr_gate_c").error.code).toBe("RECOVERY_UPLOAD_BUSY");
    release(); release();
    expect(admit("usr_gate_c").error).toBeUndefined();
    second.req.emit("aborted");
    expect(admit("usr_gate_b").error).toBeUndefined();
  } finally {
    for (const res of active) res.emit("finish");
  }
});

it.each(["/api/auth/login", "/api/auth/register", "/api/auth/mfa/login/totp"])(
  "bounds anonymous authentication JSON at 64 KiB: %s", async (path) => {
    const response = await request(createApp()).post(path).send({ padding: "x".repeat(65 * 1024) }).expect(413);
    expect(response.body.error.code).toBe("REQUEST_BODY_TOO_LARGE");
    expect(state.queryOne).not.toHaveBeenCalled();
  }
);

it("serves matching KaTeX scripts, CSS and fonts locally under a CSP that blocks inline style elements", async () => {
  const app = createApp();
  const root = await request(app).get("/").expect(200);
  const csp = root.headers["content-security-policy"];
  expect(csp).toContain("style-src 'self';");
  expect(csp).toContain("style-src-elem 'self';");
  expect(csp).toContain("style-src-attr 'unsafe-inline'");
  expect(csp).not.toContain("katex@");
  for (const file of ["katex.min.js", "katex.min.css"]) {
    const path = `/vendor/katex/0.18.2/${file}`;
    const sri = root.text.match(new RegExp(`(?:src|href)="${path}"\\s+integrity="([^"]+)"`))[1];
    const bytes = readFileSync(`node_modules/katex/dist/${file}`);
    expect(sri).toBe(`sha384-${createHash("sha384").update(bytes).digest("base64")}`);
    const asset = await request(app).get(path).expect(200);
    expect(asset.text).toBe(bytes.toString("utf8"));
  }
  const css = readFileSync("node_modules/katex/dist/katex.min.css", "utf8");
  const font = css.match(/url\((fonts\/[^)]+\.woff2)\)/)[1];
  await request(app).get(`/vendor/katex/0.18.2/${font}`).expect(200);
  expect(root.text).not.toContain("cdn.jsdelivr.net/npm/katex@");
});

it("validates restored revision values independently of the retained row count", () => {
  const manifest = {
    format: "brainvault-backup", version: 6, exportedAt: "2026-11-06T00:00:00.000Z",
    source: { userId: "usr_review", username: "review" },
    account: { name: null, avatar_data: null, preferred_language: null, default_collection_icon: null, theme: "light" },
    data: { pages: [], blocks: [], tags: [], pageTags: [], pageShares: [], collectionShares: [], pageComments: [],
      navigationCollapsedPageIds: [], navigationPageOrder: [], pageVersions: [{
      page_id: "pag_review", revision: 1, page_edit_version: 1, page_content_version: 1,
      actors: "[]", source: "DIRECT", change_count: 0, changes: "[]", created_at: "2026-11-06 00:00:00.000",
      change_summary: JSON.stringify({ baseline: 0, pageCreated: 0, pageFields: [], blocksCreated: 0,
        blocksUpdated: 0, blocksDeleted: 0, blocksMoved: 0 })
    }] }, attachments: [], retainedAttachments: [], pageCovers: [], customIcons: [],
    customIconLibraryRemovals: [], customIconPublications: []
  };
  for (const revision of [1, 200_001, maxRestoredPageVersionRevision]) {
    manifest.data.pageVersions[0].revision = revision;
    expect(parseBackupManifest(manifest).data.pageVersions[0].revision).toBe(revision);
  }
  for (const revision of [0, 1.5, maxRestoredPageVersionRevision + 1, Number.MAX_SAFE_INTEGER, Infinity]) {
    manifest.data.pageVersions[0].revision = revision;
    expect(() => parseBackupManifest(manifest)).toThrow();
  }
});

it("advances the largest restored revision exactly and rejects unsafe future increments before writes", async () => {
  let revision = maxRestoredPageVersionRevision;
  const client = {
    queryOne: async (sql) => sql.includes("FROM pages") ? { edit_version: 1, content_version: 1 }
      : sql.includes("SELECT MAX(revision)") ? { revision } : { cutoff_revision: null },
    execute: vi.fn(async () => ({ insertId: 1, affectedRows: 1 }))
  };
  const input = { pageId: "pag_review", actors: [], source: "DIRECT",
    changes: [{ kind: "page-updated", fields: [{ field: "title", before: "before", after: "after" }] }] };
  expect((await recordPageVersion(client, input)).revision).toBe(0x100000000);
  expect(client.execute.mock.calls.find(([sql]) => sql.includes("INSERT INTO page_versions"))[1][1]).toBe(0x100000000);
  client.execute.mockClear();
  revision = Number.MAX_SAFE_INTEGER;
  await expect(recordPageVersion(client, input)).rejects.toThrow("cannot be advanced safely");
  expect(client.execute).not.toHaveBeenCalled();
});

it("renders formulas while refusing inherited KaTeX trust settings", () => {
  expect(katex.renderToString(String.raw`\frac{a^2}{b}`, { throwOnError: false })).toContain("katex");
  const options = Object.create({ trust: true });
  const untrusted = katex.renderToString(String.raw`\href{https://example.invalid/}{link}`, options);
  expect(untrusted).not.toContain("href=");
});
