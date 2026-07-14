import {
  applyDocumentTranslations,
  formatNumber,
  getLanguage,
  getLanguageLabel,
  getLocale,
  populateLanguageSelect,
  setLanguage,
  t
} from "./i18n.js";

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
  MARKDOWN: "blocks.types.MARKDOWN",
  HEADING_1: "blocks.types.HEADING_1",
  HEADING_2: "blocks.types.HEADING_2",
  HEADING_3: "blocks.types.HEADING_3",
  TODO: "blocks.types.TODO",
  QUOTE: "blocks.types.QUOTE",
  CALLOUT: "blocks.types.CALLOUT",
  TABLE: "blocks.types.TABLE",
  KANBAN: "blocks.types.KANBAN",
  CODE: "blocks.types.CODE",
  DIVIDER: "blocks.types.DIVIDER",
  IMAGE: "blocks.types.IMAGE",
  ATTACHMENT: "blocks.types.ATTACHMENT"
};

const calloutTypePresets = [
  { id: "idea", icon: "💡" },
  { id: "info", icon: "ℹ️" },
  { id: "success", icon: "✅" },
  { id: "warning", icon: "⚠️" },
  { id: "danger", icon: "⛔" }
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

const kanbanLimits = {
  columns: 12,
  cardsPerColumn: 50,
  boardTitleLength: 120,
  columnTitleLength: 80,
  cardTitleLength: 160,
  cardDescriptionLength: 1000,
  cardIconLength: 24,
  tagsPerCard: 8,
  tagLength: 40
};
const kanbanColumnColors = ["gray", "blue", "purple", "green", "yellow", "red"];
const kanbanCardColors = ["default", "pink", "yellow", "blue", "green", "purple", "peach"];
const kanbanCardColorTranslationKeys = {
  default: "kanban.cardColorDefault",
  pink: "kanban.cardColorPink",
  yellow: "kanban.cardColorYellow",
  blue: "kanban.cardColorBlue",
  green: "kanban.cardColorGreen",
  purple: "kanban.cardColorPurple",
  peach: "kanban.cardColorPeach"
};
const kanbanEmojiPresets = ["📝", "✅", "🚀", "💡", "🎯", "⭐", "🔥", "📌", "🧠", "🎨", "🛠️", "🔍", "📣", "💬", "📦", "🐛", "🌱", "🎉"];

function createClientId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 64);
}

function createDefaultKanbanData() {
  return {
    title: t("kanban.defaultTitle"),
    columns: [
      { id: createClientId("col"), title: t("kanban.defaultTodo"), color: "gray", cards: [] },
      { id: createClientId("col"), title: t("kanban.defaultInProgress"), color: "blue", cards: [] },
      { id: createClientId("col"), title: t("kanban.defaultDone"), color: "green", cards: [] }
    ]
  };
}

function normalizeKanbanText(value, fallback, maxLength) {
  return (typeof value === "string" ? value : fallback).slice(0, maxLength);
}

function normalizeKanbanTags(value) {
  const tags = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(tags
    .map((tag) => normalizeKanbanText(tag, "", kanbanLimits.tagLength).trim())
    .filter(Boolean))]
    .slice(0, kanbanLimits.tagsPerCard);
}

function normalizeKanbanIcon(value) {
  return normalizeKanbanText(value, "", kanbanLimits.cardIconLength)
    .replace(/[\r\n\t]/g, "")
    .trim();
}

function normalizeKanbanCardColor(value) {
  return kanbanCardColors.includes(value) ? value : "default";
}

function normalizeKanbanData(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceColumns = Array.isArray(source.columns) ? source.columns.slice(0, kanbanLimits.columns) : [];
  const seenColumnIds = new Set();
  const seenCardIds = new Set();

  const columns = sourceColumns
    .filter((column) => column && typeof column === "object" && !Array.isArray(column))
    .map((column, columnIndex) => {
      let columnId = normalizeKanbanText(column.id, createClientId("col"), 64).trim() || createClientId("col");
      while (seenColumnIds.has(columnId)) columnId = createClientId("col");
      seenColumnIds.add(columnId);

      const sourceCards = Array.isArray(column.cards) ? column.cards.slice(0, kanbanLimits.cardsPerColumn) : [];
      const cards = sourceCards
        .filter((card) => card && typeof card === "object" && !Array.isArray(card))
        .map((card) => {
          let cardId = normalizeKanbanText(card.id, createClientId("card"), 64).trim() || createClientId("card");
          while (seenCardIds.has(cardId)) cardId = createClientId("card");
          seenCardIds.add(cardId);
          return {
            id: cardId,
            title: normalizeKanbanText(card.title, "", kanbanLimits.cardTitleLength),
            description: normalizeKanbanText(card.description, "", kanbanLimits.cardDescriptionLength),
            icon: normalizeKanbanIcon(card.icon),
            color: normalizeKanbanCardColor(card.color),
            tags: normalizeKanbanTags(card.tags)
          };
        });

      return {
        id: columnId,
        title: normalizeKanbanText(column.title, t("kanban.untitledColumn"), kanbanLimits.columnTitleLength),
        color: kanbanColumnColors.includes(column.color)
          ? column.color
          : kanbanColumnColors[columnIndex % kanbanColumnColors.length],
        cards
      };
    });

  const fallback = createDefaultKanbanData();
  return {
    title: normalizeKanbanText(source.title, fallback.title, kanbanLimits.boardTitleLength),
    columns: columns.length ? columns : fallback.columns
  };
}

const slashCommands = [
  { type: "MARKDOWN", command: "/text", icon: "text" },
  { type: "HEADING_1", command: "/h1", icon: "heading-1" },
  { type: "HEADING_2", command: "/h2", icon: "heading-2" },
  { type: "HEADING_3", command: "/h3", icon: "heading-3" },
  { type: "TODO", command: "/todo", icon: "todo" },
  { type: "QUOTE", command: "/quote", icon: "quote" },
  { type: "CALLOUT", command: "/callout", icon: "callout" },
  { type: "TABLE", command: "/table", icon: "table" },
  { type: "KANBAN", command: "/board", icon: "kanban" },
  { type: "CODE", command: "/code", icon: "code" },
  { type: "DIVIDER", command: "/divider", icon: "divider" },
  { type: "IMAGE", command: "/image", icon: "image" },
  { type: "ATTACHMENT", command: "/file", icon: "attachment" }
];

const svgNamespace = "http://www.w3.org/2000/svg";
const slashCommandIconShapes = {
  text: [
    ["path", { d: "M4 6h16" }],
    ["path", { d: "M4 12h12" }],
    ["path", { d: "M4 18h8" }]
  ],
  "heading-1": [
    ["path", { d: "M4 12h8" }],
    ["path", { d: "M4 18V6" }],
    ["path", { d: "M12 18V6" }],
    ["path", { d: "m17 12 3-2v8" }]
  ],
  "heading-2": [
    ["path", { d: "M4 12h8" }],
    ["path", { d: "M4 18V6" }],
    ["path", { d: "M12 18V6" }],
    ["path", { d: "M17 11c.5-1 1.25-1.5 2.25-1.5 1.1 0 1.75.7 1.75 1.6 0 2.4-4 2.6-4 6.4h4" }]
  ],
  "heading-3": [
    ["path", { d: "M4 12h8" }],
    ["path", { d: "M4 18V6" }],
    ["path", { d: "M12 18V6" }],
    ["path", { d: "M17 10c.45-.35 1.05-.5 1.75-.5 1.35 0 2.25.65 2.25 1.65 0 .95-.8 1.6-2.1 1.6" }],
    ["path", { d: "M18.9 12.75c1.45 0 2.35.65 2.35 1.75 0 1.2-1.05 2-2.65 2-.75 0-1.4-.2-1.9-.6" }]
  ],
  todo: [
    ["path", { d: "m9 11 3 3L22 4" }],
    ["path", { d: "M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" }]
  ],
  quote: [
    ["path", { d: "M3 21c3 0 7-1 7-8V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h3c0 4-2 6-5 8Z" }],
    ["path", { d: "M14 21c3 0 7-1 7-8V5c0-1.1-.9-2-2-2h-3c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h3c0 4-2 6-5 8Z" }]
  ],
  callout: [
    ["path", { d: "M9 18h6" }],
    ["path", { d: "M10 22h4" }],
    ["path", { d: "M15.1 14c.2-.6.6-1.1 1.1-1.6A6 6 0 1 0 7.8 12.4c.5.5.9 1 1.1 1.6.2.5.2 1.2.2 2h6c0-.8 0-1.5.2-2Z" }]
  ],
  table: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M3 9h18" }],
    ["path", { d: "M9 3v18" }]
  ],
  kanban: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M9 3v18" }],
    ["path", { d: "M15 3v18" }],
    ["path", { d: "M5.5 7h1" }],
    ["path", { d: "M11.5 7h1" }],
    ["path", { d: "M17.5 7h1" }]
  ],
  code: [
    ["path", { d: "m18 16 4-4-4-4" }],
    ["path", { d: "m6 8-4 4 4 4" }],
    ["path", { d: "m14.5 4-5 16" }]
  ],
  divider: [["path", { d: "M3 12h18" }]],
  image: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["circle", { cx: "9", cy: "9", r: "2" }],
    ["path", { d: "m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" }]
  ],
  attachment: [
    ["path", { d: "m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.4 9.4a2 2 0 0 1-2.8-2.8l8.8-8.8" }]
  ]
};

function createSlashCommandIcon(iconName) {
  const icon = document.createElement("span");
  icon.className = "slash-menu-icon";
  icon.setAttribute("aria-hidden", "true");

  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const shapes = slashCommandIconShapes[iconName] ?? slashCommandIconShapes.text;
  shapes.forEach(([tagName, attributes]) => {
    const shape = document.createElementNS(svgNamespace, tagName);
    Object.entries(attributes).forEach(([name, value]) => shape.setAttribute(name, value));
    svg.append(shape);
  });

  icon.append(svg);
  return icon;
}

const blockSaveTimers = new Map();
let pageTitleSaveTimer = null;
let activeBlockDrag = null;
let activeKanbanCardDrag = null;
let suppressBlockHandleClickUntil = 0;
let blockOrderSaving = false;

const $ = (selector) => document.querySelector(selector);

const elements = {
  languageSelect: $("#language-select"),
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

  elements.authKicker.textContent = t(isRegister ? "auth.registerKicker" : "auth.loginKicker");
  elements.authTitle.textContent = t(isRegister ? "auth.registerTitle" : "auth.loginTitle");
  elements.authDescription.textContent = isRegister
    ? t("auth.registerDescription")
    : t("auth.loginDescription");
  elements.authSubmit.dataset.authMode = state.authMode;
  elements.authSubmit.textContent = t(isRegister ? "auth.register" : "auth.login");
  elements.authSwitchCopy.textContent = t(isRegister ? "auth.registerSwitch" : "auth.loginSwitch");
  elements.authSwitchLink.textContent = t(isRegister ? "auth.login" : "auth.register");
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
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function translateApiError(data, status) {
  const code = data?.error?.code;
  if (code && t(`errors.${code}`) !== `errors.${code}`) return t(`errors.${code}`);
  if (status >= 500) return t("errors.INTERNAL_SERVER_ERROR");
  return data?.error?.message ?? data?.message ?? t("errors.unknown");
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);

  let body = options.body;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, { ...options, headers, body });
  } catch {
    throw new Error(t("errors.network"));
  }
  if (response.status === 204) return null;

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(t("errors.invalidResponse"));
  }

  if (!response.ok) {
    if (response.status === 401) {
      setToken(null);
      state.user = null;
      renderShell();
    }
    throw new Error(translateApiError(data, response.status));
  }

  return data;
}

async function downloadAttachment(block) {
  const attachment = getBlockAttachmentData(block);
  const headers = new Headers();
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);

  let response;
  try {
    response = await fetch(`/api/blocks/${block.id}/attachment`, { headers });
  } catch {
    throw new Error(t("errors.network"));
  }

  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      // Use the localized fallback below when the response is not JSON.
    }
    if (response.status === 401) {
      setToken(null);
      state.user = null;
      renderShell();
    }
    throw new Error(translateApiError(data, response.status));
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = attachment.originalName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
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
    .sort((a, b) => a.name.localeCompare(b.name, getLocale()));
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
      ? t("empty.noSearchResults")
      : t("empty.noDocumentsSidebar");
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
  elements.homeDocumentCount.textContent = t("counts.documents", { count: formatNumber(state.allPages.length) });
  elements.homeDocumentList.replaceChildren();
  elements.homeCollectionList.replaceChildren();

  if (!state.allPages.length) {
    elements.homeDocumentList.append(makeEmptyMessage(t("empty.noDocumentsHome")));
  } else {
    for (const page of sortByRecent(state.allPages).slice(0, 8)) {
      elements.homeDocumentList.append(makeHomeDocumentButton(page));
    }
  }

  elements.homeCollectionList.append(
    makeHomeGuideRow(t("home.guide1Title"), t("home.guide1Description")),
    makeHomeGuideRow(t("home.guide2Title"), t("home.guide2Description")),
    makeHomeGuideRow(t("home.guide3Title"), t("home.guide3Description"))
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
  return blockTypeLabels[type] ? t(blockTypeLabels[type]) : type;
}

function getCalloutTypeLabel(type) {
  const normalized = normalizeCalloutType(type);
  return t(`callouts.${normalized}`);
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

function getBlockAttachmentData(block) {
  const source = block?.metadata?.attachment;
  const attachment = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  const size = Number.isFinite(attachment.size) && attachment.size >= 0 ? attachment.size : 0;
  return {
    originalName: typeof attachment.originalName === "string" && attachment.originalName.trim()
      ? attachment.originalName
      : block?.markdown || t("attachment.unnamed"),
    mimeType: typeof attachment.mimeType === "string" && attachment.mimeType.trim()
      ? attachment.mimeType
      : "application/octet-stream",
    size
  };
}

function formatAttachmentSize(size) {
  const bytes = Number.isFinite(size) && size > 0 ? size : 0;
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value)} ${units[unitIndex]}`;
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


function getBlockKanbanData(block) {
  return normalizeKanbanData(block?.metadata?.kanban);
}

function makeKanbanActionButton(action, label, title, data = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kanban-action-button";
  button.dataset.action = action;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  Object.entries(data).forEach(([key, value]) => {
    if (value !== undefined && value !== null) button.dataset[key] = String(value);
  });
  return button;
}

function closeKanbanCardStyleMenus(except = null) {
  elements.blockList?.querySelectorAll(".kanban-card-style-menu[open]").forEach((details) => {
    if (details === except) return;
    details.removeAttribute("open");
    details.closest(".kanban-card")?.classList.remove("is-style-menu-open");
  });
}

function positionKanbanCardStylePanel(details) {
  const summary = details?.querySelector(":scope > summary");
  const panel = details?.querySelector(".kanban-card-style-panel");
  const card = details?.closest(".kanban-card");
  if (!summary || !panel || !details.open) {
    card?.classList.remove("is-style-menu-open");
    return;
  }
  card?.classList.add("is-style-menu-open");

  const margin = 8;
  const gap = 6;
  const anchor = summary.getBoundingClientRect();
  const width = Math.min(234, Math.max(180, window.innerWidth - margin * 2));
  panel.style.width = `${width}px`;

  let left = Math.min(Math.max(margin, anchor.left - 24), window.innerWidth - width - margin);
  let top = anchor.bottom + gap;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;

  const panelHeight = panel.getBoundingClientRect().height;
  if (top + panelHeight > window.innerHeight - margin) {
    top = Math.max(margin, anchor.top - panelHeight - gap);
    panel.style.top = `${top}px`;
  }
}

function createKanbanCardStyleMenu(card) {
  const details = document.createElement("details");
  details.className = "kanban-card-style-menu";

  const summary = document.createElement("summary");
  summary.className = "kanban-card-icon-button";
  summary.title = t("kanban.customizeCard");
  summary.setAttribute("aria-label", t("kanban.customizeCard"));

  const preview = document.createElement("span");
  preview.className = "kanban-card-icon-preview";
  preview.textContent = card.icon || "＋";
  preview.setAttribute("aria-hidden", "true");
  summary.append(preview);

  const panel = document.createElement("div");
  panel.className = "kanban-card-style-panel";

  const emojiLabel = document.createElement("strong");
  emojiLabel.className = "kanban-card-style-label";
  emojiLabel.textContent = t("kanban.emojiLabel");

  const emojiGrid = document.createElement("div");
  emojiGrid.className = "kanban-emoji-grid";
  emojiGrid.setAttribute("role", "group");
  emojiGrid.setAttribute("aria-label", t("kanban.emojiLabel"));

  const removeEmoji = makeKanbanActionButton(
    "kanban-set-card-emoji",
    "∅",
    t("kanban.removeEmoji"),
    { cardId: card.id, emoji: "" }
  );
  removeEmoji.classList.add("kanban-emoji-option", "kanban-emoji-remove");
  removeEmoji.setAttribute("aria-pressed", String(!card.icon));
  emojiGrid.append(removeEmoji);

  kanbanEmojiPresets.forEach((emoji) => {
    const option = makeKanbanActionButton(
      "kanban-set-card-emoji",
      emoji,
      t("kanban.useEmoji", { emoji }),
      { cardId: card.id, emoji }
    );
    option.classList.add("kanban-emoji-option");
    option.setAttribute("aria-pressed", String(card.icon === emoji));
    emojiGrid.append(option);
  });

  const customEmoji = document.createElement("input");
  customEmoji.type = "text";
  customEmoji.className = "kanban-card-emoji-input";
  customEmoji.value = card.icon;
  customEmoji.maxLength = kanbanLimits.cardIconLength;
  customEmoji.placeholder = t("kanban.customEmojiPlaceholder");
  customEmoji.dataset.cardId = card.id;
  customEmoji.setAttribute("aria-label", t("kanban.customEmojiAria"));
  customEmoji.autocomplete = "off";

  const colorLabel = document.createElement("strong");
  colorLabel.className = "kanban-card-style-label";
  colorLabel.textContent = t("kanban.cardColorLabel");

  const colorGrid = document.createElement("div");
  colorGrid.className = "kanban-card-color-grid";
  colorGrid.setAttribute("role", "group");
  colorGrid.setAttribute("aria-label", t("kanban.cardColorLabel"));

  kanbanCardColors.forEach((color) => {
    const label = t(kanbanCardColorTranslationKeys[color]);
    const option = makeKanbanActionButton(
      "kanban-set-card-color",
      "",
      t("kanban.useCardColor", { color: label }),
      { cardId: card.id, color }
    );
    option.classList.add("kanban-card-color-option");
    option.dataset.color = color;
    option.setAttribute("aria-pressed", String(card.color === color));
    colorGrid.append(option);
  });

  panel.append(emojiLabel, emojiGrid, customEmoji, colorLabel, colorGrid);
  details.append(summary, panel);
  return details;
}

function createKanbanEditor(row, boardValue) {
  const boardData = normalizeKanbanData(boardValue);
  const editor = document.createElement("div");
  editor.className = "kanban-block-editor";

  const toolbar = document.createElement("div");
  toolbar.className = "kanban-toolbar";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "kanban-title-input";
  titleInput.value = boardData.title;
  titleInput.maxLength = kanbanLimits.boardTitleLength;
  titleInput.placeholder = t("kanban.boardTitlePlaceholder");
  titleInput.setAttribute("aria-label", t("kanban.boardTitleAria"));

  const summary = document.createElement("span");
  summary.className = "kanban-summary";
  const totalCards = boardData.columns.reduce((total, column) => total + column.cards.length, 0);
  summary.textContent = t("kanban.summary", {
    columns: formatNumber(boardData.columns.length),
    cards: formatNumber(totalCards)
  });

  const addColumn = makeKanbanActionButton(
    "kanban-add-column",
    `＋ ${t("kanban.addColumn")}`,
    t("kanban.addColumn"),
  );
  addColumn.classList.add("kanban-add-column");
  addColumn.disabled = boardData.columns.length >= kanbanLimits.columns;

  toolbar.append(titleInput, summary, addColumn);

  const scroller = document.createElement("div");
  scroller.className = "kanban-board-scroll";

  const board = document.createElement("div");
  board.className = "kanban-board";
  board.setAttribute("role", "group");
  board.setAttribute("aria-label", t("kanban.boardAria"));

  boardData.columns.forEach((column, columnIndex) => {
    const columnElement = document.createElement("section");
    columnElement.className = "kanban-column";
    columnElement.dataset.columnId = column.id;
    columnElement.dataset.columnColor = column.color;
    columnElement.style.setProperty("--kanban-column-index", String(columnIndex));

    const columnHeader = document.createElement("header");
    columnHeader.className = "kanban-column-header";

    const colorButton = makeKanbanActionButton(
      "kanban-cycle-color",
      "",
      t("kanban.changeColor"),
      { columnId: column.id }
    );
    colorButton.classList.add("kanban-column-color");
    colorButton.dataset.color = column.color;
    colorButton.setAttribute("aria-label", t("kanban.changeColor"));

    const columnTitle = document.createElement("input");
    columnTitle.type = "text";
    columnTitle.className = "kanban-column-title";
    columnTitle.value = column.title;
    columnTitle.maxLength = kanbanLimits.columnTitleLength;
    columnTitle.placeholder = t("kanban.columnTitlePlaceholder");
    columnTitle.dataset.columnId = column.id;
    columnTitle.setAttribute("aria-label", t("kanban.columnTitleAria"));

    const count = document.createElement("span");
    count.className = "kanban-column-count";
    count.textContent = formatNumber(column.cards.length);
    count.setAttribute("aria-label", t("kanban.cardCount", { count: formatNumber(column.cards.length) }));

    const deleteColumn = makeKanbanActionButton(
      "kanban-delete-column",
      "•••",
      t("kanban.deleteColumn"),
      { columnId: column.id }
    );
    deleteColumn.classList.add("kanban-column-menu");
    deleteColumn.disabled = boardData.columns.length <= 1;

    columnHeader.append(colorButton, columnTitle, count, deleteColumn);

    const cardList = document.createElement("div");
    cardList.className = "kanban-card-list";
    cardList.dataset.columnId = column.id;
    cardList.setAttribute("role", "list");
    cardList.setAttribute("aria-label", t("kanban.columnCardsAria", { column: column.title || t("kanban.untitledColumn") }));

    if (!column.cards.length) {
      const empty = document.createElement("p");
      empty.className = "kanban-empty-column";
      empty.textContent = t("kanban.emptyColumn");
      cardList.append(empty);
    }

    column.cards.forEach((card, cardIndex) => {
      const cardElement = document.createElement("article");
      cardElement.className = "kanban-card";
      cardElement.dataset.cardId = card.id;
      cardElement.dataset.columnId = column.id;
      cardElement.dataset.cardColor = card.color;
      cardElement.setAttribute("role", "listitem");

      const cardTop = document.createElement("div");
      cardTop.className = "kanban-card-top";

      const dragHandle = document.createElement("span");
      dragHandle.className = "kanban-card-drag-handle";
      dragHandle.draggable = true;
      dragHandle.tabIndex = 0;
      dragHandle.textContent = "⠿";
      dragHandle.title = t("kanban.dragCard");
      dragHandle.setAttribute("aria-label", t("kanban.dragCard"));
      dragHandle.setAttribute("role", "button");

      const styleMenu = createKanbanCardStyleMenu(card);

      const cardTitle = document.createElement("input");
      cardTitle.type = "text";
      cardTitle.className = "kanban-card-title";
      cardTitle.value = card.title;
      cardTitle.maxLength = kanbanLimits.cardTitleLength;
      cardTitle.placeholder = t("kanban.cardTitlePlaceholder");
      cardTitle.dataset.cardId = card.id;
      cardTitle.setAttribute("aria-label", t("kanban.cardTitleAria"));

      const deleteCard = makeKanbanActionButton(
        "kanban-delete-card",
        "×",
        t("kanban.deleteCard"),
        { columnId: column.id, cardId: card.id }
      );
      deleteCard.classList.add("kanban-card-delete");

      cardTop.append(dragHandle, styleMenu, cardTitle, deleteCard);

      const description = document.createElement("textarea");
      description.className = "kanban-card-description";
      description.rows = 1;
      description.value = card.description;
      description.maxLength = kanbanLimits.cardDescriptionLength;
      description.placeholder = t("kanban.descriptionPlaceholder");
      description.dataset.cardId = card.id;
      description.setAttribute("aria-label", t("kanban.descriptionAria"));
      requestAnimationFrame(() => autoGrowTextarea(description));

      const tagsInput = document.createElement("input");
      tagsInput.type = "text";
      tagsInput.className = "kanban-card-tags";
      tagsInput.value = card.tags.join(", ");
      tagsInput.placeholder = t("kanban.tagsPlaceholder");
      tagsInput.dataset.cardId = card.id;
      tagsInput.setAttribute("aria-label", t("kanban.tagsAria"));

      const cardFooter = document.createElement("div");
      cardFooter.className = "kanban-card-footer";

      const moveLeft = makeKanbanActionButton(
        "kanban-move-card-left",
        "←",
        t("kanban.moveLeft"),
        { columnId: column.id, cardId: card.id }
      );
      moveLeft.disabled = columnIndex === 0;

      const moveRight = makeKanbanActionButton(
        "kanban-move-card-right",
        "→",
        t("kanban.moveRight"),
        { columnId: column.id, cardId: card.id }
      );
      moveRight.disabled = columnIndex === boardData.columns.length - 1;

      const position = document.createElement("span");
      position.className = "kanban-card-position";
      position.textContent = `${formatNumber(cardIndex + 1)} / ${formatNumber(column.cards.length)}`;

      cardFooter.append(position, moveLeft, moveRight);
      cardElement.append(cardTop, description, tagsInput, cardFooter);
      cardList.append(cardElement);
    });

    const addCard = makeKanbanActionButton(
      "kanban-add-card",
      `＋ ${t("kanban.addCard")}`,
      t("kanban.addCard"),
      { columnId: column.id }
    );
    addCard.classList.add("kanban-add-card");
    addCard.disabled = column.cards.length >= kanbanLimits.cardsPerColumn;

    columnElement.append(columnHeader, cardList, addCard);
    board.append(columnElement);
  });

  scroller.append(board);
  editor.append(toolbar, scroller);
  return editor;
}

function getKanbanColumns(row) {
  return [...(row?.querySelectorAll(".kanban-column") ?? [])];
}

function extractKanbanData(row) {
  const title = row?.querySelector(".kanban-title-input")?.value ?? t("kanban.defaultTitle");
  const columns = getKanbanColumns(row).map((columnElement, columnIndex) => {
    const columnId = columnElement.dataset.columnId || createClientId("col");
    const cards = [...columnElement.querySelectorAll(".kanban-card")].map((cardElement) => ({
      id: cardElement.dataset.cardId || createClientId("card"),
      title: cardElement.querySelector(".kanban-card-title")?.value ?? "",
      description: cardElement.querySelector(".kanban-card-description")?.value ?? "",
      icon: normalizeKanbanIcon(cardElement.querySelector(".kanban-card-emoji-input")?.value ?? ""),
      color: normalizeKanbanCardColor(cardElement.dataset.cardColor),
      tags: normalizeKanbanTags(cardElement.querySelector(".kanban-card-tags")?.value ?? "")
    }));

    return {
      id: columnId,
      title: columnElement.querySelector(".kanban-column-title")?.value ?? t("kanban.untitledColumn"),
      color: kanbanColumnColors.includes(columnElement.dataset.columnColor)
        ? columnElement.dataset.columnColor
        : kanbanColumnColors[columnIndex % kanbanColumnColors.length],
      cards
    };
  });

  return normalizeKanbanData({ title, columns });
}

function summarizeKanbanData(board) {
  const lines = [board.title];
  board.columns.forEach((column) => {
    lines.push(`${column.title}:`);
    column.cards.forEach((card) => {
      const tags = card.tags.length ? ` [${card.tags.join(", ")}]` : "";
      const icon = card.icon ? `${card.icon} ` : "";
      lines.push(`- ${icon}${card.title || t("kanban.untitledCard")}${tags}`);
      if (card.description) lines.push(`  ${card.description}`);
    });
  });
  return lines.join("\n").slice(0, 20_000);
}

function replaceKanbanData(
  row,
  value,
  { focusCardId = null, focusStyleCardId = null, focusColumnId = null, focusBoardTitle = false } = {}
) {
  const data = normalizeKanbanData(value);
  const host = row?.querySelector(".block-editor-host");
  if (!host) return;
  host.replaceChildren(createKanbanEditor(row, data));
  scheduleBlockSave(row);

  requestAnimationFrame(() => {
    if (focusCardId) {
      const title = row.querySelector(`.kanban-card[data-card-id="${focusCardId}"] .kanban-card-title`);
      title?.focus();
      title?.select();
      return;
    }
    if (focusStyleCardId) {
      const details = row.querySelector(`.kanban-card[data-card-id="${focusStyleCardId}"] .kanban-card-style-menu`);
      if (details) {
        closeKanbanCardStyleMenus(details);
        details.open = true;
        positionKanbanCardStylePanel(details);
      }
      details?.querySelector("summary")?.focus();
      return;
    }
    if (focusColumnId) {
      const title = row.querySelector(`.kanban-column[data-column-id="${focusColumnId}"] .kanban-column-title`);
      title?.focus();
      title?.select();
      return;
    }
    if (focusBoardTitle) {
      const title = row.querySelector(".kanban-title-input");
      title?.focus();
      title?.select();
    }
  });
}

function findKanbanCard(board, cardId) {
  for (const [columnIndex, column] of board.columns.entries()) {
    const cardIndex = column.cards.findIndex((card) => card.id === cardId);
    if (cardIndex >= 0) return { column, columnIndex, cardIndex, card: column.cards[cardIndex] };
  }
  return null;
}

function handleKanbanAction(row, button) {
  const action = button.dataset.action;
  const data = extractKanbanData(row);

  if (action === "kanban-add-column") {
    if (data.columns.length >= kanbanLimits.columns) return;
    const column = {
      id: createClientId("col"),
      title: t("kanban.newColumn"),
      color: kanbanColumnColors[data.columns.length % kanbanColumnColors.length],
      cards: []
    };
    data.columns.push(column);
    replaceKanbanData(row, data, { focusColumnId: column.id });
    return;
  }

  if (action === "kanban-delete-column") {
    if (data.columns.length <= 1) return;
    const columnIndex = data.columns.findIndex((column) => column.id === button.dataset.columnId);
    if (columnIndex < 0) return;
    const column = data.columns[columnIndex];
    const message = column.cards.length
      ? t("confirm.deleteKanbanColumnWithCards", { count: formatNumber(column.cards.length) })
      : t("confirm.deleteKanbanColumn");
    if (!window.confirm(message)) return;
    data.columns.splice(columnIndex, 1);
    replaceKanbanData(row, data);
    return;
  }

  if (action === "kanban-cycle-color") {
    const column = data.columns.find((item) => item.id === button.dataset.columnId);
    if (!column) return;
    const nextIndex = (kanbanColumnColors.indexOf(column.color) + 1) % kanbanColumnColors.length;
    column.color = kanbanColumnColors[nextIndex];
    replaceKanbanData(row, data, { focusColumnId: column.id });
    return;
  }

  if (action === "kanban-add-card") {
    const column = data.columns.find((item) => item.id === button.dataset.columnId);
    if (!column || column.cards.length >= kanbanLimits.cardsPerColumn) return;
    const card = { id: createClientId("card"), title: "", description: "", icon: "", color: "default", tags: [] };
    column.cards.push(card);
    replaceKanbanData(row, data, { focusCardId: card.id });
    return;
  }

  const found = findKanbanCard(data, button.dataset.cardId);
  if (!found) return;

  if (action === "kanban-delete-card") {
    if (!window.confirm(t("confirm.deleteKanbanCard"))) return;
    found.column.cards.splice(found.cardIndex, 1);
    replaceKanbanData(row, data);
    return;
  }

  if (action === "kanban-set-card-emoji") {
    found.card.icon = normalizeKanbanIcon(button.dataset.emoji);
    replaceKanbanData(row, data, { focusStyleCardId: found.card.id });
    return;
  }

  if (action === "kanban-set-card-color") {
    found.card.color = normalizeKanbanCardColor(button.dataset.color);
    replaceKanbanData(row, data, { focusStyleCardId: found.card.id });
    return;
  }

  const direction = action === "kanban-move-card-left" ? -1 : action === "kanban-move-card-right" ? 1 : 0;
  if (direction) {
    const targetColumn = data.columns[found.columnIndex + direction];
    if (!targetColumn || targetColumn.cards.length >= kanbanLimits.cardsPerColumn) return;
    found.column.cards.splice(found.cardIndex, 1);
    targetColumn.cards.push(found.card);
    replaceKanbanData(row, data, { focusCardId: found.card.id });
  }
}

function clearKanbanDropTargets({ clearDragging = true } = {}) {
  elements.blockList.querySelectorAll(".kanban-card-list.is-drop-target").forEach((list) => {
    list.classList.remove("is-drop-target");
  });
  if (clearDragging) {
    elements.blockList.querySelectorAll(".kanban-card.is-dragging").forEach((card) => {
      card.classList.remove("is-dragging");
    });
  }
}

function getKanbanDropIndex(list, clientY, draggedCardId) {
  const cards = [...list.querySelectorAll(".kanban-card")].filter((card) => card.dataset.cardId !== draggedCardId);
  let index = 0;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY >= rect.top + rect.height / 2) index += 1;
    else break;
  }
  return index;
}

function dropKanbanCard(row, list, clientY) {
  if (!activeKanbanCardDrag || activeKanbanCardDrag.row !== row) return;
  const data = extractKanbanData(row);
  const found = findKanbanCard(data, activeKanbanCardDrag.cardId);
  const targetColumn = data.columns.find((column) => column.id === list.dataset.columnId);
  if (
    !found ||
    !targetColumn ||
    (targetColumn.id !== found.column.id && targetColumn.cards.length >= kanbanLimits.cardsPerColumn)
  ) return;

  const targetIndex = getKanbanDropIndex(list, clientY, found.card.id);
  found.column.cards.splice(found.cardIndex, 1);
  targetColumn.cards.splice(Math.min(targetIndex, targetColumn.cards.length), 0, found.card);
  replaceKanbanData(row, data);
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
  toolbar.setAttribute("aria-label", t("table.toolbarAria"));

  const size = document.createElement("span");
  size.className = "table-size-label";
  size.textContent = `${rowCount} × ${columnCount}`;

  toolbar.append(
    size,
    makeTableActionButton("table-toggle-header-row", t("table.firstRow"), t("table.firstRowTitle"), {
      pressed: tableData.headerRow
    }),
    makeTableActionButton("table-toggle-header-column", t("table.firstColumn"), t("table.firstColumnTitle"), {
      pressed: tableData.headerColumn
    }),
    makeTableActionButton("table-delete-row", t("table.deleteRow"), t("table.deleteRowTitle"), {
      disabled: rowCount <= 1
    }),
    makeTableActionButton("table-delete-column", t("table.deleteColumn"), t("table.deleteColumnTitle"), {
      disabled: columnCount <= 1
    })
  );

  const scroller = document.createElement("div");
  scroller.className = "table-block-scroll";
  scroller.tabIndex = -1;

  const table = document.createElement("table");
  table.className = "table-block-grid";
  table.setAttribute("role", "grid");
  table.setAttribute("aria-label", t("table.editableAria"));
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
      input.setAttribute(
        "aria-label",
        t("table.cellAria", { row: formatNumber(rowIndex + 1), column: formatNumber(columnIndex + 1) })
      );
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
    t("table.addColumn"),
    { disabled: columnCount >= tableLimits.columns }
  );
  addColumnButton.classList.add("table-edge-add", "table-edge-add-column");

  const addRowButton = makeTableActionButton("table-add-row", "＋", t("table.addRow"), {
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
  textarea.placeholder = block.type === "DIVIDER" ? t("block.dividerPlaceholder") : t("block.contentPlaceholder");
  textarea.value = block.markdown ?? "";
  textarea.setAttribute("aria-label", t("block.contentAria", { type: getBlockTypeLabel(block.type) }));
  requestAnimationFrame(() => autoGrowTextarea(textarea));
  return textarea;
}

function createAttachmentEditor(block) {
  const attachment = getBlockAttachmentData(block);
  const card = document.createElement("div");
  card.className = "attachment-block-card";

  const icon = document.createElement("span");
  icon.className = "attachment-block-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "📎";

  const details = document.createElement("div");
  details.className = "attachment-block-details";

  const name = document.createElement("strong");
  name.className = "attachment-block-name";
  name.textContent = attachment.originalName;

  const meta = document.createElement("span");
  meta.className = "attachment-block-meta";
  meta.textContent = `${formatAttachmentSize(attachment.size)} · ${attachment.mimeType}`;
  details.append(name, meta);

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "attachment-download-button";
  downloadButton.dataset.action = "download-attachment";
  downloadButton.textContent = t("attachment.download");
  downloadButton.title = t("attachment.downloadTitle", { name: attachment.originalName });
  downloadButton.setAttribute("aria-label", downloadButton.title);

  card.append(icon, details, downloadButton);
  return card;
}

function mountBlockEditor(row, block) {
  const host = row.querySelector(".block-editor-host");
  if (!host) return;
  host.replaceChildren(
    block.type === "TABLE"
      ? createTableEditor(row, getBlockTableData(block))
      : block.type === "KANBAN"
        ? createKanbanEditor(row, getBlockKanbanData(block))
        : block.type === "ATTACHMENT"
          ? createAttachmentEditor(block)
          : createTextBlockEditor(block)
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
  handle.title = t("block.handleTitle");
  handle.setAttribute("aria-label", t("block.handleAria"));
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
  typeButton.disabled = block.type === "ATTACHMENT";
  if (typeButton.disabled) typeButton.title = t("attachment.typeLocked");

  const meta = document.createElement("span");
  meta.className = "block-row-meta";
  meta.textContent = t("block.meta", { date: formatDate(block.updatedAt) });
  meta.dataset.savingLabel = t("block.saving");
  meta.dataset.savedLabel = t("block.saved");
  topLine.append(typeButton, meta);

  const todoLabel = document.createElement("label");
  todoLabel.className = "inline-todo";
  todoLabel.classList.toggle("hidden", block.type !== "TODO");
  const checked = document.createElement("input");
  checked.type = "checkbox";
  checked.name = "checked";
  checked.checked = Boolean(block.checked);
  todoLabel.append(checked, document.createTextNode(t("block.completed")));

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
  if (type === "ATTACHMENT") {
    return {
      type,
      markdown: block?.markdown ?? "",
      checked: false,
      metadata: getBlockMetadata(block)
    };
  }

  const payload = {
    type,
    markdown: textarea?.value ?? "",
    checked: checked ? checked.checked : false
  };
  const metadata = getBlockMetadata(block);

  if (type === "TABLE") {
    const table = extractTableData(row);
    metadata.table = table;
    delete metadata.kanban;
    payload.markdown = table.rows.map((cells) => cells.join("\t")).join("\n").slice(0, 20_000);
    payload.metadata = metadata;
  } else if (type === "KANBAN") {
    const kanban = extractKanbanData(row);
    metadata.kanban = kanban;
    delete metadata.table;
    payload.markdown = summarizeKanbanData(kanban);
    payload.metadata = metadata;
  } else {
    if (metadata.table) delete metadata.table;
    if (metadata.kanban) delete metadata.kanban;
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
    setStatus(t("status.calloutChanged", { type: getCalloutTypeLabel(nextType) }));
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
  setStatus(t("status.savingBlockOrder"));

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
    setStatus(t("status.blockOrderChanged"));
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
  if (previousType === "KANBAN") metadata.kanban = extractKanbanData(row);
  if (type === "TABLE" && !metadata.table) metadata.table = createDefaultTableData();
  if (type === "KANBAN" && !metadata.kanban) metadata.kanban = createDefaultKanbanData();

  row.dataset.blockType = type;
  if (type === "CALLOUT") setRowCalloutType(row, row.dataset.calloutType);
  const typeButton = row.querySelector(".block-type-pill");
  if (typeButton) typeButton.textContent = getBlockTypeLabel(type);

  const todoLabel = row.querySelector(".inline-todo");
  todoLabel?.classList.toggle("hidden", type !== "TODO");

  mountBlockEditor(row, {
    ...existing,
    type,
    markdown: type === "TABLE" || type === "KANBAN" ? "" : markdown ?? previousTextarea?.value ?? existing.markdown ?? "",
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
    if (!quiet) setStatus(t("status.blockSaved"));
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
  setStatus(t("status.formatApplied"));
}

function getSlashContext(textarea) {
  const position = textarea.selectionStart ?? textarea.value.length;
  const before = textarea.value.slice(0, position);
  const match = before.match(/(^|\n)\/([\p{L}\p{N}_-]*)$/u);
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
    const haystack = [
      item.command,
      item.type,
      t(`slash.${item.type}.label`),
      t(`slash.${item.type}.hint`),
      t(`slash.${item.type}.keywords`)
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function closeSlashMenu() {
  elements.slashMenu.classList.add("hidden");
  elements.slashMenu.replaceChildren();
  elements.slashMenu.style.removeProperty("left");
  elements.slashMenu.style.removeProperty("top");
  elements.slashMenu.style.removeProperty("visibility");
  state.activeSlashBlockId = null;
  state.activeSlashIndex = 0;
}

function positionSlashMenu(row) {
  const textarea = getBlockTextarea(row);
  const anchor = textarea ?? row.querySelector(".block-editor-host");
  const slashContext = textarea ? getSlashContext(textarea) : null;
  const rect =
    textarea && slashContext
      ? getTextareaSelectionRect(textarea, { start: slashContext.end, end: slashContext.end })
      : (anchor?.getBoundingClientRect() ?? row.getBoundingClientRect());

  elements.slashMenu.style.visibility = "hidden";
  elements.slashMenu.classList.remove("hidden");

  const menuRect = elements.slashMenu.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const viewportPadding = 12;
  const gap = 6;
  const maxLeft = Math.max(viewportPadding, window.innerWidth - menuRect.width - viewportPadding);
  const left = Math.min(Math.max(rect.left, viewportPadding), maxLeft);
  let top = rect.top + rect.height + gap;

  if (top + menuRect.height > window.innerHeight - viewportPadding) {
    top = rowRect.top - menuRect.height - gap;
  }

  const maxTop = Math.max(viewportPadding, window.innerHeight - menuRect.height - viewportPadding);
  top = Math.min(Math.max(top, viewportPadding), maxTop);

  elements.slashMenu.style.left = `${left}px`;
  elements.slashMenu.style.top = `${top}px`;
  elements.slashMenu.style.visibility = "visible";
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
    empty.textContent = t("empty.noSlashResults");
    elements.slashMenu.append(empty);
  }

  commands.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slash-menu-item";
    button.classList.toggle("active", index === state.activeSlashIndex);
    button.dataset.type = item.type;
    button.setAttribute("role", "menuitem");

    const icon = createSlashCommandIcon(item.icon);

    const label = document.createElement("strong");
    label.textContent = t(`slash.${item.type}.label`);

    const command = document.createElement("code");
    command.textContent = item.command;

    const hint = document.createElement("span");
    hint.className = "slash-menu-hint";
    hint.textContent = t(`slash.${item.type}.hint`);

    button.append(icon, label, command, hint);
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

async function uploadAttachmentFromRow(row, file, slashContext = null) {
  if (!state.selectedPage || !row?.dataset.blockId || !file) return;

  const blockId = row.dataset.blockId;
  clearTimeout(blockSaveTimers.get(blockId));
  blockSaveTimers.delete(blockId);
  const block = getBlockById(blockId);
  const textarea = getBlockTextarea(row);
  const currentMarkdown = textarea?.value ?? block?.markdown ?? "";
  const remainingMarkdown = slashContext
    ? `${currentMarkdown.slice(0, slashContext.start)}${currentMarkdown.slice(slashContext.end)}`
    : currentMarkdown;
  const parentBlockId = normalizeParentBlockId(row.dataset.parentBlockId);
  const siblingIds = getBlockSiblings(parentBlockId).map((item) => item.id);
  const referenceIndex = siblingIds.indexOf(blockId);
  if (referenceIndex < 0) throw new Error(t("errors.currentBlockOrder"));

  const replaceCurrentBlock = !remainingMarkdown.trim() && !(block?.children?.length);
  if (!replaceCurrentBlock && textarea && textarea.value !== remainingMarkdown) {
    textarea.value = remainingMarkdown;
    autoGrowTextarea(textarea);
    await saveBlockRow(row, { quiet: true });
  }

  const insertionIndex = replaceCurrentBlock ? referenceIndex : referenceIndex + 1;
  const formData = new FormData();
  formData.set("file", file, file.name);
  if (parentBlockId) formData.set("parentBlockId", parentBlockId);
  formData.set("sortOrder", String(insertionIndex));

  row.classList.add("is-uploading");
  setStatus(t("status.attachmentUploading", { name: file.name }));
  try {
    const data = await api(`/api/pages/${state.selectedPage.id}/attachments`, {
      method: "POST",
      body: formData
    });

    const orderedIds = [...siblingIds];
    if (replaceCurrentBlock) {
      orderedIds.splice(referenceIndex, 1, data.block.id);
      await api(`/api/blocks/${blockId}`, { method: "DELETE" });
    } else {
      orderedIds.splice(insertionIndex, 0, data.block.id);
    }
    await persistBlockOrder(parentBlockId, orderedIds);

    state.pendingFocusBlockId = data.block.id;
    await openPage(state.selectedPage.id);
    setStatus(t("status.attachmentUploaded", { name: file.name }));
  } finally {
    row.classList.remove("is-uploading");
  }
}

function requestAttachmentUpload(row, slashContext = null) {
  const input = document.createElement("input");
  input.type = "file";
  input.className = "visually-hidden attachment-file-input";
  input.tabIndex = -1;
  input.setAttribute("aria-label", t("attachment.chooseFile"));
  document.body.append(input);

  const cleanup = () => input.remove();
  input.addEventListener("cancel", cleanup, { once: true });
  input.addEventListener(
    "change",
    () => {
      const file = input.files?.[0];
      if (!file) return cleanup();
      uploadAttachmentFromRow(row, file, slashContext)
        .catch((error) => setStatus(error.message, true))
        .finally(cleanup);
    },
    { once: true }
  );
  input.click();
}

async function applySlashCommand(row, type) {
  const previousTextarea = getBlockTextarea(row);
  const context = previousTextarea ? getSlashContext(previousTextarea) : null;
  let markdown = previousTextarea?.value ?? "";

  if (type === "ATTACHMENT") {
    closeSlashMenu();
    requestAttachmentUpload(row, context);
    return;
  }

  if (context) markdown = `${markdown.slice(0, context.start)}${markdown.slice(context.end)}`;
  if (type === "DIVIDER" || type === "TABLE" || type === "KANBAN") markdown = "";

  setRowType(row, type, { markdown });
  closeSlashMenu();
  await saveBlockRow(row);

  const nextTextarea = getBlockTextarea(row);
  if (nextTextarea) {
    autoGrowTextarea(nextTextarea);
    nextTextarea.focus();
    const cursor = context ? Math.min(context.start, nextTextarea.value.length) : nextTextarea.value.length;
    nextTextarea.selectionStart = nextTextarea.selectionEnd = cursor;
  } else if (type === "KANBAN") {
    row.querySelector(".kanban-title-input")?.focus();
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
  if (referenceIndex < 0) throw new Error(t("errors.currentBlockOrder"));

  const insertionIndex = placement === "before" ? referenceIndex : referenceIndex + 1;
  const data = await createEmptyBlock(state.selectedPage.id, { parentBlockId, sortOrder: insertionIndex });
  const orderedIds = [...siblingIds];
  orderedIds.splice(insertionIndex, 0, data.block.id);
  await persistBlockOrder(parentBlockId, orderedIds);

  state.pendingFocusBlockId = data.block.id;
  await openPage(state.selectedPage.id);
  setStatus(
    t("status.blockInserted", {
      position: t(placement === "before" ? "position.top" : "position.bottom")
    })
  );
}

async function appendBlock(afterRow = null) {
  if (afterRow) return insertBlockRelative(afterRow, "after");
  if (!state.selectedPage) return;

  const siblingIds = getBlockSiblings(null).map((block) => block.id);
  const data = await createEmptyBlock(state.selectedPage.id, { sortOrder: siblingIds.length });
  await persistBlockOrder(null, [...siblingIds, data.block.id]);

  state.pendingFocusBlockId = data.block.id;
  await openPage(state.selectedPage.id);
  setStatus(t("status.blockAppended"));
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
  setStatus(t("status.emptyBlockDeleted"));
}

function focusPendingBlock() {
  if (!state.pendingFocusBlockId) return;
  const row = elements.blockList.querySelector(`[data-block-id="${state.pendingFocusBlockId}"]`);
  const textarea = getBlockTextarea(row);
  if (textarea) {
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  } else {
    row?.querySelector(".table-cell-input, .kanban-title-input, .attachment-download-button")?.focus();
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
  elements.blockCount.textContent = t("counts.blocks", { count: formatNumber(flatBlocks.length) });

  elements.blockList.replaceChildren();
  if (!flatBlocks.length) {
    const empty = makeEmptyMessage(t("empty.preparingBlock"));
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
  return title || t("newDocumentTitle");
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
    if (!quiet) setStatus(t("status.pageTitleSaved"));
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
  setStatus(t("status.creatingDocument"));
  elements.searchInput.value = "";
  state.searchQuery = "";
  state.activeTag = "";

  const data = await api("/api/pages", {
    method: "POST",
    body: {
      title: t("newDocumentTitle"),
      icon: "📄"
    }
  });

  await loadPages("", "");
  await openPage(data.page.id);
  requestAnimationFrame(() => {
    elements.pageTitle.focus();
    elements.pageTitle.select();
  });
  setStatus(t("status.documentCreated"));
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
  setStatus(t("status.loadingDocument"));
  let data = await api(`/api/pages/${pageId}`);

  if (!flattenBlocks(data.page.blocks).length) {
    const starter = await createEmptyBlock(pageId);
    state.pendingFocusBlockId = starter.block.id;
    data = await api(`/api/pages/${pageId}`);
  }

  state.selectedPage = data.page;
  renderSelectedPage();
  setStatus(t("status.documentOpened"));
}

async function boot() {
  applyDocumentTranslations();
  populateLanguageSelect(elements.languageSelect);
  setAuthMode(state.authMode, false);

  try {
    await loadMe();
    renderShell();
    if (state.user) await loadPages();
    setStatus(state.user ? t("status.ready") : t("status.getStarted"));
  } catch (error) {
    setToken(null);
    state.user = null;
    renderShell();
    setStatus(t("status.loginRequired"));
  }
}

elements.authSwitchLink.addEventListener("click", (event) => {
  event.preventDefault();
  setAuthMode(state.authMode === "register" ? "login" : "register");
  setStatus(t(state.authMode === "register" ? "status.registerPrompt" : "status.loginPrompt"));
  elements.username.focus();
});

window.addEventListener("hashchange", () => {
  setAuthMode(window.location.hash === "#signup" ? "register" : "login", false);
});

function refreshLocalizedUi() {
  applyDocumentTranslations();
  elements.languageSelect.value = getLanguage();
  setAuthMode(state.authMode, false);
  renderPages();
  renderSelectedPage();

  if (!elements.slashMenu.classList.contains("hidden") && state.activeSlashBlockId) {
    const row = elements.blockList.querySelector(`[data-block-id="${state.activeSlashBlockId}"]`);
    const textarea = getBlockTextarea(row);
    if (row) renderSlashMenu(row, textarea ? getSlashContext(textarea)?.query ?? "" : "");
  }
}

elements.languageSelect.addEventListener("change", () => {
  const language = setLanguage(elements.languageSelect.value);
  setStatus(t("status.languageChanged", { language: getLanguageLabel(language) }));
});

window.addEventListener("brainvault:languagechange", refreshLocalizedUi);

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = state.authMode;
  const body = {
    username: elements.username.value.trim(),
    password: elements.password.value
  };
  if (mode === "register" && elements.name.value.trim()) body.name = elements.name.value.trim();

  try {
    setStatus(t(mode === "login" ? "status.loggingIn" : "status.registering"));
    const data = await api(`/api/auth/${mode}`, { method: "POST", body });
    setToken(data.token);
    state.user = data.user;
    renderShell();
    await loadPages();
    setStatus(t("status.loggedInAs", { username: state.user.username }));
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
  setStatus(t("status.loggedOut"));
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
    setStatus(t("status.searchLoaded"));
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
    setStatus(t("status.collectionOpened"));
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
  if (!elements.pageTitle.value.trim()) elements.pageTitle.value = t("newDocumentTitle");
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
    setStatus(t("status.pageSaved"));
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.archivePageButton.addEventListener("click", async () => {
  if (!state.selectedPage) return;
  const ok = window.confirm(t("confirm.archivePage"));
  if (!ok) return;
  try {
    await api(`/api/pages/${state.selectedPage.id}`, { method: "PATCH", body: { isArchived: true } });
    state.selectedPage = null;
    await loadPages(elements.searchInput.value.trim(), state.activeTag);
    renderSelectedPage();
    setStatus(t("status.pageArchived"));
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


elements.blockList.addEventListener("dragstart", (event) => {
  const handle = event.target.closest(".kanban-card-drag-handle");
  const card = handle?.closest(".kanban-card");
  const row = getBlockRow(card);
  if (!handle || !card?.dataset.cardId || !row || row.dataset.blockType !== "KANBAN") return;

  activeKanbanCardDrag = {
    row,
    cardId: card.dataset.cardId,
    sourceColumnId: card.dataset.columnId
  };
  card.classList.add("is-dragging");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.dataset.cardId);
  }
  requestAnimationFrame(() => card.classList.add("is-dragging"));
});

elements.blockList.addEventListener("dragover", (event) => {
  if (!activeKanbanCardDrag) return;
  const list = event.target.closest(".kanban-card-list");
  const row = getBlockRow(list);
  if (!list || row !== activeKanbanCardDrag.row) return;

  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  clearKanbanDropTargets({ clearDragging: false });
  list.classList.add("is-drop-target");
});

elements.blockList.addEventListener("drop", (event) => {
  if (!activeKanbanCardDrag) return;
  const list = event.target.closest(".kanban-card-list");
  const row = getBlockRow(list);
  if (!list || row !== activeKanbanCardDrag.row) return;

  event.preventDefault();
  dropKanbanCard(row, list, event.clientY);
  clearKanbanDropTargets();
  activeKanbanCardDrag = null;
});

elements.blockList.addEventListener("dragend", () => {
  clearKanbanDropTargets();
  activeKanbanCardDrag = null;
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
  const kanbanField = event.target.closest(
    ".kanban-title-input, .kanban-column-title, .kanban-card-title, .kanban-card-description, .kanban-card-tags, .kanban-card-emoji-input"
  );
  if (kanbanField) {
    if (kanbanField.classList.contains("kanban-card-description")) autoGrowTextarea(kanbanField);
    if (kanbanField.classList.contains("kanban-card-emoji-input")) {
      const preview = kanbanField.closest(".kanban-card-style-menu")?.querySelector(".kanban-card-icon-preview");
      if (preview) preview.textContent = normalizeKanbanIcon(kanbanField.value) || "＋";
    }
    const row = getBlockRow(kanbanField);
    if (row) scheduleBlockSave(row);
    return;
  }

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
  const kanbanField = event.target.closest(
    ".kanban-title-input, .kanban-column-title, .kanban-card-title, .kanban-card-description, .kanban-card-tags, .kanban-card-emoji-input"
  );
  if (kanbanField) {
    const row = getBlockRow(kanbanField);
    if (row && !row.contains(event.relatedTarget) && row.dataset.deleting !== "true") {
      saveBlockRow(row, { quiet: true }).catch((error) => setStatus(error.message, true));
    }
    return;
  }

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
  const styleSummary = event.target.closest(".kanban-card-icon-button");
  if (styleSummary) {
    const details = styleSummary.closest(".kanban-card-style-menu");
    closeKanbanCardStyleMenus(details);
    requestAnimationFrame(() => positionKanbanCardStylePanel(details));
    return;
  }

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
    if (button.dataset.action === "download-attachment") {
      const block = getBlockById(blockId);
      if (!block) throw new Error(t("errors.attachmentNotFound"));
      setStatus(t("status.attachmentDownloading", { name: getBlockAttachmentData(block).originalName }));
      await downloadAttachment(block);
      setStatus(t("status.attachmentDownloaded", { name: getBlockAttachmentData(block).originalName }));
      return;
    }

    if (button.dataset.action.startsWith("table-")) {
      handleTableAction(row, button.dataset.action);
      return;
    }

    if (button.dataset.action.startsWith("kanban-")) {
      handleKanbanAction(row, button);
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
      if (row.dataset.blockType !== "ATTACHMENT") await saveBlockRow(row, { quiet: true });
      await insertBlockRelative(row, placement);
      return;
    }

    if (button.dataset.action === "save-block") {
      closeBlockContextMenu({ restoreFocus: true });
      if (row.dataset.blockType === "ATTACHMENT") {
        setStatus(t("status.attachmentReady"));
        return;
      }
      await saveBlockRow(row);
      return;
    }

    if (button.dataset.action === "delete-block") {
      const ok = window.confirm(t("confirm.deleteBlock"));
      if (!ok) return;
      closeBlockContextMenu();
      await api(`/api/blocks/${blockId}`, { method: "DELETE" });
      await openPage(state.selectedPage.id);
      setStatus(t("status.blockDeleted"));
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
  if (!event.target.closest(".kanban-card-style-menu")) closeKanbanCardStyleMenus();

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
  closeKanbanCardStyleMenus();
});

document.addEventListener("scroll", () => closeKanbanCardStyleMenus(), { capture: true, passive: true });
window.addEventListener("scroll", () => closeBlockContextMenu(), { passive: true });

boot();
