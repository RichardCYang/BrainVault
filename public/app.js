const tokenKey = "brainvault.token";
const rootParentKey = "__root__";

const state = {
  token: localStorage.getItem(tokenKey),
  user: null,
  pages: [],
  allPages: [],
  selectedPage: null,
  activeTag: "",
  searchQuery: "",
  authMode: window.location.hash === "#signup" ? "register" : "login",
  activeSlashBlockId: null,
  activeSlashIndex: 0,
  activeInlineBlockId: null,
  activeInlineSelection: null,
  activeBlockMenuId: null,
  activeBlockMenuHandle: null,
  pendingFocusBlockId: null
};

const blockTypeLabels = {
  MARKDOWN: "텍스트",
  HEADING_1: "제목 1",
  HEADING_2: "제목 2",
  HEADING_3: "제목 3",
  TODO: "할 일",
  QUOTE: "인용",
  CALLOUT: "콜아웃",
  TABLE: "표",
  CODE: "코드",
  DIVIDER: "구분선",
  IMAGE: "이미지"
};

const calloutTypePresets = [
  { id: "idea", label: "아이디어", icon: "💡" },
  { id: "info", label: "정보", icon: "ℹ️" },
  { id: "success", label: "성공", icon: "✅" },
  { id: "warning", label: "주의", icon: "⚠️" },
  { id: "danger", label: "위험", icon: "⛔" }
];
const calloutTypeIds = new Set(calloutTypePresets.map((item) => item.id));

const tableLimits = { rows: 50, columns: 20, cellLength: 4000 };

function createDefaultTableData(rows = 3, columns = 3) {
  const safeRows = Math.max(1, Math.min(tableLimits.rows, Math.trunc(rows) || 3));
  const safeColumns = Math.max(1, Math.min(tableLimits.columns, Math.trunc(columns) || 3));
  return {
    rows: Array.from({ length: safeRows }, () => Array.from({ length: safeColumns }, () => "")),
    headerRow: false,
    headerColumn: false
  };
}

function normalizeTableData(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceRows = Array.isArray(source.rows) ? source.rows.slice(0, tableLimits.rows) : [];
  const columnCount = Math.max(
    1,
    Math.min(
      tableLimits.columns,
      sourceRows.reduce((max, row) => (Array.isArray(row) ? Math.max(max, row.length) : max), 0) || 3
    )
  );
  const rows = sourceRows
    .filter(Array.isArray)
    .map((row) =>
      Array.from({ length: columnCount }, (_, index) => {
        const cell = row[index];
        return (cell === null || cell === undefined ? "" : String(cell)).slice(0, tableLimits.cellLength);
      })
    );

  return {
    rows: rows.length ? rows : createDefaultTableData(3, columnCount).rows,
    headerRow: source.headerRow === true,
    headerColumn: source.headerColumn === true
  };
}

const slashCommands = [
  { type: "MARKDOWN", command: "/text", label: "텍스트", hint: "일반 마크다운 블록", keywords: ["markdown", "text", "문단", "텍스트"] },
  { type: "HEADING_1", command: "/h1", label: "제목 1", hint: "가장 큰 제목", keywords: ["heading", "title", "제목", "h1"] },
  { type: "HEADING_2", command: "/h2", label: "제목 2", hint: "중간 제목", keywords: ["heading", "subtitle", "제목", "h2"] },
  { type: "HEADING_3", command: "/h3", label: "제목 3", hint: "작은 제목", keywords: ["heading", "제목", "h3"] },
  { type: "TODO", command: "/todo", label: "체크박스", hint: "할 일 블록", keywords: ["todo", "task", "check", "할일", "체크"] },
  { type: "QUOTE", command: "/quote", label: "인용", hint: "인용문 블록", keywords: ["quote", "인용"] },
  { type: "CALLOUT", command: "/callout", label: "콜아웃", hint: "강조 박스", keywords: ["callout", "notice", "콜아웃", "강조"] },
  { type: "TABLE", command: "/table", label: "표", hint: "행과 열을 편집하는 간단한 표", keywords: ["table", "grid", "표", "테이블"] },
  { type: "CODE", command: "/code", label: "코드", hint: "코드 블록", keywords: ["code", "코드"] },
  { type: "DIVIDER", command: "/divider", label: "구분선", hint: "가로 구분선", keywords: ["divider", "hr", "line", "구분선"] },
  { type: "IMAGE", command: "/image", label: "이미지", hint: "이미지 URL 블록", keywords: ["image", "img", "사진", "이미지"] }
];

const blockSaveTimers = new Map();
let pageTitleSaveTimer = null;
let activeBlockDrag = null;
let suppressBlockHandleClickUntil = 0;
let blockOrderSaving = false;

const $ = (selector) => document.querySelector(selector);

const elements = {
  authPanel: $("#auth-panel"),
  workspacePanel: $("#workspace-panel"),
  authForm: $("#auth-form"),
  authKicker: $("#auth-kicker"),
  authTitle: $("#auth-title"),
  authDescription: $("#auth-description"),
  authSubmit: $("#auth-submit"),
  authSwitchCopy: $("#auth-switch-copy"),
  authSwitchLink: $("#auth-switch-link"),
  registerFields: $("#register-fields"),
  username: $("#username"),
  password: $("#password"),
  name: $("#name"),
  userLabel: $("#user-label"),
  logoutButton: $("#logout-button"),
  searchForm: $("#search-form"),
  searchInput: $("#search-input"),
  defaultCollectionButton: $("#default-collection-button"),
  addDocumentButton: $("#add-document-button"),
  collectionCount: $("#collection-count"),
  pageList: $("#page-list"),
  status: $("#status"),
  welcomeView: $("#welcome-view"),
  homeNewPageButton: $("#home-new-page-button"),
  homeDocumentList: $("#home-document-list"),
  homeDocumentCount: $("#home-document-count"),
  homeCollectionList: $("#home-collection-list"),
  pageView: $("#page-view"),
  pageKicker: $("#page-kicker"),
  pageTitle: $("#page-title"),
  pageTags: $("#page-tags"),
  savePageButton: $("#save-page-button"),
  archivePageButton: $("#archive-page-button"),
  blockCount: $("#block-count"),
  blockList: $("#block-list"),
  slashMenu: $("#slash-menu"),
  blockContextMenu: $("#block-context-menu"),
  calloutTypeGroup: $("#callout-type-group"),
  inlineToolbar: $("#inline-toolbar")
};

function setAuthMode(mode, updateHash = true) {
  state.authMode = mode === "register" ? "register" : "login";
  const isRegister = state.authMode === "register";

  elements.authKicker.textContent = isRegister ? "Create account" : "Welcome back";
  elements.authTitle.textContent = isRegister ? "회원가입" : "로그인";
  elements.authDescription.textContent = isRegister
    ? "아이디와 비밀번호로 새 BrainVault 계정을 만드세요."
    : "노트 작성에 바로 집중할 수 있도록 아이디와 비밀번호만 입력하세요.";
  elements.authSubmit.dataset.authMode = state.authMode;
  elements.authSubmit.textContent = isRegister ? "회원가입" : "로그인";
  elements.authSwitchCopy.textContent = isRegister ? "이미 계정이 있으신가요?" : "회원이 아니신가요?";
  elements.authSwitchLink.textContent = isRegister ? "로그인" : "회원가입";
  elements.authSwitchLink.href = isRegister ? "#login" : "#signup";
  elements.registerFields.classList.toggle("hidden", !isRegister);
  elements.password.autocomplete = isRegister ? "new-password" : "current-password";

  if (updateHash) {
    const hash = isRegister ? "#signup" : "#login";
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

function setToken(token) {
  state.token = token;
  if (token) localStorage.setItem(tokenKey, token);
  else localStorage.removeItem(tokenKey);
}

function tagsFromInput(value) {
  return value
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);

  let body = options.body;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }

  const response = await fetch(path, { ...options, headers, body });
  if (response.status === 204) return null;

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    if (response.status === 401) {
      setToken(null);
      state.user = null;
      renderShell();
    }
    throw new Error(data?.error?.message ?? data?.message ?? `HTTP ${response.status}`);
  }

  return data;
}

function renderShell() {
  const authenticated = Boolean(state.token && state.user);
  document.body.classList.toggle("auth-mode", !authenticated);
  document.body.classList.toggle("app-mode", authenticated);
  elements.authPanel.classList.toggle("hidden", authenticated);
  elements.workspacePanel.classList.toggle("hidden", !authenticated);
  elements.userLabel.textContent = authenticated ? `${state.user.name ?? state.user.username}` : "";
}

function sortByRecent(items) {
  return [...items].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function buildPageTree(pages) {
  const ids = new Set(pages.map((page) => page.id));
  const groups = new Map([[rootParentKey, []]]);

  for (const page of pages) {
    const parentKey = page.parentPageId && ids.has(page.parentPageId) ? page.parentPageId : rootParentKey;
    if (!groups.has(parentKey)) groups.set(parentKey, []);
    groups.get(parentKey).push(page);
  }

  for (const [key, children] of groups) groups.set(key, sortByRecent(children));
  return groups;
}

function flattenPageTree(pages = state.allPages) {
  const groups = buildPageTree(pages);
  const flat = [];
  const walk = (parentKey = rootParentKey, depth = 0) => {
    for (const page of groups.get(parentKey) ?? []) {
      flat.push({ ...page, depth });
      walk(page.id, depth + 1);
    }
  };
  walk();
  return flat;
}

function getCollections() {
  const counts = new Map();
  for (const page of state.allPages) {
    for (const tag of page.tags ?? []) {
      const name = tag.name.toLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

function makeCountBadge(text) {
  const badge = document.createElement("span");
  badge.className = "item-count";
  badge.textContent = text;
  return badge;
}

function makeEmptyMessage(message) {
  const empty = document.createElement("p");
  empty.className = "muted empty-copy";
  empty.textContent = message;
  return empty;
}

function renderDefaultCollection() {
  elements.collectionCount.textContent = String(state.allPages.length);
  elements.defaultCollectionButton.classList.add("active");
}


function renderDocumentNode(page, groups, depth = 0) {
  const wrapper = document.createElement("div");
  wrapper.className = "document-node";
  wrapper.style.setProperty("--depth", String(depth));

  const children = groups.get(page.id) ?? [];
  const button = document.createElement("button");
  button.type = "button";
  button.className = "document-item";
  button.classList.toggle("active", state.selectedPage?.id === page.id);
  button.dataset.pageId = page.id;

  const caret = document.createElement("span");
  caret.className = "doc-caret";
  caret.textContent = children.length ? "▾" : "•";

  const icon = document.createElement("span");
  icon.className = "doc-icon";
  icon.textContent = page.icon ?? "📄";

  const label = document.createElement("span");
  label.className = "doc-label";
  label.textContent = page.title;

  button.append(caret, icon, label);
  wrapper.append(button);

  if (children.length) {
    const group = document.createElement("div");
    group.className = "document-children";
    for (const child of children) group.append(renderDocumentNode(child, groups, depth + 1));
    wrapper.append(group);
  }

  return wrapper;
}

function renderDocumentTree() {
  elements.pageList.replaceChildren();

  if (!state.pages.length) {
    const message = state.searchQuery || state.activeTag
      ? "조건에 맞는 문서가 없습니다. 검색어를 바꿔보세요."
      : "아직 문서가 없습니다. 기본 컬렉션의 +를 눌러 시작하세요.";
    elements.pageList.append(makeEmptyMessage(message));
    return;
  }

  const groups = buildPageTree(state.pages);
  for (const page of groups.get(rootParentKey) ?? []) {
    elements.pageList.append(renderDocumentNode(page, groups));
  }
}

function renderParentOptions() {
  // BrainVault now uses one simple default collection. New documents are created directly as root documents.
}


function makeHomeDocumentButton(page) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "home-row home-document-item";
  button.dataset.pageId = page.id;

  const title = document.createElement("strong");
  title.textContent = `${page.icon ?? "📄"} ${page.title}`;

  button.append(title);
  return button;
}

function makeHomeGuideRow(titleText, metaText) {
  const row = document.createElement("div");
  row.className = "home-row home-guide-row";

  const title = document.createElement("strong");
  title.textContent = titleText;

  const meta = document.createElement("span");
  meta.textContent = metaText;

  row.append(title, meta);
  return row;
}

function renderHome() {
  elements.homeDocumentCount.textContent = `${state.allPages.length}개`;
  elements.homeDocumentList.replaceChildren();
  elements.homeCollectionList.replaceChildren();

  if (!state.allPages.length) {
    elements.homeDocumentList.append(makeEmptyMessage("아직 문서가 없습니다. 왼쪽 기본 컬렉션의 +를 눌러 시작하세요."));
  } else {
    for (const page of sortByRecent(state.allPages).slice(0, 8)) {
      elements.homeDocumentList.append(makeHomeDocumentButton(page));
    }
  }

  elements.homeCollectionList.append(
    makeHomeGuideRow("1. 새 페이지 만들기", "사이드바의 + 또는 상단 버튼으로 바로 시작하세요."),
    makeHomeGuideRow("2. 제목과 태그 정리", "페이지의 맥락을 한눈에 알아볼 수 있게 정리하세요."),
    makeHomeGuideRow("3. / 로 블록 선택", "텍스트, 제목, 할 일, 표, 코드 블록을 빠르게 추가하세요.")
  );
}


function renderPages() {
  renderDefaultCollection();
  renderDocumentTree();
  renderHome();
}

function flattenBlocks(blocks) {
  const result = [];
  const walk = (items, depth = 0) => {
    for (const block of items) {
      result.push({ ...block, depth });
      if (block.children?.length) walk(block.children, depth + 1);
    }
  };
  walk(blocks ?? []);
  return result;
}

function getBlockTypeLabel(type) {
  return blockTypeLabels[type] ?? type;
}

function normalizeCalloutType(value) {
  return calloutTypeIds.has(value) ? value : "idea";
}

function getBlockCalloutType(block) {
  return normalizeCalloutType(block?.metadata?.calloutType);
}

function getBlockMetadata(block) {
  return block?.metadata && typeof block.metadata === "object" && !Array.isArray(block.metadata)
    ? { ...block.metadata }
    : {};
}

function getBlockById(blockId, blocks = state.selectedPage?.blocks ?? []) {
  for (const block of blocks) {
    if (block.id === blockId) return block;
    const child = getBlockById(blockId, block.children ?? []);
    if (child) return child;
  }
  return null;
}

function updateBlockInState(updatedBlock, blocks = state.selectedPage?.blocks ?? []) {
  for (const block of blocks) {
    if (block.id === updatedBlock.id) {
      Object.assign(block, updatedBlock, { children: block.children ?? [] });
      return true;
    }
    if (updateBlockInState(updatedBlock, block.children ?? [])) return true;
  }
  return false;
}

function autoGrowTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(textarea.scrollHeight, 30)}px`;
}

function getBlockTableData(block) {
  return normalizeTableData(block?.metadata?.table);
}

function makeTableActionButton(action, label, title, { pressed = null, disabled = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  if (pressed !== null) button.setAttribute("aria-pressed", String(pressed));
  button.disabled = disabled;
  return button;
}

function createTableEditor(row, tableValue) {
  const tableData = normalizeTableData(tableValue);
  const rowCount = tableData.rows.length;
  const columnCount = tableData.rows[0]?.length ?? 1;
  const activeRow = Math.min(Number.parseInt(row.dataset.tableActiveRow ?? "0", 10) || 0, rowCount - 1);
  const activeColumn = Math.min(Number.parseInt(row.dataset.tableActiveColumn ?? "0", 10) || 0, columnCount - 1);

  row.dataset.tableHeaderRow = String(tableData.headerRow);
  row.dataset.tableHeaderColumn = String(tableData.headerColumn);
  row.dataset.tableActiveRow = String(activeRow);
  row.dataset.tableActiveColumn = String(activeColumn);

  const editor = document.createElement("div");
  editor.className = "table-block-editor";

  const toolbar = document.createElement("div");
  toolbar.className = "table-block-toolbar";
  toolbar.setAttribute("aria-label", "표 편집 도구");

  const size = document.createElement("span");
  size.className = "table-size-label";
  size.textContent = `${rowCount} × ${columnCount}`;

  toolbar.append(
    size,
    makeTableActionButton("table-toggle-header-row", "첫 행", "첫 행을 머리글로 사용", {
      pressed: tableData.headerRow
    }),
    makeTableActionButton("table-toggle-header-column", "첫 열", "첫 열을 머리글로 사용", {
      pressed: tableData.headerColumn
    }),
    makeTableActionButton("table-delete-row", "− 행", "선택한 행 삭제", { disabled: rowCount <= 1 }),
    makeTableActionButton("table-delete-column", "− 열", "선택한 열 삭제", { disabled: columnCount <= 1 })
  );

  const scroller = document.createElement("div");
  scroller.className = "table-block-scroll";
  scroller.tabIndex = -1;

  const table = document.createElement("table");
  table.className = "table-block-grid";
  table.setAttribute("role", "grid");
  table.setAttribute("aria-label", "편집 가능한 표");
  table.setAttribute("aria-rowcount", String(rowCount));
  table.setAttribute("aria-colcount", String(columnCount));

  const tbody = document.createElement("tbody");
  tableData.rows.forEach((cells, rowIndex) => {
    const tr = document.createElement("tr");
    tr.setAttribute("role", "row");

    cells.forEach((value, columnIndex) => {
      const isColumnHeader = tableData.headerRow && rowIndex === 0;
      const isRowHeader = tableData.headerColumn && columnIndex === 0;
      const cell = document.createElement(isColumnHeader || isRowHeader ? "th" : "td");
      cell.className = "table-block-cell";
      if (isColumnHeader) cell.scope = "col";
      else if (isRowHeader) cell.scope = "row";
      cell.setAttribute("role", isColumnHeader ? "columnheader" : isRowHeader ? "rowheader" : "gridcell");

      const input = document.createElement("input");
      input.type = "text";
      input.className = "table-cell-input";
      input.value = value;
      input.maxLength = tableLimits.cellLength;
      input.dataset.tableRow = String(rowIndex);
      input.dataset.tableColumn = String(columnIndex);
      input.autocomplete = "off";
      input.spellcheck = true;
      input.setAttribute("aria-label", `${rowIndex + 1}행 ${columnIndex + 1}열`);
      cell.append(input);
      tr.append(cell);
    });

    tbody.append(tr);
  });

  table.append(tbody);

  const surface = document.createElement("div");
  surface.className = "table-block-surface";

  const addColumnButton = makeTableActionButton(
    "table-add-column",
    "＋",
    "표 맨 오른쪽에 열 추가",
    { disabled: columnCount >= tableLimits.columns }
  );
  addColumnButton.classList.add("table-edge-add", "table-edge-add-column");

  const addRowButton = makeTableActionButton("table-add-row", "＋", "표 맨 아래에 행 추가", {
    disabled: rowCount >= tableLimits.rows
  });
  addRowButton.classList.add("table-edge-add", "table-edge-add-row");

  const corner = document.createElement("span");
  corner.className = "table-edge-corner";
  corner.setAttribute("aria-hidden", "true");

  const main = document.createElement("div");
  main.className = "table-block-main";
  main.append(table, addColumnButton);

  const footer = document.createElement("div");
  footer.className = "table-block-footer";
  footer.append(addRowButton, corner);

  surface.append(main, footer);
  scroller.append(surface);
  editor.append(toolbar, scroller);
  return editor;
}

function createTextBlockEditor(block) {
  const textarea = document.createElement("textarea");
  textarea.name = "markdown";
  textarea.className = "block-row-input";
  textarea.rows = 1;
  textarea.spellcheck = true;
  textarea.placeholder = block.type === "DIVIDER" ? "구분선 블록" : "내용을 입력하거나 '/'로 블록 타입을 선택하세요";
  textarea.value = block.markdown ?? "";
  textarea.setAttribute("aria-label", `${getBlockTypeLabel(block.type)} 블록 내용`);
  requestAnimationFrame(() => autoGrowTextarea(textarea));
  return textarea;
}

function mountBlockEditor(row, block) {
  const host = row.querySelector(".block-editor-host");
  if (!host) return;
  host.replaceChildren(
    block.type === "TABLE" ? createTableEditor(row, getBlockTableData(block)) : createTextBlockEditor(block)
  );
}

function renderBlock(block) {
  const row = document.createElement("article");
  row.className = "editor-block-row";
  row.dataset.blockId = block.id;
  row.dataset.blockType = block.type;
  row.dataset.calloutType = getBlockCalloutType(block);
  row.dataset.parentBlockId = block.parentBlockId ?? "";
  row.dataset.sortOrder = String(block.sortOrder ?? 0);
  row.dataset.depth = String(Math.min(block.depth ?? 0, 5));
  row.style.setProperty("--depth", String(Math.min(block.depth ?? 0, 5)));

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "block-handle";
  handle.title = "드래그하여 순서 변경 · 클릭하여 블록 메뉴";
  handle.setAttribute("aria-label", "블록 순서 변경 핸들 및 블록 메뉴");
  handle.setAttribute("aria-grabbed", "false");
  handle.setAttribute("aria-haspopup", "menu");
  handle.setAttribute("aria-expanded", "false");
  handle.setAttribute("aria-controls", "block-context-menu");
  handle.dataset.action = "open-block-menu";
  handle.textContent = "⠿";

  const body = document.createElement("div");
  body.className = "block-row-body";

  const topLine = document.createElement("div");
  topLine.className = "block-row-topline";

  const typeButton = document.createElement("button");
  typeButton.type = "button";
  typeButton.className = "block-type-pill";
  typeButton.dataset.action = "open-slash-menu";
  typeButton.textContent = getBlockTypeLabel(block.type);

  const meta = document.createElement("span");
  meta.className = "block-row-meta";
  meta.textContent = `블록 · ${formatDate(block.updatedAt)}`;
  topLine.append(typeButton, meta);

  const todoLabel = document.createElement("label");
  todoLabel.className = "inline-todo";
  todoLabel.classList.toggle("hidden", block.type !== "TODO");
  const checked = document.createElement("input");
  checked.type = "checkbox";
  checked.name = "checked";
  checked.checked = Boolean(block.checked);
  todoLabel.append(checked, document.createTextNode("완료"));

  const editorHost = document.createElement("div");
  editorHost.className = "block-editor-host";
  body.append(topLine, todoLabel, editorHost);
  row.append(handle, body);
  mountBlockEditor(row, block);
  return row;
}

function getBlockRow(target) {
  return target?.closest?.(".editor-block-row") ?? null;
}

function getBlockTextarea(row) {
  return row?.querySelector('textarea[name="markdown"]') ?? null;
}

function getBlockChecked(row) {
  return row?.querySelector('input[name="checked"]') ?? null;
}

function getTableCellInputs(row) {
  return [...(row?.querySelectorAll(".table-cell-input") ?? [])];
}

function extractTableData(row) {
  const inputs = getTableCellInputs(row);
  const rowCount = Math.max(1, ...inputs.map((input) => Number.parseInt(input.dataset.tableRow ?? "0", 10) + 1));
  const columnCount = Math.max(
    1,
    ...inputs.map((input) => Number.parseInt(input.dataset.tableColumn ?? "0", 10) + 1)
  );
  const rows = Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => ""));

  for (const input of inputs) {
    const rowIndex = Number.parseInt(input.dataset.tableRow ?? "0", 10) || 0;
    const columnIndex = Number.parseInt(input.dataset.tableColumn ?? "0", 10) || 0;
    rows[rowIndex][columnIndex] = input.value.slice(0, tableLimits.cellLength);
  }

  return normalizeTableData({
    rows,
    headerRow: row?.dataset.tableHeaderRow === "true",
    headerColumn: row?.dataset.tableHeaderColumn === "true"
  });
}

function buildBlockPayload(row) {
  const type = row.dataset.blockType ?? "MARKDOWN";
  const textarea = getBlockTextarea(row);
  const checked = getBlockChecked(row);
  const block = getBlockById(row.dataset.blockId);
  const payload = {
    type,
    markdown: textarea?.value ?? "",
    checked: checked ? checked.checked : false
  };
  const metadata = getBlockMetadata(block);

  if (type === "TABLE") {
    const table = extractTableData(row);
    metadata.table = table;
    payload.markdown = table.rows.map((cells) => cells.join("\t")).join("\n").slice(0, 20_000);
    payload.metadata = metadata;
  } else if (metadata.table) {
    delete metadata.table;
    payload.metadata = Object.keys(metadata).length ? metadata : null;
  }

  return payload;
}

function normalizeParentBlockId(value) {
  return value || null;
}

function getBlockSiblings(parentBlockId) {
  if (!state.selectedPage) return [];
  if (!parentBlockId) return state.selectedPage.blocks ?? [];
  return getBlockById(parentBlockId)?.children ?? [];
}

function syncVisibleBlocksToState() {
  for (const row of elements.blockList.querySelectorAll(".editor-block-row")) {
    const block = getBlockById(row.dataset.blockId);
    if (!block) continue;
    Object.assign(block, buildBlockPayload(row));
  }
}

function reorderBlockSiblingsInState(parentBlockId, orderedIds) {
  const siblings = getBlockSiblings(parentBlockId);
  const byId = new Map(siblings.map((block) => [block.id, block]));
  const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  if (reordered.length !== siblings.length) return false;

  reordered.forEach((block, index) => {
    block.sortOrder = index;
  });
  siblings.splice(0, siblings.length, ...reordered);
  return true;
}

function getBlockDepth(row) {
  return Number.parseInt(row?.dataset.depth ?? "0", 10) || 0;
}

function getBlockGroupRows(row) {
  if (!row) return [];
  const depth = getBlockDepth(row);
  const rows = [row];
  let next = row.nextElementSibling;

  while (next) {
    if (!next.classList.contains("editor-block-row")) {
      next = next.nextElementSibling;
      continue;
    }
    if (getBlockDepth(next) <= depth) break;
    rows.push(next);
    next = next.nextElementSibling;
  }

  return rows;
}

function getSiblingRows(parentBlockId) {
  const normalized = parentBlockId ?? "";
  return [...elements.blockList.querySelectorAll(".editor-block-row")].filter(
    (row) => row.dataset.parentBlockId === normalized
  );
}

function getBlockGroupRect(row) {
  const rows = getBlockGroupRows(row);
  const firstRect = row.getBoundingClientRect();
  const lastRect = (rows.at(-1) ?? row).getBoundingClientRect();
  return { top: firstRect.top, bottom: lastRect.bottom };
}

function getBlockInsertionIndex(clientY, candidates) {
  let index = 0;
  for (const candidate of candidates) {
    const rect = getBlockGroupRect(candidate);
    if (clientY >= (rect.top + rect.bottom) / 2) index += 1;
    else break;
  }
  return index;
}

function getBlockContextMenuItems() {
  return [...elements.blockContextMenu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].filter(
    (item) => !item.closest(".hidden")
  );
}

function syncCalloutTypeMenu(row) {
  const isCallout = row?.dataset.blockType === "CALLOUT";
  elements.calloutTypeGroup?.classList.toggle("hidden", !isCallout);
  if (!isCallout) return;

  const activeType = normalizeCalloutType(row.dataset.calloutType);
  for (const button of elements.calloutTypeGroup.querySelectorAll('[data-action="change-callout-type"]')) {
    const isActive = button.dataset.calloutType === activeType;
    button.setAttribute("aria-checked", String(isActive));
    button.classList.toggle("is-selected", isActive);
  }
}

function setRowCalloutType(row, type) {
  if (!row) return;
  row.dataset.calloutType = normalizeCalloutType(type);
}

async function changeCalloutType(row, type) {
  if (!state.selectedPage || !row?.dataset.blockId || row.dataset.blockType !== "CALLOUT") return;

  const blockId = row.dataset.blockId;
  const block = getBlockById(blockId);
  const previousType = normalizeCalloutType(row.dataset.calloutType);
  const nextType = normalizeCalloutType(type);
  if (previousType === nextType) {
    closeBlockContextMenu({ restoreFocus: true });
    return;
  }

  const metadata = { ...getBlockMetadata(block), calloutType: nextType };
  setRowCalloutType(row, nextType);
  syncCalloutTypeMenu(row);
  row.classList.add("is-saving");

  try {
    const data = await api(`/api/blocks/${blockId}`, { method: "PATCH", body: { metadata } });
    updateBlockInState(data.block);
    row.classList.remove("is-saving");
    row.classList.add("is-saved");
    window.setTimeout(() => row.classList.remove("is-saved"), 900);
    closeBlockContextMenu({ restoreFocus: true });
    setStatus(`콜아웃 타입을 ${calloutTypePresets.find((item) => item.id === nextType)?.label ?? "변경"}으로 변경했습니다.`);
  } catch (error) {
    setRowCalloutType(row, previousType);
    syncCalloutTypeMenu(row);
    row.classList.remove("is-saving");
    setStatus(error.message, true);
  }
}

function closeBlockContextMenu({ restoreFocus = false } = {}) {
  const handle = state.activeBlockMenuHandle;
  getBlockRow(handle)?.classList.remove("is-menu-open");
  elements.blockContextMenu.classList.add("hidden");
  elements.blockContextMenu.style.removeProperty("left");
  elements.blockContextMenu.style.removeProperty("top");
  elements.blockContextMenu.style.removeProperty("visibility");
  handle?.setAttribute("aria-expanded", "false");
  state.activeBlockMenuId = null;
  state.activeBlockMenuHandle = null;

  if (restoreFocus && handle?.isConnected) handle.focus();
}

function positionBlockContextMenu(handle) {
  const handleRect = handle.getBoundingClientRect();
  elements.blockContextMenu.style.visibility = "hidden";
  elements.blockContextMenu.classList.remove("hidden");

  const menuRect = elements.blockContextMenu.getBoundingClientRect();
  const viewportPadding = 10;
  const gap = 6;
  const maxLeft = Math.max(viewportPadding, window.innerWidth - menuRect.width - viewportPadding);
  const left = Math.min(Math.max(handleRect.left, viewportPadding), maxLeft);
  let top = handleRect.bottom + gap;

  if (top + menuRect.height > window.innerHeight - viewportPadding) {
    top = handleRect.top - menuRect.height - gap;
  }

  elements.blockContextMenu.style.left = `${left}px`;
  elements.blockContextMenu.style.top = `${Math.max(viewportPadding, top)}px`;
  elements.blockContextMenu.style.visibility = "visible";
}

function openBlockContextMenu(row, handle, { focusFirst = false } = {}) {
  const blockId = row?.dataset.blockId;
  if (!blockId || !handle) return;

  const isSameOpenMenu =
    state.activeBlockMenuId === blockId && !elements.blockContextMenu.classList.contains("hidden");
  if (isSameOpenMenu) {
    closeBlockContextMenu({ restoreFocus: true });
    return;
  }

  closeSlashMenu();
  closeInlineToolbar();
  closeBlockContextMenu();

  state.activeBlockMenuId = blockId;
  state.activeBlockMenuHandle = handle;
  row.classList.add("is-menu-open");
  handle.setAttribute("aria-expanded", "true");
  syncCalloutTypeMenu(row);
  positionBlockContextMenu(handle);

  if (focusFirst) getBlockContextMenuItems()[0]?.focus();
}

function placeBlockDropIndicator(indicator, candidates, index, fallbackRow) {
  if (!indicator) return;
  const anchorRow = candidates[index] ?? candidates.at(-1) ?? fallbackRow;
  indicator.style.setProperty("--depth", String(getBlockDepth(anchorRow)));
  if (!candidates.length) {
    elements.blockList.insertBefore(indicator, fallbackRow);
    return;
  }

  if (index < candidates.length) {
    elements.blockList.insertBefore(indicator, candidates[index]);
    return;
  }

  const lastGroup = getBlockGroupRows(candidates.at(-1));
  (lastGroup.at(-1) ?? candidates.at(-1)).after(indicator);
}

function autoScrollForBlockDrag(clientY) {
  const edge = Math.min(96, window.innerHeight * 0.14);
  if (clientY < edge) {
    window.scrollBy(0, -Math.max(6, (edge - clientY) * 0.16));
  } else if (clientY > window.innerHeight - edge) {
    window.scrollBy(0, Math.max(6, (clientY - (window.innerHeight - edge)) * 0.16));
  }
}

function activateBlockDrag(event) {
  const drag = activeBlockDrag;
  if (!drag || drag.active) return;

  syncVisibleBlocksToState();
  closeSlashMenu();
  closeInlineToolbar();
  closeBlockContextMenu();

  drag.active = true;
  drag.siblingRows = getSiblingRows(drag.parentBlockId);
  drag.candidates = drag.siblingRows.filter((row) => row !== drag.row);
  drag.initialIndex = drag.siblingRows.indexOf(drag.row);
  drag.targetIndex = drag.initialIndex;
  drag.groupRows = getBlockGroupRows(drag.row);
  drag.indicator = document.createElement("div");
  drag.indicator.className = "block-drop-indicator";
  drag.indicator.setAttribute("aria-hidden", "true");

  for (const row of drag.groupRows) row.classList.add("is-dragging");
  drag.handle.setAttribute("aria-grabbed", "true");
  document.body.classList.add("is-block-dragging");
  placeBlockDropIndicator(drag.indicator, drag.candidates, drag.targetIndex, drag.row);
  event.preventDefault();
}

function updateBlockDrag(event) {
  const drag = activeBlockDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;

  if (!drag.active) {
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    const threshold = event.pointerType === "touch" ? 7 : 4;
    if (distance < threshold) return;
    activateBlockDrag(event);
  }

  event.preventDefault();
  drag.targetIndex = getBlockInsertionIndex(event.clientY, drag.candidates);
  placeBlockDropIndicator(drag.indicator, drag.candidates, drag.targetIndex, drag.row);
  autoScrollForBlockDrag(event.clientY);
}

function clearBlockDragVisuals(drag) {
  if (!drag) return;
  for (const row of drag.groupRows ?? []) row.classList.remove("is-dragging");
  drag.indicator?.remove();
  drag.handle.classList.remove("is-pressed");
  drag.handle.setAttribute("aria-grabbed", "false");
  document.body.classList.remove("is-block-dragging");
}

async function finishBlockDrag(event, { cancelled = false } = {}) {
  const drag = activeBlockDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;

  activeBlockDrag = null;

  if (drag.handle.hasPointerCapture?.(drag.pointerId)) {
    drag.handle.releasePointerCapture(drag.pointerId);
  }

  if (!drag.active) {
    drag.handle.classList.remove("is-pressed");
    return;
  }

  event.preventDefault();
  suppressBlockHandleClickUntil = Date.now() + 500;
  clearBlockDragVisuals(drag);

  if (cancelled || drag.targetIndex === drag.initialIndex) return;

  const previousIds = getBlockSiblings(drag.parentBlockId).map((block) => block.id);
  const orderedIds = drag.candidates.map((row) => row.dataset.blockId);
  orderedIds.splice(drag.targetIndex, 0, drag.row.dataset.blockId);

  if (!reorderBlockSiblingsInState(drag.parentBlockId, orderedIds)) return;

  blockOrderSaving = true;
  renderSelectedPage();
  setStatus("블록 순서를 저장하는 중입니다...");

  try {
    await api(`/api/pages/${state.selectedPage.id}/blocks/reorder`, {
      method: "POST",
      body: {
        items: orderedIds.map((id, index) => ({
          id,
          sortOrder: index,
          parentBlockId: drag.parentBlockId
        }))
      }
    });
    setStatus("블록 순서를 변경했습니다.");
  } catch (error) {
    reorderBlockSiblingsInState(drag.parentBlockId, previousIds);
    renderSelectedPage();
    setStatus(error.message, true);
  } finally {
    blockOrderSaving = false;
  }
}

function setRowType(row, type, { markdown } = {}) {
  const existing = getBlockById(row.dataset.blockId) ?? {};
  const previousType = row.dataset.blockType ?? existing.type ?? "MARKDOWN";
  const previousTextarea = getBlockTextarea(row);
  const metadata = getBlockMetadata(existing);

  if (previousType === "TABLE") metadata.table = extractTableData(row);
  if (type === "TABLE" && !metadata.table) metadata.table = createDefaultTableData();

  row.dataset.blockType = type;
  if (type === "CALLOUT") setRowCalloutType(row, row.dataset.calloutType);
  const typeButton = row.querySelector(".block-type-pill");
  if (typeButton) typeButton.textContent = getBlockTypeLabel(type);

  const todoLabel = row.querySelector(".inline-todo");
  todoLabel?.classList.toggle("hidden", type !== "TODO");

  mountBlockEditor(row, {
    ...existing,
    type,
    markdown: type === "TABLE" ? "" : markdown ?? previousTextarea?.value ?? existing.markdown ?? "",
    metadata
  });
}

function focusTableCell(row, rowIndex, columnIndex) {
  requestAnimationFrame(() => {
    const input = row.querySelector(
      `.table-cell-input[data-table-row="${rowIndex}"][data-table-column="${columnIndex}"]`
    );
    input?.focus();
    input?.select();
  });
}

function replaceTableData(row, value, { focusRow, focusColumn } = {}) {
  const data = normalizeTableData(value);
  const host = row.querySelector(".block-editor-host");
  if (!host) return;
  row.dataset.tableActiveRow = String(Math.max(0, Math.min(focusRow ?? 0, data.rows.length - 1)));
  row.dataset.tableActiveColumn = String(
    Math.max(0, Math.min(focusColumn ?? 0, (data.rows[0]?.length ?? 1) - 1))
  );
  host.replaceChildren(createTableEditor(row, data));
  scheduleBlockSave(row);
  focusTableCell(row, Number(row.dataset.tableActiveRow), Number(row.dataset.tableActiveColumn));
}

function handleTableAction(row, action) {
  const data = extractTableData(row);
  const rowCount = data.rows.length;
  const columnCount = data.rows[0]?.length ?? 1;
  const activeRow = Math.max(0, Math.min(Number(row.dataset.tableActiveRow) || 0, rowCount - 1));
  const activeColumn = Math.max(0, Math.min(Number(row.dataset.tableActiveColumn) || 0, columnCount - 1));
  let focusRow = activeRow;
  let focusColumn = activeColumn;

  if (action === "table-add-row" && rowCount < tableLimits.rows) {
    data.rows.push(Array.from({ length: columnCount }, () => ""));
    focusRow = data.rows.length - 1;
  } else if (action === "table-add-column" && columnCount < tableLimits.columns) {
    for (const cells of data.rows) cells.push("");
    focusColumn = columnCount;
  } else if (action === "table-delete-row" && rowCount > 1) {
    data.rows.splice(activeRow, 1);
    focusRow = Math.min(activeRow, data.rows.length - 1);
  } else if (action === "table-delete-column" && columnCount > 1) {
    for (const cells of data.rows) cells.splice(activeColumn, 1);
    focusColumn = Math.min(activeColumn, data.rows[0].length - 1);
  } else if (action === "table-toggle-header-row") {
    data.headerRow = !data.headerRow;
  } else if (action === "table-toggle-header-column") {
    data.headerColumn = !data.headerColumn;
  } else {
    return;
  }

  replaceTableData(row, data, { focusRow, focusColumn });
}

function handleTableCellKeydown(event, input, row) {
  if (event.isComposing) return false;
  const rowIndex = Number.parseInt(input.dataset.tableRow ?? "0", 10) || 0;
  const columnIndex = Number.parseInt(input.dataset.tableColumn ?? "0", 10) || 0;
  const data = extractTableData(row);
  const lastRow = data.rows.length - 1;
  const lastColumn = (data.rows[0]?.length ?? 1) - 1;
  const selectionStart = input.selectionStart ?? 0;
  const selectionEnd = input.selectionEnd ?? selectionStart;

  if (event.key === "ArrowUp" && rowIndex > 0) {
    event.preventDefault();
    focusTableCell(row, rowIndex - 1, columnIndex);
    return true;
  }

  if (event.key === "ArrowDown" && rowIndex < lastRow) {
    event.preventDefault();
    focusTableCell(row, rowIndex + 1, columnIndex);
    return true;
  }

  if (event.key === "ArrowLeft" && selectionStart === 0 && selectionEnd === 0 && columnIndex > 0) {
    event.preventDefault();
    focusTableCell(row, rowIndex, columnIndex - 1);
    return true;
  }

  if (
    event.key === "ArrowRight" &&
    selectionStart === input.value.length &&
    selectionEnd === input.value.length &&
    columnIndex < lastColumn
  ) {
    event.preventDefault();
    focusTableCell(row, rowIndex, columnIndex + 1);
    return true;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    if (event.shiftKey) {
      focusTableCell(row, Math.max(0, rowIndex - 1), columnIndex);
    } else if (rowIndex < lastRow) {
      focusTableCell(row, rowIndex + 1, columnIndex);
    } else if (data.rows.length < tableLimits.rows) {
      data.rows.push(Array.from({ length: lastColumn + 1 }, () => ""));
      replaceTableData(row, data, { focusRow: data.rows.length - 1, focusColumn: columnIndex });
    }
    return true;
  }

  if (event.key === "Tab" && !event.shiftKey && rowIndex === lastRow && columnIndex === lastColumn) {
    if (data.rows.length >= tableLimits.rows) return false;
    event.preventDefault();
    data.rows.push(Array.from({ length: lastColumn + 1 }, () => ""));
    replaceTableData(row, data, { focusRow: data.rows.length - 1, focusColumn: 0 });
    return true;
  }

  return false;
}

async function saveBlockRow(row, { quiet = false } = {}) {
  if (!state.selectedPage || !row?.dataset.blockId || row.dataset.deleting === "true") return;
  const blockId = row.dataset.blockId;
  clearTimeout(blockSaveTimers.get(blockId));
  blockSaveTimers.delete(blockId);
  row.classList.add("is-saving");

  try {
    const data = await api(`/api/blocks/${blockId}`, { method: "PATCH", body: buildBlockPayload(row) });
    updateBlockInState(data.block);
    row.classList.remove("is-dirty");
    row.classList.remove("is-saving");
    row.classList.add("is-saved");
    window.setTimeout(() => row.classList.remove("is-saved"), 900);
    if (!quiet) setStatus("블록을 저장했습니다.");
  } catch (error) {
    row.classList.remove("is-saving");
    setStatus(error.message, true);
  }
}

function scheduleBlockSave(row) {
  if (!row?.dataset.blockId) return;
  row.classList.add("is-dirty");
  const blockId = row.dataset.blockId;
  clearTimeout(blockSaveTimers.get(blockId));
  blockSaveTimers.set(
    blockId,
    window.setTimeout(() => saveBlockRow(row, { quiet: true }), 700)
  );
}

function getTextareaSelection(textarea) {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  if (start === end) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function escapeInlineHtml(value) {
  const element = document.createElement("div");
  element.textContent = value;
  return element.innerHTML;
}

function getTextareaSelectionRect(textarea, selection) {
  const textareaRect = textarea.getBoundingClientRect();
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const properties = [
    "boxSizing",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "textTransform",
    "textAlign",
    "lineHeight",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "wordBreak",
    "overflowWrap",
    "tabSize"
  ];

  mirror.style.position = "fixed";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.top = "0";
  mirror.style.left = "0";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflow = "hidden";

  for (const property of properties) {
    mirror.style[property] = computed[property];
  }

  mirror.textContent = textarea.value.slice(0, selection.start);
  const marker = document.createElement("span");
  marker.textContent = "\u00a0";
  mirror.append(marker);
  document.body.append(mirror);

  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const lineHeight = Number.parseFloat(computed.lineHeight) || markerRect.height || 20;
  const rect = {
    left: textareaRect.left + markerRect.left - mirrorRect.left - textarea.scrollLeft,
    top: textareaRect.top + markerRect.top - mirrorRect.top - textarea.scrollTop,
    width: Math.max(markerRect.width, 1),
    height: Math.max(markerRect.height, lineHeight)
  };

  mirror.remove();
  return rect;
}

function closeInlineToolbar() {
  elements.inlineToolbar.classList.add("hidden");
  state.activeInlineBlockId = null;
  state.activeInlineSelection = null;
}

function positionInlineToolbar(textarea, selection) {
  const selectionRect = getTextareaSelectionRect(textarea, selection);
  elements.inlineToolbar.classList.remove("hidden");
  elements.inlineToolbar.style.visibility = "hidden";

  const toolbarRect = elements.inlineToolbar.getBoundingClientRect();
  const maxLeft = window.innerWidth - toolbarRect.width - 12;
  let left = selectionRect.left + selectionRect.width / 2 - toolbarRect.width / 2;
  left = Math.max(12, Math.min(left, Math.max(12, maxLeft)));

  let top = selectionRect.top - toolbarRect.height - 10;
  if (top < 12) top = selectionRect.top + selectionRect.height + 10;
  top = Math.max(12, Math.min(top, window.innerHeight - toolbarRect.height - 12));

  elements.inlineToolbar.style.left = `${left}px`;
  elements.inlineToolbar.style.top = `${top}px`;
  elements.inlineToolbar.style.visibility = "visible";
}

function updateInlineToolbarForTextarea(textarea) {
  const row = getBlockRow(textarea);
  const selection = getTextareaSelection(textarea);
  if (!row || !selection) return closeInlineToolbar();

  closeSlashMenu();
  state.activeInlineBlockId = row.dataset.blockId;
  state.activeInlineSelection = selection;
  positionInlineToolbar(textarea, selection);
}

function getActiveInlineTextarea() {
  if (!state.activeInlineBlockId) return null;
  const row = elements.blockList.querySelector(`[data-block-id="${state.activeInlineBlockId}"]`);
  return getBlockTextarea(row);
}

function applyInlineFormat(format, value = "") {
  const textarea = getActiveInlineTextarea() ?? document.activeElement;
  if (!(textarea instanceof HTMLTextAreaElement)) return;

  const currentSelection = getTextareaSelection(textarea);
  const selection = state.activeInlineSelection ?? currentSelection;
  if (!selection) return;

  const selected = textarea.value.slice(selection.start, selection.end);
  let replacement = selected;
  let selectStart = selection.start;
  let selectEnd = selection.end;

  if (format === "bold") {
    replacement = `**${selected}**`;
    selectStart = selection.start + 2;
    selectEnd = selectStart + selected.length;
  } else if (format === "italic") {
    replacement = `*${selected}*`;
    selectStart = selection.start + 1;
    selectEnd = selectStart + selected.length;
  } else if (format === "strike") {
    replacement = `~~${selected}~~`;
    selectStart = selection.start + 2;
    selectEnd = selectStart + selected.length;
  } else if (format === "code") {
    replacement = `\`${selected}\``;
    selectStart = selection.start + 1;
    selectEnd = selectStart + selected.length;
  } else if (format === "link") {
    replacement = `[${selected}](https://)`;
    selectStart = selection.start + selected.length + 3;
    selectEnd = selectStart + "https://".length;
  } else if (format === "color") {
    const color = /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "#26384a";
    const prefix = `<span style="color: ${color}">`;
    const escaped = escapeInlineHtml(selected);
    replacement = `${prefix}${escaped}</span>`;
    selectStart = selection.start + prefix.length;
    selectEnd = selectStart + escaped.length;
  }

  textarea.focus();
  textarea.setRangeText(replacement, selection.start, selection.end, "preserve");
  textarea.setSelectionRange(selectStart, selectEnd);
  autoGrowTextarea(textarea);

  const row = getBlockRow(textarea);
  if (row) scheduleBlockSave(row);
  closeInlineToolbar();
  setStatus("선택한 텍스트 서식을 적용했습니다.");
}

function getSlashContext(textarea) {
  const position = textarea.selectionStart ?? textarea.value.length;
  const before = textarea.value.slice(0, position);
  const match = before.match(/(^|\n)\/([a-zA-Z0-9가-힣_-]*)$/);
  if (!match) return null;

  return {
    query: match[2].toLowerCase(),
    start: before.length - match[2].length - 1,
    end: position
  };
}

function getFilteredSlashCommands(query = "") {
  if (!query) return slashCommands;
  return slashCommands.filter((item) => {
    const haystack = [item.command, item.label, item.hint, ...item.keywords].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function closeSlashMenu() {
  elements.slashMenu.classList.add("hidden");
  elements.slashMenu.replaceChildren();
  state.activeSlashBlockId = null;
  state.activeSlashIndex = 0;
}

function positionSlashMenu(row) {
  const anchor = getBlockTextarea(row) ?? row.querySelector(".block-editor-host");
  const rect = anchor?.getBoundingClientRect() ?? row.getBoundingClientRect();
  elements.slashMenu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 332))}px`;
  elements.slashMenu.style.top = `${Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 332))}px`;
}

function renderSlashMenu(row, query = "") {
  closeInlineToolbar();
  closeBlockContextMenu();
  const commands = getFilteredSlashCommands(query);
  elements.slashMenu.replaceChildren();
  state.activeSlashBlockId = row.dataset.blockId;
  state.activeSlashIndex = Math.min(state.activeSlashIndex, Math.max(commands.length - 1, 0));

  if (!commands.length) {
    const empty = document.createElement("div");
    empty.className = "slash-menu-empty";
    empty.textContent = "일치하는 블록 타입이 없습니다.";
    elements.slashMenu.append(empty);
  }

  commands.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slash-menu-item";
    button.classList.toggle("active", index === state.activeSlashIndex);
    button.dataset.type = item.type;
    button.setAttribute("role", "menuitem");

    const label = document.createElement("strong");
    label.textContent = item.label;

    const command = document.createElement("code");
    command.textContent = item.command;

    const hint = document.createElement("span");
    hint.textContent = item.hint;

    button.append(label, command, hint);
    elements.slashMenu.append(button);
  });

  positionSlashMenu(row);
  elements.slashMenu.classList.remove("hidden");
}

function updateSlashMenuForTextarea(textarea) {
  const row = getBlockRow(textarea);
  if (!row) return closeSlashMenu();
  const context = getSlashContext(textarea);
  if (!context) return closeSlashMenu();
  renderSlashMenu(row, context.query);
}

async function applySlashCommand(row, type) {
  const previousTextarea = getBlockTextarea(row);
  const context = previousTextarea ? getSlashContext(previousTextarea) : null;
  let markdown = previousTextarea?.value ?? "";

  if (context) markdown = `${markdown.slice(0, context.start)}${markdown.slice(context.end)}`;
  if (type === "DIVIDER" || type === "TABLE") markdown = "";

  setRowType(row, type, { markdown });
  closeSlashMenu();
  await saveBlockRow(row);

  const nextTextarea = getBlockTextarea(row);
  if (nextTextarea) {
    autoGrowTextarea(nextTextarea);
    nextTextarea.focus();
    const cursor = context ? Math.min(context.start, nextTextarea.value.length) : nextTextarea.value.length;
    nextTextarea.selectionStart = nextTextarea.selectionEnd = cursor;
  } else {
    focusTableCell(row, 0, 0);
  }
}

async function persistBlockOrder(parentBlockId, orderedIds) {
  if (!state.selectedPage || !orderedIds.length) return;

  await api(`/api/pages/${state.selectedPage.id}/blocks/reorder`, {
    method: "POST",
    body: {
      items: orderedIds.map((id, index) => ({
        id,
        sortOrder: index,
        parentBlockId
      }))
    }
  });
}

async function createEmptyBlock(pageId, { parentBlockId = null, sortOrder } = {}) {
  return api(`/api/pages/${pageId}/blocks`, {
    method: "POST",
    body: {
      type: "MARKDOWN",
      markdown: "",
      parentBlockId,
      ...(sortOrder === undefined ? {} : { sortOrder })
    }
  });
}

async function insertBlockRelative(referenceRow, placement = "after") {
  if (!state.selectedPage || !referenceRow?.dataset.blockId) return;

  const parentBlockId = normalizeParentBlockId(referenceRow.dataset.parentBlockId);
  const siblingIds = getBlockSiblings(parentBlockId).map((block) => block.id);
  const referenceIndex = siblingIds.indexOf(referenceRow.dataset.blockId);
  if (referenceIndex < 0) throw new Error("현재 블록의 순서를 찾을 수 없습니다.");

  const insertionIndex = placement === "before" ? referenceIndex : referenceIndex + 1;
  const data = await createEmptyBlock(state.selectedPage.id, { parentBlockId, sortOrder: insertionIndex });
  const orderedIds = [...siblingIds];
  orderedIds.splice(insertionIndex, 0, data.block.id);
  await persistBlockOrder(parentBlockId, orderedIds);

  state.pendingFocusBlockId = data.block.id;
  await openPage(state.selectedPage.id);
  setStatus(`${placement === "before" ? "상단" : "하단"}에 새 블록을 만들었습니다. '/'를 입력해 타입을 선택하세요.`);
}

async function appendBlock(afterRow = null) {
  if (afterRow) return insertBlockRelative(afterRow, "after");
  if (!state.selectedPage) return;

  const siblingIds = getBlockSiblings(null).map((block) => block.id);
  const data = await createEmptyBlock(state.selectedPage.id, { sortOrder: siblingIds.length });
  await persistBlockOrder(null, [...siblingIds, data.block.id]);

  state.pendingFocusBlockId = data.block.id;
  await openPage(state.selectedPage.id);
  setStatus("새 블록을 만들었습니다. '/'를 입력해 타입을 선택하세요.");
}

async function deleteEmptyBlock(row) {
  if (!state.selectedPage || !row?.dataset.blockId || row.dataset.deleting === "true") return;

  const blockId = row.dataset.blockId;
  const block = getBlockById(blockId);
  const parentBlockId = normalizeParentBlockId(row.dataset.parentBlockId);
  const siblingIds = getBlockSiblings(parentBlockId).map((item) => item.id);
  const siblingIndex = siblingIds.indexOf(blockId);
  const childIds = (block?.children ?? []).map((child) => child.id);
  const rows = [...elements.blockList.querySelectorAll(".editor-block-row")];
  const rowIndex = rows.indexOf(row);
  const groupRows = getBlockGroupRows(row);
  const previousBlockId = rows[rowIndex - 1]?.dataset.blockId ?? null;
  const nextBlockId = rows[rowIndex + groupRows.length]?.dataset.blockId ?? null;
  let focusBlockId = previousBlockId ?? childIds[0] ?? nextBlockId;

  row.dataset.deleting = "true";
  clearTimeout(blockSaveTimers.get(blockId));
  blockSaveTimers.delete(blockId);
  closeSlashMenu();
  closeInlineToolbar();
  closeBlockContextMenu();

  const nextSiblingIds = [...siblingIds];
  if (siblingIndex >= 0) nextSiblingIds.splice(siblingIndex, 1, ...childIds);
  if (nextSiblingIds.length) await persistBlockOrder(parentBlockId, nextSiblingIds);

  await api(`/api/blocks/${blockId}`, { method: "DELETE" });

  if (!focusBlockId) {
    const starter = await createEmptyBlock(state.selectedPage.id);
    focusBlockId = starter.block.id;
  }

  state.pendingFocusBlockId = focusBlockId;
  await openPage(state.selectedPage.id);
  setStatus("빈 블록을 삭제했습니다.");
}

function focusPendingBlock() {
  if (!state.pendingFocusBlockId) return;
  const row = elements.blockList.querySelector(`[data-block-id="${state.pendingFocusBlockId}"]`);
  const textarea = getBlockTextarea(row);
  if (textarea) {
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  } else {
    row?.querySelector(".table-cell-input")?.focus();
  }
  state.pendingFocusBlockId = null;
}

function renderSelectedPage() {
  closeBlockContextMenu();
  const page = state.selectedPage;
  const hasPage = Boolean(page);

  elements.welcomeView.classList.toggle("hidden", hasPage);
  elements.pageView.classList.toggle("hidden", !hasPage);
  if (!page) return;

  const flatBlocks = flattenBlocks(page.blocks);
  elements.pageKicker.textContent = `${page.icon ?? "📄"} ${formatDate(page.updatedAt)}`;
  elements.pageTitle.value = page.title;
  elements.pageTags.value = page.tags?.map((tag) => tag.name).join(", ") ?? "";
  elements.blockCount.textContent = `${flatBlocks.length}개`;

  elements.blockList.replaceChildren();
  if (!flatBlocks.length) {
    const empty = makeEmptyMessage("편집할 첫 블록을 준비하고 있습니다.");
    empty.classList.add("block-empty-message");
    elements.blockList.append(empty);
  } else {
    for (const block of flatBlocks) elements.blockList.append(renderBlock(block));
  }

  renderPages();
  requestAnimationFrame(focusPendingBlock);
}

function normalizePageTitle(value) {
  const title = value.trim();
  return title || "새 문서";
}

function applyPageSummaryUpdate(pageId, updates) {
  const updateArray = (pages) => {
    for (const page of pages) {
      if (page.id === pageId) Object.assign(page, updates);
    }
  };

  if (state.selectedPage?.id === pageId) Object.assign(state.selectedPage, updates);
  updateArray(state.pages);
  updateArray(state.allPages);
  renderDocumentTree();
  renderHome();
}

async function savePageTitleNow({ quiet = true } = {}) {
  if (!state.selectedPage) return;
  const title = normalizePageTitle(elements.pageTitle.value);
  window.clearTimeout(pageTitleSaveTimer);
  pageTitleSaveTimer = null;

  try {
    const data = await api(`/api/pages/${state.selectedPage.id}`, { method: "PATCH", body: { title } });
    state.selectedPage = data.page;
    applyPageSummaryUpdate(data.page.id, { title: data.page.title, updatedAt: data.page.updatedAt });
    if (!quiet) setStatus("문서 제목을 저장했습니다.");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function schedulePageTitleSave() {
  if (!state.selectedPage) return;
  const title = normalizePageTitle(elements.pageTitle.value);
  applyPageSummaryUpdate(state.selectedPage.id, { title });
  window.clearTimeout(pageTitleSaveTimer);
  pageTitleSaveTimer = window.setTimeout(() => savePageTitleNow(), 650);
}

async function createUntitledPage() {
  setStatus("기본 컬렉션에 새 문서를 만드는 중입니다...");
  elements.searchInput.value = "";
  state.searchQuery = "";
  state.activeTag = "";

  const data = await api("/api/pages", {
    method: "POST",
    body: {
      title: "새 문서",
      icon: "📄"
    }
  });

  await loadPages("", "");
  await openPage(data.page.id);
  requestAnimationFrame(() => {
    elements.pageTitle.focus();
    elements.pageTitle.select();
  });
  setStatus("새 문서를 만들었습니다. 제목을 바로 수정하세요.");
}


async function loadMe() {
  if (!state.token) return;
  const data = await api("/api/auth/me");
  state.user = data.user;
}

async function loadAllPages() {
  const data = await api("/api/pages?limit=100");
  state.allPages = data.pages;
}

async function loadPages(query = state.searchQuery, tag = state.activeTag) {
  state.searchQuery = query;
  state.activeTag = tag;

  const params = new URLSearchParams({ limit: "100" });
  if (query) params.set("q", query);
  if (tag) params.set("tag", tag);

  const data = await api(`/api/pages?${params.toString()}`);
  state.pages = data.pages;

  if (!query && !tag) {
    state.allPages = data.pages;
  } else {
    await loadAllPages();
  }

  renderPages();
}

async function openPage(pageId) {
  setStatus("문서를 불러오는 중입니다...");
  let data = await api(`/api/pages/${pageId}`);

  if (!flattenBlocks(data.page.blocks).length) {
    const starter = await createEmptyBlock(pageId);
    state.pendingFocusBlockId = starter.block.id;
    data = await api(`/api/pages/${pageId}`);
  }

  state.selectedPage = data.page;
  renderSelectedPage();
  setStatus("문서를 열었습니다.");
}

async function boot() {
  setAuthMode(state.authMode, false);

  try {
    await loadMe();
    renderShell();
    if (state.user) await loadPages();
    setStatus(state.user ? "준비되었습니다." : "로그인하거나 회원가입해서 시작하세요.");
  } catch (error) {
    setToken(null);
    state.user = null;
    renderShell();
    setStatus("로그인이 필요합니다.");
  }
}

elements.authSwitchLink.addEventListener("click", (event) => {
  event.preventDefault();
  setAuthMode(state.authMode === "register" ? "login" : "register");
  setStatus(state.authMode === "register" ? "회원가입 정보를 입력하세요." : "아이디와 비밀번호로 로그인하세요.");
  elements.username.focus();
});

window.addEventListener("hashchange", () => {
  setAuthMode(window.location.hash === "#signup" ? "register" : "login", false);
});

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = state.authMode;
  const body = {
    username: elements.username.value.trim(),
    password: elements.password.value
  };
  if (mode === "register" && elements.name.value.trim()) body.name = elements.name.value.trim();

  try {
    setStatus(mode === "login" ? "로그인 중입니다..." : "회원가입 중입니다...");
    const data = await api(`/api/auth/${mode}`, { method: "POST", body });
    setToken(data.token);
    state.user = data.user;
    renderShell();
    await loadPages();
    setStatus(`${state.user.username} ID로 시작합니다.`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.logoutButton.addEventListener("click", () => {
  setToken(null);
  state.user = null;
  state.pages = [];
  state.allPages = [];
  state.selectedPage = null;
  state.activeTag = "";
  state.searchQuery = "";
  renderShell();
  renderPages();
  renderSelectedPage();
  setStatus("로그아웃했습니다.");
});



elements.homeNewPageButton.addEventListener("click", async () => {
  try {
    await createUntitledPage();
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await loadPages(elements.searchInput.value.trim(), state.activeTag);
    setStatus("검색 결과를 불러왔습니다.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.defaultCollectionButton.addEventListener("click", async () => {
  try {
    elements.searchInput.value = "";
    state.selectedPage = null;
    await loadPages("", "");
    renderSelectedPage();
    setStatus("기본 컬렉션을 열었습니다.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.addDocumentButton.addEventListener("click", async () => {
  try {
    await createUntitledPage();
  } catch (error) {
    setStatus(error.message, true);
  }
});


elements.pageList.addEventListener("click", async (event) => {
  const item = event.target.closest(".document-item");
  if (!item) return;
  try {
    await openPage(item.dataset.pageId);
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.homeDocumentList.addEventListener("click", async (event) => {
  const item = event.target.closest(".home-document-item");
  if (!item) return;
  try {
    await openPage(item.dataset.pageId);
  } catch (error) {
    setStatus(error.message, true);
  }
});


elements.pageTitle.addEventListener("input", () => {
  schedulePageTitleSave();
});

elements.pageTitle.addEventListener("blur", () => {
  if (!state.selectedPage) return;
  if (!elements.pageTitle.value.trim()) elements.pageTitle.value = "새 문서";
  savePageTitleNow().catch((error) => setStatus(error.message, true));
});

elements.savePageButton.addEventListener("click", async () => {
  if (!state.selectedPage) return;
  window.clearTimeout(pageTitleSaveTimer);
  pageTitleSaveTimer = null;
  try {
    const body = {
      title: normalizePageTitle(elements.pageTitle.value),
      tags: tagsFromInput(elements.pageTags.value)
    };
    const data = await api(`/api/pages/${state.selectedPage.id}`, { method: "PATCH", body });
    state.selectedPage = data.page;
    await loadPages(elements.searchInput.value.trim(), state.activeTag);
    renderSelectedPage();
    setStatus("페이지를 저장했습니다.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.archivePageButton.addEventListener("click", async () => {
  if (!state.selectedPage) return;
  const ok = window.confirm("이 문서를 보관할까요? 목록에서 숨겨집니다.");
  if (!ok) return;
  try {
    await api(`/api/pages/${state.selectedPage.id}`, { method: "PATCH", body: { isArchived: true } });
    state.selectedPage = null;
    await loadPages(elements.searchInput.value.trim(), state.activeTag);
    renderSelectedPage();
    setStatus("문서를 보관했습니다.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.blockList.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".block-handle");
  if (!handle || activeBlockDrag || blockOrderSaving || event.isPrimary === false) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  const row = getBlockRow(handle);
  if (!row?.dataset.blockId) return;

  activeBlockDrag = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    handle,
    row,
    parentBlockId: normalizeParentBlockId(row.dataset.parentBlockId),
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    initialIndex: -1,
    targetIndex: -1,
    siblingRows: [],
    candidates: [],
    groupRows: [],
    indicator: null
  };

  handle.classList.add("is-pressed");
  handle.setPointerCapture?.(event.pointerId);
});

elements.blockList.addEventListener("pointermove", (event) => {
  updateBlockDrag(event);
});

elements.blockList.addEventListener("pointerup", (event) => {
  finishBlockDrag(event).catch((error) => setStatus(error.message, true));
});

elements.blockList.addEventListener("pointercancel", (event) => {
  finishBlockDrag(event, { cancelled: true }).catch((error) => setStatus(error.message, true));
});

elements.blockList.addEventListener("lostpointercapture", (event) => {
  if (!activeBlockDrag || activeBlockDrag.pointerId !== event.pointerId) return;
  finishBlockDrag(event, { cancelled: true }).catch((error) => setStatus(error.message, true));
});

elements.blockList.addEventListener("beforeinput", (event) => {
  const textarea = event.target.closest('textarea[name="markdown"]');
  if (!textarea || event.inputType !== "deleteContentBackward" || event.isComposing) return;
  if (textarea.value.trim()) return;

  const row = getBlockRow(textarea);
  if (!row || row.dataset.deleting === "true") return;

  event.preventDefault();
  deleteEmptyBlock(row).catch((error) => {
    row.dataset.deleting = "false";
    setStatus(error.message, true);
  });
});

elements.blockList.addEventListener("input", (event) => {
  const tableCell = event.target.closest(".table-cell-input");
  if (tableCell) {
    const row = getBlockRow(tableCell);
    if (row) scheduleBlockSave(row);
    return;
  }

  const textarea = event.target.closest('textarea[name="markdown"]');
  if (!textarea) return;
  autoGrowTextarea(textarea);
  updateSlashMenuForTextarea(textarea);
  if (elements.slashMenu.classList.contains("hidden")) updateInlineToolbarForTextarea(textarea);
  const row = getBlockRow(textarea);
  if (row) scheduleBlockSave(row);
});

elements.blockList.addEventListener("focusin", (event) => {
  const tableCell = event.target.closest(".table-cell-input");
  if (!tableCell) return;
  const row = getBlockRow(tableCell);
  if (!row) return;
  row.dataset.tableActiveRow = tableCell.dataset.tableRow ?? "0";
  row.dataset.tableActiveColumn = tableCell.dataset.tableColumn ?? "0";
});

elements.blockList.addEventListener("mouseup", (event) => {
  const textarea = event.target.closest('textarea[name="markdown"]');
  if (!textarea) return;
  window.setTimeout(() => updateInlineToolbarForTextarea(textarea));
});

elements.blockList.addEventListener("keyup", (event) => {
  const textarea = event.target.closest('textarea[name="markdown"]');
  if (!textarea) return;
  if (event.key === "Escape") return closeInlineToolbar();
  window.setTimeout(() => updateInlineToolbarForTextarea(textarea));
});

elements.blockList.addEventListener("change", (event) => {
  const checkbox = event.target.closest('input[name="checked"]');
  if (!checkbox) return;
  const row = getBlockRow(checkbox);
  if (row) saveBlockRow(row).catch((error) => setStatus(error.message, true));
});

elements.blockList.addEventListener("keydown", async (event) => {
  const tableCell = event.target.closest(".table-cell-input");
  if (tableCell) {
    const tableRow = getBlockRow(tableCell);
    if (tableRow) handleTableCellKeydown(event, tableCell, tableRow);
    return;
  }

  const textarea = event.target.closest('textarea[name="markdown"]');
  if (!textarea) return;
  const row = getBlockRow(textarea);
  if (!row) return;

  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing) {
    const shortcut = event.key.toLowerCase();
    if (shortcut === "b" || shortcut === "i") {
      event.preventDefault();
      state.activeInlineBlockId = row.dataset.blockId;
      state.activeInlineSelection = getTextareaSelection(textarea);
      applyInlineFormat(shortcut === "b" ? "bold" : "italic");
      return;
    }
  }

  if (!elements.slashMenu.classList.contains("hidden") && state.activeSlashBlockId === row.dataset.blockId) {
    const items = [...elements.slashMenu.querySelectorAll(".slash-menu-item")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) {
        state.activeSlashIndex =
          event.key === "ArrowDown"
            ? (state.activeSlashIndex + 1) % items.length
            : (state.activeSlashIndex - 1 + items.length) % items.length;
        renderSlashMenu(row, getSlashContext(textarea)?.query ?? "");
      }
      return;
    }

    if (event.key === "Enter" && items.length && !event.isComposing) {
      event.preventDefault();
      await applySlashCommand(row, items[state.activeSlashIndex].dataset.type);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeSlashMenu();
      return;
    }
  }

  if (event.key === "Backspace" && !event.isComposing && !event.repeat && !textarea.value.trim()) {
    event.preventDefault();
    try {
      await deleteEmptyBlock(row);
    } catch (error) {
      row.dataset.deleting = "false";
      setStatus(error.message, true);
    }
    return;
  }

  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    try {
      await saveBlockRow(row, { quiet: true });
      await appendBlock(row);
    } catch (error) {
      setStatus(error.message, true);
    }
  }
});

elements.blockList.addEventListener("focusout", (event) => {
  const tableCell = event.target.closest(".table-cell-input");
  if (tableCell) {
    const row = getBlockRow(tableCell);
    if (row && !row.contains(event.relatedTarget) && row.dataset.deleting !== "true") {
      saveBlockRow(row, { quiet: true }).catch((error) => setStatus(error.message, true));
    }
    return;
  }

  const textarea = event.target.closest('textarea[name="markdown"]');
  if (!textarea) return;
  const row = getBlockRow(textarea);
  if (row && row.dataset.deleting !== "true") {
    saveBlockRow(row, { quiet: true }).catch((error) => setStatus(error.message, true));
  }
  window.setTimeout(() => {
    if (!elements.slashMenu.matches(":hover")) closeSlashMenu();
    if (!elements.inlineToolbar.matches(":hover")) closeInlineToolbar();
  }, 120);
});

elements.blockList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || !state.selectedPage) return;
  if (button.classList.contains("block-handle") && Date.now() < suppressBlockHandleClickUntil) {
    event.preventDefault();
    return;
  }
  const row = getBlockRow(button);
  const blockId = row?.dataset.blockId;
  if (!row || !blockId) return;

  try {
    if (button.dataset.action.startsWith("table-")) {
      handleTableAction(row, button.dataset.action);
      return;
    }

    if (button.dataset.action === "open-block-menu") {
      openBlockContextMenu(row, button, { focusFirst: event.detail === 0 });
      return;
    }

    if (button.dataset.action === "open-slash-menu") {
      state.activeSlashIndex = 0;
      renderSlashMenu(row);
      getBlockTextarea(row)?.focus();
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});


elements.blockContextMenu.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  const blockId = state.activeBlockMenuId;
  if (!button || !blockId || !state.selectedPage) return;

  const row = elements.blockList.querySelector(`[data-block-id="${blockId}"]`);
  if (!row) return closeBlockContextMenu();

  try {
    if (button.dataset.action === "change-callout-type") {
      await changeCalloutType(row, button.dataset.calloutType);
      return;
    }

    if (button.dataset.action === "insert-block-before" || button.dataset.action === "insert-block-after") {
      const placement = button.dataset.action === "insert-block-before" ? "before" : "after";
      closeBlockContextMenu();
      await saveBlockRow(row, { quiet: true });
      await insertBlockRelative(row, placement);
      return;
    }

    if (button.dataset.action === "save-block") {
      closeBlockContextMenu({ restoreFocus: true });
      await saveBlockRow(row);
      return;
    }

    if (button.dataset.action === "delete-block") {
      const ok = window.confirm("이 블록을 삭제할까요?");
      if (!ok) return;
      closeBlockContextMenu();
      await api(`/api/blocks/${blockId}`, { method: "DELETE" });
      await openPage(state.selectedPage.id);
      setStatus("블록을 삭제했습니다.");
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.blockContextMenu.addEventListener("keydown", (event) => {
  const items = getBlockContextMenuItems();
  const currentIndex = items.indexOf(document.activeElement);

  if (event.key === "Escape") {
    event.preventDefault();
    closeBlockContextMenu({ restoreFocus: true });
    return;
  }

  if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();

  let nextIndex = currentIndex;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = items.length - 1;
  else if (event.key === "ArrowDown") nextIndex = (currentIndex + 1 + items.length) % items.length;
  else nextIndex = (currentIndex - 1 + items.length) % items.length;

  items[nextIndex].focus();
});

elements.slashMenu.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

elements.slashMenu.addEventListener("click", async (event) => {
  const item = event.target.closest(".slash-menu-item");
  if (!item || !state.activeSlashBlockId) return;
  const row = elements.blockList.querySelector(`[data-block-id="${state.activeSlashBlockId}"]`);
  if (!row) return;
  try {
    await applySlashCommand(row, item.dataset.type);
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.inlineToolbar.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

elements.inlineToolbar.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-format]");
  if (!button) return;
  applyInlineFormat(button.dataset.format, button.dataset.color ?? "");
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#block-context-menu") && !event.target.closest(".block-handle")) {
    closeBlockContextMenu();
  }

  if (event.target.closest("#slash-menu") || event.target.closest("#inline-toolbar") || event.target.closest(".editor-block-row")) return;
  closeSlashMenu();
  closeInlineToolbar();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || elements.blockContextMenu.classList.contains("hidden")) return;
  event.preventDefault();
  closeBlockContextMenu({ restoreFocus: true });
});

window.addEventListener("resize", () => {
  closeSlashMenu();
  closeInlineToolbar();
  closeBlockContextMenu();
});

window.addEventListener("scroll", () => closeBlockContextMenu(), { passive: true });

boot();
