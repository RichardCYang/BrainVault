// Executes the real app functions in a VM with explicit browser/HTTP/storage
// doubles. This is a protocol/interaction regression harness, NOT browser E2E
// or a substitute for the production MariaDB/authentication integration suite.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { planConfirmedBlockInsertion } from "../../public/block-insertion-result.js";

export const defaultAppSource = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
function functionSource(source, name) {
  const normalized = source.replace(/\r\n/g, "\n");
  const start = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(normalized)?.index;
  if (start === undefined) return "";
  // App declarations are column-zero; all selected functions end at a
  // column-zero brace, unlike their nested callbacks/object literals.
  const end = normalized.indexOf("\n}", start);
  if (end < start) throw new Error(`Cannot extract ${name}`);
  return normalized.slice(start, end + 2);
}
export function makeBlock(id, sortOrder = 0, extra = {}) {
  return { id, pageId: "p", parentBlockId: null, sortOrder, version: 1, type: "MARKDOWN", markdown: id,
    checked: false, metadata: null, htmlCache: `<p>${id}</p>`, children: [], ...extra };
}
export function makeRow(block, classes = []) {
  const flags = new Set(classes);
  return {
    dataset: { blockId: block.id, blockType: block.type, parentBlockId: block.parentBlockId ?? "" },
    payload: { type: block.type, markdown: block.markdown, checked: block.checked, metadata: block.metadata },
    classList: { contains: (name) => flags.has(name), add: (...names) => names.forEach((name) => flags.add(name)), remove: (...names) => names.forEach((name) => flags.delete(name)) }
  };
}
export function createHarness({ source = defaultAppSource, latencyMs = 0, blocks = [makeBlock("a")], collaborative = false } = {}) {
  const page = { id: "p", contentVersion: 10, title: "Original title", blocks: structuredClone(blocks) };
  const server = { version: 10, blocks: structuredClone(blocks), receipts: new Map() };
  const metrics = { requests: [], renders: 0, flushes: 0, history: 0, drafts: 0, statuses: [], creates: 0 };
  const controls = { writable: true, storagePending: false, pendingEdits: false, unsafeRow: false, authGeneration: 1, failStorage: false, collaborative, beforeResponse: null, onFlush: null, failReorder: null, failGet: null, lostCreateResponses: 0, createAuthority: true };
  let sequence = 0;
  let ctx;
  const clone = (value) => structuredClone(value);
  const authentication = () => ({ generation: controls.authGeneration, targetKey: "u", workspaceGeneration: 1 });
  const rows = new Map(blocks.map((block) => [block.id, makeRow(block)]));
  const drafts = new Map();
  const pageDraftStore = { loadPage: () => ({ blocks: Object.fromEntries(drafts) }) };
  const recoveryStorage = { hasPendingWrites: () => controls.storagePending };
  const findServer = (id) => server.blocks.find((block) => block.id === id);
  async function request(path, options = {}) {
    if (options.beforeFetch?.() === false) return ctx.skippedApiRequest;
    metrics.requests.push({ path, method: options.method ?? "GET", body: clone(options.body ?? null) });
    if (latencyMs) await delay(latencyMs);
    await controls.beforeResponse?.(path, options, ctx);
    if (path.endsWith("/reorder")) {
      if (controls.failReorder) throw controls.failReorder;
      for (const item of options.body.items) {
        const block = findServer(item.id);
        if (!block || block.version !== item.expectedVersion) throw Object.assign(new Error("conflict"), { status: 409, code: "BLOCK_EDIT_CONFLICT" });
      }
      for (const item of options.body.items) Object.assign(findServer(item.id), { parentBlockId: item.parentBlockId, sortOrder: item.sortOrder, version: findServer(item.id).version + 1 });
      server.version++;
      return { blocks: clone(server.blocks), pageContentVersion: server.version, pageUpdatedAt: "2026-09-15T10:00:01.000Z" };
    }
    if (path === "/api/pages/p/blocks" && options.method === "POST") {
      const body = options.body;
      let block = server.receipts.get(body.mutationId);
      const previousVersion = server.version;
      if (!block) {
        const siblings = server.blocks.filter((item) => item.parentBlockId === (body.parentBlockId ?? null));
        const requested = body.sortOrder ?? siblings.length;
        const order = siblings.some((item) => item.sortOrder === requested) ? Math.max(-1, ...siblings.map((item) => item.sortOrder)) + 1 : requested;
        block = makeBlock(`new-${++sequence}`, order, { type: body.type, markdown: body.markdown, metadata: body.metadata ?? null, parentBlockId: body.parentBlockId ?? null });
        server.blocks.push(block); server.version++; server.receipts.set(body.mutationId, block); metrics.creates++;
      }
      const authoritative = controls.createAuthority && (body.basePageContentVersion === previousVersion || body.basePageContentVersion + 1 === server.version);
      if (controls.lostCreateResponses > 0) {
        controls.lostCreateResponses--;
        throw Object.assign(new Error("create committed, response lost"), { ambiguous: true });
      }
      return { block: clone(block), pageContentVersion: server.version, pageContentVersionAuthoritative: authoritative, pageUpdatedAt: "2026-09-15T10:00:00.000Z" };
    }
    if (options.method === "PATCH") {
      const block = findServer(path.split("/").pop());
      if (options.body.expectedVersion !== block.version) throw Object.assign(new Error("conflict"), { status: 409, code: "BLOCK_EDIT_CONFLICT" });
      Object.assign(block, { type: options.body.type, markdown: options.body.markdown, checked: options.body.checked, metadata: options.body.metadata, version: block.version + 1 }); server.version++;
      return { block: clone(block), pageContentVersion: server.version, pageContentVersionAuthoritative: true };
    }
    if (path === "/api/pages/p") {
      if (controls.failGet) throw controls.failGet;
      return { page: { ...clone(page), contentVersion: server.version, blocks: clone(server.blocks).sort((a, b) => a.sortOrder - b.sortOrder) } };
    }
    throw new Error(`Unexpected harness request: ${path}`);
  }
  ctx = {
    console: { warn() {} }, Map, Set, Object, Number, JSON, Boolean, String,
    window: { clearTimeout() {}, setTimeout() { return 0; } },
    state: { selectedPage: page, workspaceView: "page", user: { id: "u" }, authenticated: true, pageEditLockDepth: 0 },
    workspaceNavigationGeneration: 1,
    controls, metrics, server, rows, drafts, recoveryStorage, pageDraftStore,
    skippedApiRequest: Symbol("skipped"), pendingBlockCreateTasks: new Map(),
    pageDraftSourceId: "tab", recoveryStorageFailureDrainInFlight: false, pageTitleDraftConflict: false,
    blockSaveTimers: new Map(), blockSaveQueues: new Map(), blockSaveRows: new Map(), blockSaveTaskIds: new Map(),
    blockEditAuthenticationScopes: new Map(), blockDraftConflictOrigins: new Map(),
    elements: { blockList: { querySelector: () => controls.unsafeRow ? {} : null } },
    t: (key) => key,
    setStatus: (text) => metrics.statuses.push(text),
    captureAuthenticatedSessionScope: authentication,
    isCurrentAuthenticatedSessionScope: (scope) => scope?.generation === controls.authGeneration,
    assertCurrentAuthenticatedSessionScope(scope) { if (!this.isCurrentAuthenticatedSessionScope(scope)) throw new Error("stale authentication"); },
    isCurrentWorkspaceNavigation: (generation) => generation === ctx.workspaceNavigationGeneration,
    isCollaborativePage: () => controls.collaborative,
    requireWritablePage: () => controls.writable,
    canPersistSelectedPage: () => controls.writable,
    canEditSelectedPage: () => controls.writable,
    getDraftScope: () => ({ userId: "u", pageId: ctx.state.selectedPage.id }),
    buildBlockPayload: (row) => clone(row.payload),
    persistBlockDraft(row, payload) { metrics.drafts++; drafts.set(row.dataset.blockId, { payload: clone(payload), revision: Number(row.dataset.editRevision), expectedVersion: ctx.getBlockById(row.dataset.blockId)?.version }); controls.storagePending = true; return true; },
    promoteBlockDraftConflict: () => false,
    async requireDirectRecoveryDurability() { metrics.flushes++; await controls.onFlush?.(ctx); if (controls.failStorage) throw new Error("durability failed"); controls.storagePending = false; return true; },
    hasPendingPageEdits: () => controls.storagePending || controls.pendingEdits || [...rows.values()].some((row) => row.classList.contains("is-dirty")) || [...ctx.blockSaveQueues.values()].some((queue) => queue.busy),
    syncBeforeUnloadProtection() {},
    recordBlockEditorHistory: () => metrics.history++,
    preserveInputAfterRecoveryAdmissionFailure() {},
    findRenderedBlockRow: (id) => rows.get(id),
    updateRenderedBlockPreview() {},
    renderSelectedPage: () => { metrics.renders++; },
    createMutationId: () => `mutation-${++sequence}`,
    isAmbiguousApiError: (error) => error?.ambiguous === true,
    isDefinitiveApiError: (error) => Boolean(error?.status),
    submitWithFreshMutationIdOnReuse: (_task, submit) => submit(),
    withPageModeMutationFence: (_id, submit) => submit(),
    api: request,
    applyPageSummaryUpdate(id, updates) { if (ctx.state.selectedPage.id === id) Object.assign(ctx.state.selectedPage, updates); metrics.summaryUpdates = (metrics.summaryUpdates ?? 0) + 1; },
    applyPageContentVersion(id, value) { if (ctx.state.selectedPage.id === id) ctx.state.selectedPage.contentVersion = Math.max(ctx.state.selectedPage.contentVersion, value); },
    async openPage(id) {
      await ctx.requireDirectRecoveryDurability();
      const data = await request(`/api/pages/${id}`);
      if (!ctx.hasPendingPageEdits()) ctx.state.selectedPage = data.page;
      // Model the real navigation generation change but preserve live dirty text.
      ctx.workspaceNavigationGeneration++;
      ctx.renderSelectedPage();
    },
    async persistBlockOrder(parentId, ids, overrides) {
      const items = ids.map((id, sortOrder) => ({ id, parentBlockId: parentId, sortOrder, expectedVersion: overrides[id] ?? ctx.getBlockById(id)?.version }));
      const data = await request("/api/pages/p/blocks/reorder", { method: "POST", body: { mutationId: ctx.createMutationId(), items } });
      ctx.applyPageContentVersion("p", data.pageContentVersion);
      for (const block of data.blocks) ctx.updateBlockInState(block);
      controls.storagePending = true; // asynchronous acknowledgement cleanup
      return data;
    },
    planConfirmedBlockInsertion
  };
  // Functions invoked without an explicit receiver must not depend on `this`.
  ctx.assertCurrentAuthenticatedSessionScope = (scope) => { if (!ctx.isCurrentAuthenticatedSessionScope(scope)) throw new Error("stale authentication"); };
  ctx.getBlockSaveQueue = (id) => {
    let queue = ctx.blockSaveQueues.get(id);
    if (!queue) {
      queue = {
        busy: false,
        async enqueue(task) {
          queue.busy = true;
          try {
            const result = await request(`/api/blocks/${id}`, { method: "PATCH", body: { ...task.payload, expectedVersion: task.expectedVersion, basePageContentVersion: task.basePageContentVersion, mutationId: task.mutationId } });
            ctx.updateBlockInState(result.block); ctx.applyPageContentVersion(task.pageId, result.pageContentVersion);
            drafts.delete(id); ctx.blockEditAuthenticationScopes.delete(id);
            task.row.classList.remove("is-dirty", "save-error"); delete task.row.dataset.draftSourceId; delete task.row.dataset.draftExpectedVersion;
            controls.storagePending = true;
            return result;
          } finally { queue.busy = false; }
        }
      };
      ctx.blockSaveQueues.set(id, queue);
    }
    return queue;
  };
  // The production collaborative save branch remains in saveBlockRow unchanged.
  ctx.state.collaborationSession = { isReady: true, async upsertBlock(block) { metrics.collaborativeWrites = (metrics.collaborativeWrites ?? 0) + 1; return block; } };
  ctx.isCurrentCollaborationMutationContext = (scope, id, session) => ctx.isCurrentAuthenticatedSessionScope(scope) && ctx.state.selectedPage.id === id && ctx.state.collaborationSession === session;
  const names = ["getPositiveVersion", "getLatestKnownVersion", "sortJsonValue", "jsonValuesMatch", "normalizeComparableMetadata", "blockPayloadsMatch", "flattenBlocks", "getBlockById", "updateBlockInState", "normalizeParentBlockId", "getPageBlockSiblings", "getBlockSiblings", "reorderPageBlockSiblings", "applyAuthoritativePageContentVersion", "shouldReconcileCanonicalCreatedBlockOrder", "adoptCommittedCreatedBlockLocally", "reconcileCanonicalCreatedBlock", "saveBlockRow", "getBlockCreateTask", "submitBlockCreateTask", "createEmptyBlock", "captureDirectBlockInsertionContext", "isCurrentDirectBlockInsertionContext", "tryRenderConfirmedBlockInsertion", "insertBlockRelative", "appendBlock"];
  vm.createContext(ctx);
  vm.runInContext(names.map((name) => functionSource(source, name)).filter(Boolean).join("\n\n"), ctx);
  return ctx;
}

export async function measureEnter({ source = defaultAppSource, latencyMs = 0, dirty = false, middle = false } = {}) {
  const ctx = createHarness({ source, latencyMs, blocks: middle ? [makeBlock("a"), makeBlock("b", 1)] : [makeBlock("a")] });
  const row = ctx.rows.get("a");
  if (dirty) { row.payload.markdown = "new text 한글"; row.classList.add("is-dirty"); }
  const started = performance.now();
  await ctx.saveBlockRow(row, { quiet: true });
  await ctx.appendBlock(row);
  return {
    latencyMs, dirty, middle, elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    requests: ctx.metrics.requests.map(({ method, path }) => `${method} ${path}`),
    committedCreates: ctx.metrics.creates,
    finalBlockIds: ctx.state.selectedPage.blocks.map((block) => block.id),
    finalVersions: ctx.state.selectedPage.blocks.map((block) => block.version)
  };
}
