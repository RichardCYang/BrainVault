import { isoCountryCodes } from "./country-codes.js";
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
import {
  codeLanguageOptions,
  getBlockCodeLanguage,
  hydrateHighlightedCodeBlocks,
  normalizeCodeLanguage,
  renderCodePreview
} from "./code-highlighting.js";
import {
  createDatabaseEditor,
  createDefaultDatabaseData,
  extractDatabaseData,
  normalizeDatabaseData,
  summarizeDatabaseData
} from "./database-block.js";
import {
  createAccordionEditor,
  createDefaultAccordionData,
  extractAccordionData,
  normalizeAccordionData,
  setAccordionItemIcon,
  setAccordionShowOrder,
  summarizeAccordionData
} from "./accordion-block.js";
import {
  createGanttEditor,
  createDefaultGanttData,
  extractGanttData,
  normalizeGanttData,
  summarizeGanttData
} from "./gantt-block.js";
import {
  createTimetableEditor,
  createDefaultTimetableData,
  extractTimetableData,
  normalizeTimetableData,
  summarizeTimetableData
} from "./timetable-block.js";
import {
  createAiChatEditor,
  createDefaultAiChatData,
  extractAiChatData,
  normalizeAiChatData,
  summarizeAiChatData
} from "./ai-chat-block.js";
import { emojiCategoryDefinitions, emojiRecords } from "./emoji-data.js";
import { createEmojiVisual, renderEmojiVisual } from "./emoji-renderer.js";
import { iconCategoryDefinitions, iconRecords, iconSvgNodes } from "./icon-data.js";
import { createPageDraftStore } from "./draft-store.js";
import { createLatestWriteQueue } from "./save-queue.js";
import { createAccountProfileMutationQueue } from "./account-profile-mutation-queue.js";
import { createMutationId, submitWithFreshMutationIdOnReuse } from "./mutation-id.js";
import { rebaseCommittedBlockContent, rebaseCommittedPageTitle } from "./save-rebase.js";
import { createPageCollaboration, decodeCollaborationRecoveryRecords } from "./collaboration.js";
import {
  assignRemoteCaretColors,
  getRemoteCaretClientKey,
  getRowTextSelectionControls,
  getTextControlCaretRect,
  getTextSelectionControlByKey,
  getTextSelectionControlKey
} from "./collaboration-caret.js";
import { assertCollaborationExitSafe } from "./collaboration-exit-guard.js";
import { createCollaborationRecoveryStore } from "./collaboration-recovery-store.js";
import { createPageTransitionLock } from "./page-transition-lock.js";
import {
  BLOCK_MARKDOWN_MAX_LENGTH,
  requirePageTitleWithinLimit
} from "./editor-content-limits.js";
import {
  createYouTubeVideoEditor,
  parseYouTubeVideoUrl,
  updateYouTubeVideoPreview
} from "./youtube-block.js";
import { restoreSessionAtBoot } from "./session-bootstrap.js";
import {
  applyWebRtcNetworkSignalHeaders,
  getWebRtcNetworkSignal
} from "./webrtc-network-signal.js";
import { parseWorkspaceLocation, serializeWorkspaceLocation } from "./workspace-location.js";
import {
  createPageCoverOperationGuard,
  isPageCoverPositionDraftForPage
} from "./page-cover-operation.js";
import {
  createIconPickerOperationGuard,
  getIconPickerTargetKey
} from "./icon-picker-operation.js";
import {
  customIconLibraryLimit,
  filterRemovedCustomIconLibraryEntries,
  listCustomIconLibrary,
  rememberCustomIconLibraryEntries,
  rememberCustomIconLibraryEntry,
  removeCustomIconLibraryEntry
} from "./custom-icon-library.js";
import {
  createAccountAvatarOperationGuard,
  getAccountAvatarTargetKey,
  isAccountProfileDraftUnchanged
} from "./account-avatar-operation.js";

const rootParentKey = "__root__";
const defaultCollectionKey = "__default_collection__";
const recentEmojiStorageKey = "brainvault.recentEmojis";
const emojiSkinToneStorageKey = "brainvault.emojiSkinTone";
const themeStorageKey = "brainvault.theme";
const supportedThemes = new Set(["light", "dark"]);
const themeColorByTheme = Object.freeze({ light: "#e7eef3", dark: "#17191d" });
const emojiSkinToneModifiers = Object.freeze(["🏻", "🏼", "🏽", "🏾", "🏿"]);
const emojiBatchSize = 240;
const builtInIconPrefix = "icon:";
const imageIconPrefix = "image:";
const customIconMaxBytes = 512 * 1024;
const customIconMaxUrlLength = 2048;
const customIconMimeTypes = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/vnd.microsoft.icon", "image/x-icon"]);
const defaultPageCoverPaths = Object.freeze(
  Array.from({ length: 5 }, (_, index) => `/img/default_cover/coverimg${index + 1}.png`)
);
const customCoverMimeTypes = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
const customCoverMaxBytes = 2 * 1024 * 1024;
const customCoverSourceMaxBytes = 20 * 1024 * 1024;
const customCoverMaxWidth = 2400;
const customCoverMaxHeight = 1600;
const mobileSidebarMedia = window.matchMedia("(max-width: 760px)");
const pageModes = Object.freeze({ READ: "read", WRITE: "write" });
const keepaliveSaveBudgetBytes = 60 * 1024;

function createPageDraftSourceId() {
  return globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Generate this in memory instead of sessionStorage. Browsers may clone sessionStorage
// when a tab is duplicated, which would let two live tabs overwrite the same draft.
const pageDraftStoragePrefix = "brainvault.pageDraft.v2:";
const pageTransitionStoragePrefix = "brainvault.pageTransition.v1";
const collaborationRecoveryStoragePrefix = "brainvault.collaborationRecovery.v1";
const workspaceTransitionPagePrefix = "__workspace__";
const pageDraftSourceId = createPageDraftSourceId();
const pageDraftStore = createPageDraftStore(window.localStorage, { sourceId: pageDraftSourceId });
const collaborationRecoveryStore = createCollaborationRecoveryStore(window.localStorage, {
  prefix: collaborationRecoveryStoragePrefix
});
const pageTransitionLock = createPageTransitionLock(window.localStorage, {
  prefix: pageTransitionStoragePrefix,
  sourceId: pageDraftSourceId,
  lockManager: window.navigator.locks
});
let activePageTransitionLease = null;
let pageTransitionUnlockTimer = null;
let collaborationRecoveryPanelGeneration = 0;
const pageCoverOperationGuard = createPageCoverOperationGuard();
const iconPickerOperationGuard = createIconPickerOperationGuard();
let customIconLibraryLoadGeneration = 0;
const accountAvatarOperationGuard = createAccountAvatarOperationGuard();
const accountProfileSaveGuard = createAccountAvatarOperationGuard();
const accountLanguageOperationGuard = createAccountAvatarOperationGuard();
const accountThemeOperationGuard = createAccountAvatarOperationGuard();
const authFlowOperationGuard = createAccountAvatarOperationGuard();
const authenticatedSessionOperationGuard = createAccountAvatarOperationGuard();
const accountDataOperationGuard = createAccountAvatarOperationGuard();
const authFlowTargetKey = "authentication-flow";
const accountSecurityOperationGuards = Object.freeze({
  activeSessions: createAccountAvatarOperationGuard(),
  loginHistory: createAccountAvatarOperationGuard(),
  blockHistory: createAccountAvatarOperationGuard(),
  totpIpPolicy: createAccountAvatarOperationGuard(),
  totpIpBlocks: createAccountAvatarOperationGuard(),
  countryPolicy: createAccountAvatarOperationGuard(),
  vpnPolicy: createAccountAvatarOperationGuard(),
  mfaStatus: createAccountAvatarOperationGuard(),
  password: createAccountAvatarOperationGuard(),
  totpSetup: createAccountAvatarOperationGuard(),
  totpVerify: createAccountAvatarOperationGuard(),
  totpDisable: createAccountAvatarOperationGuard(),
  passkeyRegister: createAccountAvatarOperationGuard()
});
let workspaceNavigationGeneration = 0;
let authenticationSessionGeneration = 0;
let sharePageRequestGeneration = 0;
let pageEditLockGeneration = 0;
const pendingWorkspaceCreateTasks = new Map();
const pendingPageVersionResetTasks = new Map();
const pendingBlockCreateTasks = new Map();
const pendingBlockDeleteTasks = new Map();
const pendingAttachmentCreateTasks = new Map();
const navigationPreferenceSaveQueues = new Map();
let pageCoverSaving = false;
let pageCoverPositionDraft = null;
let pageCoverDragPointerId = null;
let documentChildrenRenderId = 0;

const emojiSearchIndex = emojiRecords.map((record) =>
  `${record[0]} ${record[2]} ${record[3]} ${record[4]} ${record[5]}`.toLocaleLowerCase()
);
const emojiRecordByValue = new Map(emojiRecords.map((record, index) => [record[0], { record, index }]));
const emojiCategoryById = new Map(emojiCategoryDefinitions.map((category) => [category.id, category]));
const iconSearchIndex = iconRecords.map((record) =>
  `${record.name} ${record.labelKo} ${record.labelEn} ${record.keywords}`.toLocaleLowerCase()
);
const iconRecordByName = new Map(iconRecords.map((record, index) => [record.name, { record, index }]));
const iconCategoryById = new Map(iconCategoryDefinitions.map((category) => [category.id, category]));

const state = {
  authenticated: false,
  user: null,
  pages: [],
  allPages: [],
  selectedPage: null,
  pageMode: pageModes.READ,
  pageModeChanging: false,
  pageEditLockDepth: 0,
  workspaceView: "home",
  activeCollectionId: null,
  activeTag: "",
  searchQuery: "",
  searchDialogOpen: false,
  searchResults: [],
  searchLoading: false,
  searchSubmittedQuery: "",
  searchRequestId: 0,
  authMode: window.location.hash === "#signup" ? "register" : "login",
  authOperationBusy: false,
  accountDataOperationBusy: false,
  workspaceCreateBusy: false,
  activeSlashBlockId: null,
  activeSlashIndex: 0,
  activeInlineBlockId: null,
  activeInlineSelection: null,
  activeBlockMenuId: null,
  activeBlockMenuHandle: null,
  activeNavigationMenuTarget: null,
  activeNavigationMenuTrigger: null,
  collapsedNavigationPageIds: new Set(),
  navigationPageOrder: new Map(),
  pendingFocusBlockId: null,
  accountSettingsOpen: false,
  activeAccountPanel: "profile",
  activeSecurityPanel: "settings",
  activeSessions: { sessions: [], loading: false, loaded: false, revokingSessionId: null },
  loginHistory: { months: 3, attempts: [], truncated: false, loading: false, loadedMonths: null },
  blockHistory: { months: 3, blocks: [], truncated: false, loading: false, loadedMonths: null },
  totpIpBlockPolicy: {
    enabled: false,
    maxAttempts: 3,
    minAttempts: 1,
    maxAllowedAttempts: 8,
    currentIp: "unknown",
    loading: false,
    saving: false,
    loaded: false
  },
  totpIpBlocks: { blocks: [], loading: false, loaded: false, unblockingIp: null },
  countryLoginPolicy: {
    mode: "OFF",
    countries: [],
    currentIp: "unknown",
    currentCountryCode: null,
    loading: false,
    saving: false,
    loaded: false
  },
  vpnBlockPolicy: {
    enabled: false,
    currentIp: "unknown",
    currentCountryCode: null,
    verdict: "UNKNOWN",
    confidence: 0,
    datacenter: false,
    timezoneMismatch: false,
    providerCount: 0,
    webRtcState: "ABSENT",
    webRtcObservedIps: [],
    webRtcIpMismatch: false,
    supportingSignals: [],
    loading: false,
    saving: false,
    loaded: false
  },
  pendingAvatarData: null,
  accountAvatarPreparing: false,
  accountProfileSaving: false,
  accountPasskeyRegistering: false,
  mfaLogin: null,
  mfaStatus: { totpEnabled: false, passkeys: [] },
  totpSetupToken: null,
  emojiPickerTarget: null,
  emojiPickerReturnFocus: null,
  activeIconPickerTab: "emojis",
  activeEmojiCategory: "recent",
  activeIconCategory: "general",
  emojiPickerResults: [],
  emojiRenderedCount: 0,
  customIconLibrary: [],
  customIconLibraryRemovedKeys: new Set(),
  customIconLibraryRemovingValues: new Set(),
  customIconLibraryUserId: null,
  emojiSkinTone: "",
  emojiSaving: false,
  collaborationSession: null,
  collaborationStatus: "offline",
  collaborationPresence: [],
  collaborationGeneration: 0,
  applyingCollaborationSnapshot: false,
  sharePageOpen: false,
  sharePageEntries: [],
  pageVersionHistory: {
    pageId: null,
    versions: [],
    nextCursor: null,
    current: null,
    selectedId: null,
    requestId: 0,
    detailRequestId: 0,
    loading: false,
    resetting: false
  }
};

const accountProfileMutationQueue = createAccountProfileMutationQueue({
  getCurrentTargetKey: () => getAccountAvatarTargetKey(state.user)
});

const blockTypeLabels = {
  MARKDOWN: "blocks.types.MARKDOWN",
  HEADING_1: "blocks.types.HEADING_1",
  HEADING_2: "blocks.types.HEADING_2",
  HEADING_3: "blocks.types.HEADING_3",
  TODO: "blocks.types.TODO",
  UNORDERED_LIST: "blocks.types.UNORDERED_LIST",
  ORDERED_LIST: "blocks.types.ORDERED_LIST",
  QUOTE: "blocks.types.QUOTE",
  CALLOUT: "blocks.types.CALLOUT",
  TOGGLE: "blocks.types.TOGGLE",
  ACCORDION: "blocks.types.ACCORDION",
  TABLE: "blocks.types.TABLE",
  KANBAN: "blocks.types.KANBAN",
  DATABASE: "blocks.types.DATABASE",
  TIMETABLE: "blocks.types.TIMETABLE",
  GANTT: "blocks.types.GANTT",
  BOOKMARK: "blocks.types.BOOKMARK",
  AI_CHAT: "blocks.types.AI_CHAT",
  MATH: "blocks.types.MATH",
  CODE: "blocks.types.CODE",
  DIVIDER: "blocks.types.DIVIDER",
  IMAGE: "blocks.types.IMAGE",
  VIDEO: "blocks.types.VIDEO",
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

const toggleTitleMaxLength = 300;
const toggleBodyMaxLength = BLOCK_MARKDOWN_MAX_LENGTH - toggleTitleMaxLength - 1;
const tableLimits = { rows: 50, columns: 20, cellLength: 4000 };
const textAlignments = new Set(["left", "center", "right", "justify"]);
const textAlignableBlockTypes = new Set([
  "MARKDOWN",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "TODO",
  "QUOTE",
  "CALLOUT",
  "CODE",
  "IMAGE"
]);

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

const bookmarkLimits = {
  items: 50,
  idLength: 64,
  urlLength: 2048,
  blockTitleLength: 120,
  titleLength: 300,
  descriptionLength: 1000,
  siteNameLength: 160,
  maxListColumns: 5
};

function normalizeBookmarkText(value, maxLength) {
  return (typeof value === "string" ? value : "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeBookmarkUrl(value, baseUrl) {
  const raw = normalizeBookmarkText(value, bookmarkLimits.urlLength);
  if (!raw) return "";
  try {
    const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return "";
    url.hash = "";
    return url.toString().slice(0, bookmarkLimits.urlLength);
  } catch {
    return "";
  }
}

function normalizeBookmarkListColumns(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) return 1;
  return Math.min(bookmarkLimits.maxListColumns, Math.max(1, value));
}

function normalizeBookmarkInputUrl(value) {
  const raw = normalizeBookmarkText(value, bookmarkLimits.urlLength);
  if (!raw) return "";
  return normalizeBookmarkUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
}

function createDefaultBookmarkData() {
  return { title: t("bookmark.defaultTitle"), view: "gallery", listColumns: 1, items: [] };
}

function normalizeBookmarkData(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const title = typeof source.title === "string"
    ? normalizeBookmarkText(source.title, bookmarkLimits.blockTitleLength)
    : t("bookmark.defaultTitle");
  const view = source.view === "list" ? "list" : "gallery";
  const listColumns = normalizeBookmarkListColumns(source.listColumns);
  const seenIds = new Set();
  const seenUrls = new Set();
  const items = [];

  for (const [index, rawItem] of (Array.isArray(source.items) ? source.items : []).slice(0, bookmarkLimits.items).entries()) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const url = normalizeBookmarkUrl(rawItem.url);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    let id = normalizeBookmarkText(rawItem.id, bookmarkLimits.idLength) || createClientId(`bookmark-${index + 1}`);
    while (seenIds.has(id)) id = createClientId(`bookmark-${index + 1}`);
    seenIds.add(id);
    const parsedUrl = new URL(url);

    items.push({
      id,
      url,
      title: normalizeBookmarkText(rawItem.title, bookmarkLimits.titleLength) || parsedUrl.hostname,
      description: normalizeBookmarkText(rawItem.description, bookmarkLimits.descriptionLength),
      imageUrl: normalizeBookmarkUrl(rawItem.imageUrl, url),
      faviconUrl: normalizeBookmarkUrl(rawItem.faviconUrl, url) || new URL("/favicon.ico", url).toString(),
      siteName: normalizeBookmarkText(rawItem.siteName, bookmarkLimits.siteNameLength) || parsedUrl.hostname
    });
  }

  return { title, view, listColumns, items };
}

function summarizeBookmarkData(data) {
  const bookmark = normalizeBookmarkData(data);
  const itemSummary = bookmark.items
    .map((item) => `${item.title}\n${item.description}\n${item.url}`.trim())
    .join("\n\n");
  return [bookmark.title, itemSummary].filter(Boolean).join("\n\n").slice(0, 20_000);
}

const slashCommands = [
  { type: "MARKDOWN", command: "/text", icon: "text" },
  { type: "HEADING_1", command: "/h1", icon: "heading-1" },
  { type: "HEADING_2", command: "/h2", icon: "heading-2" },
  { type: "HEADING_3", command: "/h3", icon: "heading-3" },
  { type: "TODO", command: "/todo", icon: "todo" },
  { type: "UNORDERED_LIST", command: "/bullet", icon: "unordered-list" },
  { type: "ORDERED_LIST", command: "/number", icon: "ordered-list" },
  { type: "QUOTE", command: "/quote", icon: "quote" },
  { type: "CALLOUT", command: "/callout", icon: "callout" },
  { type: "TOGGLE", command: "/toggle", icon: "toggle" },
  { type: "ACCORDION", command: "/accordion", icon: "accordion" },
  { type: "TABLE", command: "/table", icon: "table" },
  { type: "DATABASE", command: "/database", icon: "database" },
  { type: "TIMETABLE", command: "/timetable", icon: "timetable" },
  { type: "GANTT", command: "/gantt", icon: "gantt" },
  { type: "KANBAN", command: "/board", icon: "kanban" },
  { type: "BOOKMARK", command: "/bookmark", icon: "bookmark" },
  { type: "AI_CHAT", command: "/ai", icon: "ai-chat" },
  { type: "MATH", command: "/math", icon: "math" },
  { type: "CODE", command: "/code", icon: "code" },
  { type: "DIVIDER", command: "/divider", icon: "divider" },
  { type: "IMAGE", command: "/image", icon: "image" },
  { type: "VIDEO", command: "/video", icon: "video" },
  { type: "ATTACHMENT", command: "/file", icon: "attachment" }
];

const listBlockTypes = new Set(["UNORDERED_LIST", "ORDERED_LIST"]);

// These block types cannot retain arbitrary source markdown. When their slash command is
// used on a later line, insert a new sibling instead of replacing earlier note text.
const slashInsertAfterTypes = new Set(["TABLE", "DATABASE", "ACCORDION", "TIMETABLE", "GANTT", "KANBAN", "BOOKMARK", "VIDEO", "DIVIDER"]);

// Structured editors serialize their real content into metadata. Converting one in place
// would make buildBlockPayload remove the source metadata for the newly selected type.
const structuredBlockTypes = new Set(["TABLE", "DATABASE", "ACCORDION", "TIMETABLE", "GANTT", "KANBAN", "BOOKMARK", "AI_CHAT"]);

function isStructuredBlockType(type) {
  return structuredBlockTypes.has(type);
}

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
  "unordered-list": [
    ["circle", { cx: "4", cy: "6", r: "1" }],
    ["circle", { cx: "4", cy: "12", r: "1" }],
    ["circle", { cx: "4", cy: "18", r: "1" }],
    ["path", { d: "M8 6h13" }],
    ["path", { d: "M8 12h13" }],
    ["path", { d: "M8 18h13" }]
  ],
  "ordered-list": [
    ["path", { d: "M3 5h2v4" }],
    ["path", { d: "M3 14c0-1 2-1.5 2-3 0-.8-.6-1.3-1.5-1.3-.6 0-1.1.2-1.5.6" }],
    ["path", { d: "M3 14h2" }],
    ["path", { d: "M8 6h13" }],
    ["path", { d: "M8 12h13" }],
    ["path", { d: "M8 18h13" }]
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
  toggle: [
    ["path", { d: "m8 9 4 4 4-4" }],
    ["path", { d: "M4 5h16" }],
    ["path", { d: "M4 19h16" }]
  ],
  accordion: [
    ["path", { d: "m6 7 2 2 2-2" }],
    ["path", { d: "M12 8h7" }],
    ["path", { d: "m6 15 2 2 2-2" }],
    ["path", { d: "M12 16h7" }],
    ["path", { d: "M3 3h18v18H3z" }]
  ],
  table: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M3 9h18" }],
    ["path", { d: "M9 3v18" }]
  ],
  database: [
    ["ellipse", { cx: "12", cy: "5", rx: "8", ry: "3" }],
    ["path", { d: "M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" }],
    ["path", { d: "M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" }]
  ],
  timetable: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M8 2v4" }],
    ["path", { d: "M16 2v4" }],
    ["path", { d: "M3 9h18" }],
    ["path", { d: "M7 13h3" }],
    ["path", { d: "M7 17h6" }]
  ],
  gantt: [
    ["path", { d: "M4 5h16" }],
    ["path", { d: "M4 10h7" }],
    ["path", { d: "M4 15h11" }],
    ["path", { d: "M4 20h5" }],
    ["path", { d: "M13 8v4" }],
    ["path", { d: "M17 13v4" }]
  ],
  kanban: [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M9 3v18" }],
    ["path", { d: "M15 3v18" }],
    ["path", { d: "M5.5 7h1" }],
    ["path", { d: "M11.5 7h1" }],
    ["path", { d: "M17.5 7h1" }]
  ],
  bookmark: [
    ["path", { d: "M6 4.5A2.5 2.5 0 0 1 8.5 2h7A2.5 2.5 0 0 1 18 4.5V22l-6-3.6L6 22Z" }],
    ["path", { d: "M9 7h6" }],
    ["path", { d: "M9 11h4" }]
  ],
  "ai-chat": [
    ["path", { d: "M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" }],
    ["path", { d: "M8 9h8" }],
    ["path", { d: "M8 13h5" }],
    ["path", { d: "m17.5 9 .45 1.05L19 10.5l-1.05.45L17.5 12l-.45-1.05L16 10.5l1.05-.45Z" }]
  ],
  math: [
    ["path", { d: "M18 5H8l6 7-6 7h10" }]
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
  video: [
    ["rect", { width: "18", height: "14", x: "3", y: "5", rx: "2" }],
    ["path", { d: "m10 9 5 3-5 3Z" }]
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
const blockSaveRows = new Map();
const blockSaveQueues = new Map();
const blockSaveTaskIds = new Map();
const blockDraftConflictOrigins = new Map();
const blockDraftRenderSources = new Map();
let pageTitleSaveTimer = null;
let pageTitleEditRevision = 0;
let pageTitleSavedRevision = 0;
let pageTitleTaskId = 0;
let pageTitleDraftExpectedVersion = null;
let pageTitleDraftSourceId = pageDraftSourceId;
let pageTitleDraftConflict = false;
let pageTitleConflictOrigin = null;
let localDraftStorageWarningShown = false;
let beforeUnloadProtectionActive = false;
let statusClearTimer = null;
const statusDismissDelay = 2400;
const statusErrorDismissDelay = 6000;
let activeBlockDrag = null;
let activeKanbanCardDrag = null;
let activeKanbanColumnDrag = null;
let activeNavigationDrag = null;
let suppressBlockHandleClickUntil = 0;
let suppressKanbanColumnMenuClickUntil = 0;
let suppressNavigationMenuClickUntil = 0;
let navigationOrderSaving = false;
let blockOrderSaving = false;
let pendingBlockOrderTask = null;
let collaborationCaretRenderFrame = null;

const $ = (selector) => document.querySelector(selector);

const elements = {
  shell: $(".shell"),
  appSidebar: $("#app-sidebar"),
  main: $(".main"),
  homeBrandButton: $("#home-brand-button"),
  mobileHomeBrandButton: $("#mobile-home-brand-button"),
  sidebarHomeShortcut: $("#sidebar-home-shortcut"),
  sidebarSearchShortcut: $("#sidebar-search-shortcut"),
  sidebarSettingsShortcut: $("#sidebar-settings-shortcut"),
  mobileSidebarToggle: $("#mobile-sidebar-toggle"),
  mobileSidebarClose: $("#mobile-sidebar-close"),
  mobileSidebarBackdrop: $("#mobile-sidebar-backdrop"),
  languageSelect: $("#language-select"),
  themeSelect: $("#theme-select"),
  accountSettingsTrigger: $("#account-settings-trigger"),
  accountSettingsLayer: $("#account-settings-layer"),
  accountSettingsBackdrop: $("#account-settings-backdrop"),
  accountSettingsDialog: $("#account-settings-dialog"),
  accountSettingsClose: $("#account-settings-close"),
  accountSettingsMessage: $("#account-settings-message"),
  accountSettingsTabs: [...document.querySelectorAll("[data-account-panel]")],
  accountSettingsPanels: [...document.querySelectorAll("[data-account-panel-content]")],
  accountSecurityTabs: [...document.querySelectorAll("[data-security-panel]")],
  accountSecurityPanels: [...document.querySelectorAll("[data-security-panel-content]")],
  accountActiveSessionsRefresh: $("#account-active-sessions-refresh"),
  accountActiveSessionsSummary: $("#account-active-sessions-summary"),
  accountActiveSessionsBody: $("#account-active-sessions-body"),
  accountActiveSessionsEmpty: $("#account-active-sessions-empty"),
  accountLoginHistoryMonths: $("#account-login-history-months"),
  accountLoginHistoryRefresh: $("#account-login-history-refresh"),
  accountLoginHistorySummary: $("#account-login-history-summary"),
  accountLoginHistoryBody: $("#account-login-history-body"),
  accountLoginHistoryEmpty: $("#account-login-history-empty"),
  accountLoginHistoryTruncated: $("#account-login-history-truncated"),
  accountBlockHistoryMonths: $("#account-block-history-months"),
  accountBlockHistoryRefresh: $("#account-block-history-refresh"),
  accountBlockHistorySummary: $("#account-block-history-summary"),
  accountBlockHistoryBody: $("#account-block-history-body"),
  accountBlockHistoryEmpty: $("#account-block-history-empty"),
  accountBlockHistoryTruncated: $("#account-block-history-truncated"),
  accountTotpIpBlockEnabled: $("#account-totp-ip-block-enabled"),
  accountTotpIpBlockThreshold: $("#account-totp-ip-block-threshold"),
  accountTotpIpBlockCurrentIp: $("#account-totp-ip-block-current-ip"),
  accountTotpIpBlockPassword: $("#account-totp-ip-block-password"),
  accountTotpIpBlockSave: $("#account-totp-ip-block-save"),
  accountTotpIpBlockStatus: $("#account-totp-ip-block-status"),
  accountTotpIpBlocksRefresh: $("#account-totp-ip-blocks-refresh"),
  accountTotpIpBlocksSummary: $("#account-totp-ip-blocks-summary"),
  accountTotpIpBlocksBody: $("#account-totp-ip-blocks-body"),
  accountTotpIpBlocksEmpty: $("#account-totp-ip-blocks-empty"),
  accountTotpIpUnblockPassword: $("#account-totp-ip-unblock-password"),
  accountCountryLoginMode: $("#account-country-login-mode"),
  accountCountryLoginCountry: $("#account-country-login-country"),
  accountCountryLoginAdd: $("#account-country-login-add"),
  accountCountryLoginSelected: $("#account-country-login-selected"),
  accountCountryLoginCurrentIp: $("#account-country-login-current-ip"),
  accountCountryLoginCurrentCountry: $("#account-country-login-current-country"),
  accountCountryLoginPassword: $("#account-country-login-password"),
  accountCountryLoginSave: $("#account-country-login-save"),
  accountCountryLoginStatus: $("#account-country-login-status"),
  accountVpnBlockEnabled: $("#account-vpn-block-enabled"),
  accountVpnBlockCurrentIp: $("#account-vpn-block-current-ip"),
  accountVpnBlockCurrentCountry: $("#account-vpn-block-current-country"),
  accountVpnBlockCurrentVerdict: $("#account-vpn-block-current-verdict"),
  accountVpnBlockCurrentSignals: $("#account-vpn-block-current-signals"),
  accountVpnBlockPassword: $("#account-vpn-block-password"),
  accountVpnBlockSave: $("#account-vpn-block-save"),
  accountVpnBlockStatus: $("#account-vpn-block-status"),
  sidebarUserAvatar: $("#sidebar-user-avatar"),
  sidebarUserAvatarFallback: $("#sidebar-user-avatar-fallback"),
  userUsername: $("#user-username"),
  settingsNavAvatar: $("#settings-nav-avatar"),
  settingsNavAvatarFallback: $("#settings-nav-avatar-fallback"),
  settingsNavName: $("#settings-nav-name"),
  settingsNavUsername: $("#settings-nav-username"),
  accountAvatarPreview: $("#account-avatar-preview"),
  accountAvatarFallback: $("#account-avatar-fallback"),
  accountAvatarInput: $("#account-avatar-input"),
  accountAvatarRemove: $("#account-avatar-remove"),
  accountProfileForm: $("#account-profile-form"),
  accountDisplayName: $("#account-display-name"),
  accountLoginId: $("#account-login-id"),
  accountProfileSave: $("#account-profile-save"),
  accountPasswordForm: $("#account-password-form"),
  accountCurrentPassword: $("#account-current-password"),
  accountNewPassword: $("#account-new-password"),
  accountConfirmPassword: $("#account-confirm-password"),
  accountPasswordSave: $("#account-password-save"),
  accountDataExport: $("#account-data-export"),
  accountDataInput: $("#account-data-input"),
  accountDataFileName: $("#account-data-file-name"),
  accountDataImport: $("#account-data-import"),
  accountMfaPassword: $("#account-mfa-password"),
  accountMfaSummary: $("#account-mfa-summary"),
  accountTotpStatus: $("#account-totp-status"),
  accountTotpSetup: $("#account-totp-setup"),
  accountTotpDisable: $("#account-totp-disable"),
  accountTotpSetupPanel: $("#account-totp-setup-panel"),
  accountTotpQr: $("#account-totp-qr"),
  accountTotpSecret: $("#account-totp-secret"),
  accountTotpVerifyForm: $("#account-totp-verify-form"),
  accountTotpCode: $("#account-totp-code"),
  accountTotpVerify: $("#account-totp-verify"),
  accountTotpCancel: $("#account-totp-cancel"),
  accountPasskeyCount: $("#account-passkey-count"),
  accountPasskeyRegisterForm: $("#account-passkey-register-form"),
  accountPasskeyName: $("#account-passkey-name"),
  accountPasskeyRegistrationTarget: $("#account-passkey-registration-target"),
  accountPasskeyRegistrationHelp: $("#account-passkey-registration-help"),
  accountPasskeyRegister: $("#account-passkey-register"),
  accountPasskeySupport: $("#account-passkey-support"),
  accountPasskeyList: $("#account-passkey-list"),
  authPanel: $("#auth-panel"),
  authHeader: $("#auth-panel .auth-header"),
  workspacePanel: $("#workspace-panel"),
  authForm: $("#auth-form"),
  mfaLoginPanel: $("#mfa-login-panel"),
  mfaLoginTotpForm: $("#mfa-login-totp-form"),
  mfaLoginCode: $("#mfa-login-code"),
  mfaLoginTotpSubmit: $("#mfa-login-totp-submit"),
  mfaLoginPasskey: $("#mfa-login-passkey"),
  mfaLoginDivider: $("#mfa-login-panel .mfa-login-divider"),
  mfaLoginCancel: $("#mfa-login-cancel"),
  authKicker: $("#auth-kicker"),
  authTitle: $("#auth-title"),
  authDescription: $("#auth-description"),
  authSubmit: $("#auth-submit"),
  authPasskeyLoginSection: $("#auth-passkey-login-section"),
  authPasskeyLogin: $("#auth-passkey-login"),
  authSwitchCopy: $("#auth-switch-copy"),
  authSwitchLink: $("#auth-switch-link"),
  registerFields: $("#register-fields"),
  username: $("#username"),
  password: $("#password"),
  name: $("#name"),
  userLabel: $("#user-label"),
  addCollectionButton: $("#add-collection-button"),
  logoutButton: $("#logout-button"),
  searchLayer: $("#search-layer"),
  searchBackdrop: $("#search-backdrop"),
  searchDialog: $("#search-dialog"),
  searchDialogClose: $("#search-dialog-close"),
  searchForm: $("#search-form"),
  searchInput: $("#search-input"),
  searchClear: $("#search-clear"),
  searchResults: $("#search-results"),
  searchResultCount: $("#search-result-count"),
  searchMessage: $("#search-message"),
  defaultCollectionButton: $("#default-collection-button"),
  defaultCollectionHeading: $("#default-collection-heading"),
  addDocumentButton: $("#add-document-button"),
  collectionCount: $("#collection-count"),
  pageList: $("#page-list"),
  collectionList: $("#collection-list"),
  status: $("#status"),
  welcomeView: $("#welcome-view"),
  homeNewPageButton: $("#home-new-page-button"),
  homeDocumentList: $("#home-document-list"),
  homeDocumentCount: $("#home-document-count"),
  homeCollectionList: $("#home-collection-list"),
  collectionView: $("#collection-view"),
  collectionIconButton: $("#collection-icon-button"),
  collectionViewTitle: $("#collection-view-title"),
  collectionViewList: $("#collection-view-list"),
  pageViewHeader: $("#page-view-header"),
  pagePath: $("#page-path"),
  pageActionsButton: $("#page-actions-button"),
  pageActionsMenu: $("#page-actions-menu"),
  pageModeToggle: $("#page-mode-toggle"),
  pageModeToggleIcon: $("#page-mode-toggle-icon"),
  pageModeToggleLabel: $("#page-mode-toggle-label"),
  pageModeToggleDescription: $("#page-mode-toggle-description"),
  pageVersionHistoryButton: $("#page-version-history-button"),
  pageVersionHistoryDialog: $("#page-version-history-dialog"),
  pageVersionHistoryClose: $("#page-version-history-close"),
  pageVersionHistoryCurrent: $("#page-version-history-current"),
  pageVersionHistoryPageTitle: $("#page-version-history-page-title"),
  pageVersionHistoryReset: $("#page-version-history-reset"),
  pageVersionHistoryMessage: $("#page-version-history-message"),
  pageVersionHistoryList: $("#page-version-history-list"),
  pageVersionHistoryMore: $("#page-version-history-more"),
  pageVersionHistoryDetailPanel: $("#page-version-history-detail-panel"),
  pageVersionHistoryDetailEmpty: $("#page-version-history-detail-empty"),
  pageVersionHistoryDetail: $("#page-version-history-detail"),
  pageModeBadge: $("#page-mode-badge"),
  pageModeBadgeLabel: $("#page-mode-badge-label"),
  pageView: $("#page-view"),
  pageCover: $("#page-cover"),
  pageCoverImage: $("#page-cover-image"),
  pageCoverControls: $("#page-cover-controls"),
  pageCoverAddButton: $("#page-cover-add-button"),
  pageCoverEmptyActions: $("#page-cover-empty-actions"),
  pageCoverChangeButton: $("#page-cover-change-button"),
  pageCoverPositionButton: $("#page-cover-position-button"),
  pageCoverRemoveButton: $("#page-cover-remove-button"),
  pageCoverPositionPanel: $("#page-cover-position-panel"),
  pageCoverPositionX: $("#page-cover-position-x"),
  pageCoverPositionY: $("#page-cover-position-y"),
  pageCoverPositionXOutput: $("#page-cover-position-x-output"),
  pageCoverPositionYOutput: $("#page-cover-position-y-output"),
  pageCoverPositionCancel: $("#page-cover-position-cancel"),
  pageCoverPositionSave: $("#page-cover-position-save"),
  pageCoverDialog: $("#page-cover-dialog"),
  pageCoverDialogClose: $("#page-cover-dialog-close"),
  pageCoverCustomButton: $("#page-cover-custom-button"),
  pageCoverCustomInput: $("#page-cover-custom-input"),
  pageKicker: $("#page-kicker"),
  pageIconButton: $("#page-icon-button"),
  pageTitle: $("#page-title"),
  subpageIndex: $("#subpage-index"),
  subpageIndexCount: $("#subpage-index-count"),
  subpageIndexList: $("#subpage-index-list"),
  collaborationIndicator: $("#collaboration-indicator"),
  collaborationStatusDot: $("#collaboration-status-dot"),
  collaborationStatusLabel: $("#collaboration-status-label"),
  collaborationPresence: $("#collaboration-presence"),
  sharePageButton: $("#share-page-button"),
  exportPdfButton: $("#export-pdf-button"),
  savePageButton: $("#save-page-button"),
  archivePageButton: $("#archive-page-button"),
  sharePageLayer: $("#share-page-layer"),
  sharePageBackdrop: $("#share-page-backdrop"),
  sharePageDialog: $("#share-page-dialog"),
  sharePageClose: $("#share-page-close"),
  sharePageForm: $("#share-page-form"),
  sharePageUsername: $("#share-page-username"),
  sharePageSubmit: $("#share-page-submit"),
  sharePageMessage: $("#share-page-message"),
  sharePageCount: $("#share-page-count"),
  sharePageList: $("#share-page-list"),
  blockEditorHelp: $("#block-editor-help"),
  blockCount: $("#block-count"),
  blockList: $("#block-list"),
  slashMenu: $("#slash-menu"),
  blockContextMenu: $("#block-context-menu"),
  navigationContextMenu: $("#navigation-context-menu"),
  navigationAddSubpageButton: $("#navigation-add-subpage-button"),
  navigationDeleteLabel: $("#navigation-delete-label"),
  calloutTypeGroup: $("#callout-type-group"),
  accordionOptionsGroup: $("#accordion-options-group"),
  inlineToolbar: $("#inline-toolbar"),
  emojiPickerLayer: $("#emoji-picker-layer"),
  emojiPicker: $("#emoji-picker"),
  emojiPickerClose: $("#emoji-picker-close"),
  emojiPickerTabs: $("#emoji-picker-tabs"),
  emojiTabEmojis: $("#emoji-tab-emojis"),
  emojiTabIcons: $("#emoji-tab-icons"),
  emojiTabCustom: $("#emoji-tab-custom"),
  emojiBrowserPanel: $("#emoji-browser-panel"),
  emojiCustomPanel: $("#emoji-custom-panel"),
  emojiSearchLabelText: $("#emoji-search-label-text"),
  emojiSearchInput: $("#emoji-search-input"),
  emojiRandomButton: $("#emoji-random-button"),
  emojiSkinToneButton: $("#emoji-skin-tone-button"),
  emojiSkinToneMenu: $("#emoji-skin-tone-menu"),
  emojiCategoryList: $("#emoji-category-list"),
  emojiRecentSection: $("#emoji-recent-section"),
  emojiRecentGrid: $("#emoji-recent-grid"),
  emojiResultsTitle: $("#emoji-results-title"),
  emojiResultsCount: $("#emoji-results-count"),
  emojiGrid: $("#emoji-grid"),
  emojiEmpty: $("#emoji-empty"),
  emojiResetButton: $("#emoji-reset-button"),
  emojiCustomPreview: $("#emoji-custom-preview"),
  emojiCustomLibraryGrid: $("#emoji-custom-library-grid"),
  emojiCustomLibraryEmpty: $("#emoji-custom-library-empty"),
  emojiCustomLibraryCount: $("#emoji-custom-library-count"),
  emojiCustomUrlInput: $("#emoji-custom-url-input"),
  emojiCustomUrlButton: $("#emoji-custom-url-button"),
  emojiCustomFileInput: $("#emoji-custom-file-input"),
  emojiCustomUploadButton: $("#emoji-custom-upload-button"),
  emojiCustomMessage: $("#emoji-custom-message")
};

const mobileSidebarFocusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(",");

function isMobileSidebarLayout() {
  return mobileSidebarMedia.matches && document.body.classList.contains("app-mode");
}

function isMobileSidebarOpen() {
  return isMobileSidebarLayout() && document.body.classList.contains("mobile-sidebar-open");
}

function suppressMobileSidebarTransition() {
  document.body.classList.add("mobile-sidebar-no-transition");
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => document.body.classList.remove("mobile-sidebar-no-transition"));
  });
}

function syncMobileSidebarAccessibility() {
  const mobileLayout = isMobileSidebarLayout();
  if (!mobileLayout) document.body.classList.remove("mobile-sidebar-open");

  const open = mobileLayout && document.body.classList.contains("mobile-sidebar-open");
  elements.mobileSidebarToggle.setAttribute("aria-expanded", String(open));
  elements.appSidebar.inert = mobileLayout && !open;
  elements.main.inert = open;

  if (mobileLayout) elements.appSidebar.setAttribute("aria-hidden", String(!open));
  else elements.appSidebar.removeAttribute("aria-hidden");
}

function getMobileSidebarFocusableElements() {
  return [...elements.appSidebar.querySelectorAll(mobileSidebarFocusableSelector)].filter((element) => {
    return !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0;
  });
}

function openMobileSidebar() {
  if (!isMobileSidebarLayout()) return;
  document.body.classList.add("mobile-sidebar-open");
  syncMobileSidebarAccessibility();
  window.requestAnimationFrame(() => elements.mobileSidebarClose.focus());
}

function closeMobileSidebar({ restoreFocus = false } = {}) {
  const wasOpen = document.body.classList.contains("mobile-sidebar-open");
  document.body.classList.remove("mobile-sidebar-open");
  syncMobileSidebarAccessibility();
  if (restoreFocus && wasOpen && isMobileSidebarLayout()) elements.mobileSidebarToggle.focus();
}

function toggleMobileSidebar() {
  if (isMobileSidebarOpen()) closeMobileSidebar({ restoreFocus: true });
  else openMobileSidebar();
}

function handleMobileSidebarKeydown(event) {
  if (!isMobileSidebarOpen()) return;

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMobileSidebar({ restoreFocus: true });
    return;
  }

  if (event.key !== "Tab") return;
  const focusableElements = getMobileSidebarFocusableElements();
  if (!focusableElements.length) {
    event.preventDefault();
    elements.appSidebar.focus();
    return;
  }

  const first = focusableElements[0];
  const last = focusableElements.at(-1);
  const activeElement = document.activeElement;
  if (event.shiftKey && (activeElement === first || !elements.appSidebar.contains(activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function beginAuthFlowOperation() {
  return authFlowOperationGuard.begin(authFlowTargetKey);
}

function isCurrentAuthFlowOperation(operation) {
  return authFlowOperationGuard.isCurrent(operation, authFlowTargetKey);
}

function isCurrentAuthenticatedSessionOperation(operation) {
  return Boolean(
    state.authenticated
      && authenticatedSessionOperationGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))
  );
}

function captureAuthenticatedSessionScope() {
  return Object.freeze({
    generation: authenticationSessionGeneration,
    targetKey: getAccountAvatarTargetKey(state.user)
  });
}

function isCurrentAuthenticatedSessionScope(scope) {
  return Boolean(
    scope
      && state.authenticated
      && scope.generation === authenticationSessionGeneration
      && scope.targetKey !== null
      && scope.targetKey === getAccountAvatarTargetKey(state.user)
  );
}

function acceptRotatedAuthenticationSession() {
  authenticationSessionGeneration += 1;
  accountSecurityOperationGuards.activeSessions.invalidate();
  state.activeSessions = { sessions: [], loading: false, loaded: false, revokingSessionId: null };
  pendingWorkspaceCreateTasks.clear();
  pendingPageVersionResetTasks.clear();
  pendingBlockCreateTasks.clear();
  pendingBlockDeleteTasks.clear();
  pendingAttachmentCreateTasks.clear();
  setWorkspaceCreateBusy(false);
  setAuthenticated(true);
}

function syncWorkspaceCreateControls() {
  const busy = state.workspaceCreateBusy;
  elements.addCollectionButton.disabled = busy;
  elements.homeNewPageButton.disabled = busy;
  elements.addDocumentButton.disabled = busy;
  elements.navigationAddSubpageButton.disabled = busy;
}

function setWorkspaceCreateBusy(busy) {
  state.workspaceCreateBusy = Boolean(busy);
  syncWorkspaceCreateControls();
}

function syncAuthOperationControls() {
  const busy = state.authOperationBusy;
  elements.authSubmit.disabled = busy;
  elements.authPasskeyLogin.disabled = busy || state.authMode !== "login" || !isWebAuthnSupported();
  elements.username.disabled = busy;
  elements.password.disabled = busy;
  elements.name.disabled = busy;
  elements.authSwitchLink.setAttribute("aria-disabled", String(busy));
  elements.authSwitchLink.tabIndex = busy ? -1 : 0;
  elements.mfaLoginTotpSubmit.disabled = busy;
  elements.mfaLoginPasskey.disabled = busy || !isWebAuthnSupported();
  elements.mfaLoginCancel.disabled = busy;
}

function setAuthOperationBusy(busy) {
  state.authOperationBusy = Boolean(busy);
  syncAuthOperationControls();
}

function isCurrentAccountDataOperation(operation) {
  return accountDataOperationGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user));
}

function syncAccountDataOperationControls() {
  const busy = state.accountDataOperationBusy;
  elements.accountDataExport.disabled = busy;
  elements.accountDataInput.disabled = busy;
  elements.accountDataImport.disabled = busy || !(elements.accountDataInput.files?.length);
  elements.accountSettingsClose.disabled = busy;
}

function setAccountDataOperationBusy(busy) {
  state.accountDataOperationBusy = Boolean(busy);
  syncAccountDataOperationControls();
}

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
  elements.authPasskeyLoginSection.classList.toggle("hidden", isRegister);
  elements.username.autocomplete = isRegister ? "username" : "username webauthn";
  elements.password.autocomplete = isRegister ? "new-password" : "current-password";

  if (updateHash) {
    const hash = isRegister ? "#signup" : "#login";
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }
  syncAuthOperationControls();
}

function clearStatus() {
  window.clearTimeout(statusClearTimer);
  statusClearTimer = null;
  elements.status.textContent = "";
  elements.status.classList.remove("error");
}

function setStatus(message, isError = false, { dismissAfter } = {}) {
  window.clearTimeout(statusClearTimer);
  statusClearTimer = null;

  const text = String(message ?? "").trim();
  elements.status.textContent = text;
  elements.status.classList.toggle("error", isError && Boolean(text));
  if (!text) return;

  const delay = dismissAfter ?? (isError ? statusErrorDismissDelay : statusDismissDelay);
  if (Number.isFinite(delay) && delay > 0) {
    statusClearTimer = window.setTimeout(clearStatus, delay);
  }
}

function setAuthenticated(value) {
  state.authenticated = Boolean(value);
}

function normalizeTheme(value) {
  return supportedThemes.has(value) ? value : "light";
}

function getActiveTheme() {
  return normalizeTheme(document.documentElement.dataset.theme);
}

function applyTheme(value, { persist = true } = {}) {
  const theme = normalizeTheme(value);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColorByTheme[theme]);

  if (persist) {
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // The authenticated server preference remains authoritative when storage
      // is unavailable (for example, in privacy-hardened browsing contexts).
    }
  }
  return theme;
}

function applyUserTheme() {
  return applyTheme(state.user?.theme);
}

function isWebAuthnSupported() {
  return Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
}

let webAuthnClientCapabilitiesPromise = null;

function getPasskeyRegistrationTarget() {
  return elements.accountPasskeyRegistrationTarget?.value === "remote" ? "remote" : "automatic";
}

function getWebAuthnClientCapabilities() {
  if (!isWebAuthnSupported() || typeof window.PublicKeyCredential.getClientCapabilities !== "function") {
    return Promise.resolve(null);
  }
  if (!webAuthnClientCapabilitiesPromise) {
    webAuthnClientCapabilitiesPromise = window.PublicKeyCredential.getClientCapabilities().catch(() => null);
  }
  return webAuthnClientCapabilitiesPromise;
}

async function refreshPasskeyRegistrationSupport() {
  const target = getPasskeyRegistrationTarget();
  const supported = isWebAuthnSupported();
  elements.accountPasskeyRegistrationHelp.textContent = t(
    target === "remote" ? "mfa.passkeyRegistrationRemoteHint" : "mfa.passkeyRegistrationAutomaticHint"
  );

  if (!supported) {
    elements.accountPasskeySupport.textContent = t("mfa.passkeyUnsupported");
    return;
  }
  if (target !== "remote") {
    elements.accountPasskeySupport.textContent = t("mfa.passkeyReady");
    return;
  }

  // WebAuthn Level 3 clients can report hybrid-transport support. Older
  // clients do not expose this API, so absence is treated as "unknown" rather
  // than "unsupported" and the standards-based hybrid request is still sent.
  const capabilities = await getWebAuthnClientCapabilities();
  if (getPasskeyRegistrationTarget() !== target) return;
  if (capabilities?.hybridTransport === false) {
    elements.accountPasskeySupport.textContent = t("mfa.passkeyHybridUnsupported");
  } else if (capabilities?.hybridTransport === true) {
    elements.accountPasskeySupport.textContent = t("mfa.passkeyHybridReady");
  } else {
    elements.accountPasskeySupport.textContent = t("mfa.passkeyHybridUnknown");
  }
}

function base64UrlToArrayBuffer(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = window.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function arrayBufferToBase64Url(value) {
  const bytes = new Uint8Array(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function prepareRegistrationOptions(options) {
  return {
    ...options,
    challenge: base64UrlToArrayBuffer(options.challenge),
    user: { ...options.user, id: base64UrlToArrayBuffer(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((credential) => ({
      ...credential,
      id: base64UrlToArrayBuffer(credential.id)
    }))
  };
}

function prepareAuthenticationOptions(options) {
  return {
    ...options,
    challenge: base64UrlToArrayBuffer(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
      ...credential,
      id: base64UrlToArrayBuffer(credential.id)
    }))
  };
}

function serializeRegistrationCredential(credential) {
  const response = credential.response;
  const serialized = {
    id: credential.id,
    rawId: arrayBufferToBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: arrayBufferToBase64Url(response.clientDataJSON),
      attestationObject: arrayBufferToBase64Url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : undefined
    }
  };
  if (credential.authenticatorAttachment) serialized.authenticatorAttachment = credential.authenticatorAttachment;
  if (typeof response.getAuthenticatorData === "function") {
    const authenticatorData = response.getAuthenticatorData();
    if (authenticatorData) serialized.response.authenticatorData = arrayBufferToBase64Url(authenticatorData);
  }
  if (typeof response.getPublicKey === "function") {
    const publicKey = response.getPublicKey();
    if (publicKey) serialized.response.publicKey = arrayBufferToBase64Url(publicKey);
  }
  if (typeof response.getPublicKeyAlgorithm === "function") {
    serialized.response.publicKeyAlgorithm = response.getPublicKeyAlgorithm();
  }
  return serialized;
}

function serializeAuthenticationCredential(credential) {
  const response = credential.response;
  const serialized = {
    id: credential.id,
    rawId: arrayBufferToBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: arrayBufferToBase64Url(response.clientDataJSON),
      authenticatorData: arrayBufferToBase64Url(response.authenticatorData),
      signature: arrayBufferToBase64Url(response.signature)
    }
  };
  if (credential.authenticatorAttachment) serialized.authenticatorAttachment = credential.authenticatorAttachment;
  if (response.userHandle) serialized.response.userHandle = arrayBufferToBase64Url(response.userHandle);
  return serialized;
}

async function createWebAuthnCredential(options) {
  if (!isWebAuthnSupported()) throw new Error(t("mfa.passkeyUnsupported"));
  const credential = await navigator.credentials.create({ publicKey: prepareRegistrationOptions(options) });
  if (!credential) throw new Error(t("mfa.passkeyOperationCancelled"));
  return serializeRegistrationCredential(credential);
}

async function getWebAuthnCredential(options) {
  if (!isWebAuthnSupported()) throw new Error(t("mfa.passkeyUnsupported"));
  const credential = await navigator.credentials.get({ publicKey: prepareAuthenticationOptions(options) });
  if (!credential) throw new Error(t("mfa.passkeyOperationCancelled"));
  return serializeAuthenticationCredential(credential);
}

function normalizeWebAuthnError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
    return new Error(t("mfa.passkeyOperationCancelled"));
  }
  if (error?.name === "SecurityError") {
    return new Error(t("mfa.passkeySecurityError"));
  }
  return error instanceof Error ? error : new Error(t("errors.unknown"));
}

function normalizePasskeyRegistrationError(error, registrationTarget) {
  if (registrationTarget === "remote") {
    if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
      return new Error(t("mfa.passkeyRemoteOperationCancelled"));
    }
    if (error?.name === "NotSupportedError") {
      return new Error(t("mfa.passkeyRemoteUnsupported"));
    }
  }
  return normalizeWebAuthnError(error);
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatLoginCountry(countryCode) {
  const normalized = typeof countryCode === "string" ? countryCode.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(normalized)) return t("account.loginHistoryUnknownCountry");

  try {
    const label = new Intl.DisplayNames([getLocale()], { type: "region" }).of(normalized);
    return label && label !== normalized ? `${label} (${normalized})` : normalized;
  } catch {
    return normalized;
  }
}

function translateApiError(data, status) {
  const code = data?.error?.code;
  if (code && t(`errors.${code}`) !== `errors.${code}`) return t(`errors.${code}`);
  if (status >= 500) return t("errors.INTERNAL_SERVER_ERROR");
  return data?.error?.message ?? data?.message ?? t("errors.unknown");
}

function createApiRequestError(message, { status = 0, code = null, ambiguous = false } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.ambiguous = ambiguous;
  return error;
}

function isAmbiguousApiError(error) {
  const status = Number(error?.status ?? 0);
  return error?.ambiguous === true || status === 0 || status >= 500;
}

function isDefinitiveApiError(error) {
  const status = Number(error?.status ?? 0);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

function canSupersedeBlockSaveError(error) {
  return isDefinitiveApiError(error) && error?.code === "BLOCK_METADATA_WOULD_TRUNCATE";
}

function getBrowserTimeZone() {
  try {
    const value = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
  } catch {
    return null;
  }
}

async function applyClientNetworkVerificationHeaders(headers) {
  const browserTimeZone = getBrowserTimeZone();
  if (browserTimeZone && !headers.has("X-BrainVault-Timezone")) {
    headers.set("X-BrainVault-Timezone", browserTimeZone);
  }
  if (!headers.has("X-BrainVault-WebRTC-State")) {
    const webRtcSignal = await getWebRtcNetworkSignal();
    applyWebRtcNetworkSignalHeaders(headers, webRtcSignal);
  }
  return headers;
}

async function api(path, options = {}) {
  const { skipAuthReset = false, ...requestOptions } = options;
  const authenticationScope = captureAuthenticatedSessionScope();
  const headers = new Headers(requestOptions.headers ?? {});
  await applyClientNetworkVerificationHeaders(headers);

  let body = requestOptions.body;
  if (body && typeof body === "object" && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, { ...requestOptions, credentials: "include", headers, body });
  } catch {
    throw createApiRequestError(t("errors.network"), { ambiguous: true });
  }
  if (response.status === 204) return null;

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw createApiRequestError(t("errors.invalidResponse"), {
      status: response.status,
      ambiguous: response.ok || response.status >= 500
    });
  }

  if (!response.ok) {
    const authenticationDenied = response.status === 401
      || (response.status === 403 && (
        data?.error?.code === "COUNTRY_LOGIN_BLOCKED"
        || data?.error?.code === "VPN_ACCESS_BLOCKED"
        || data?.error?.code === "TOTP_IP_PERMANENTLY_BLOCKED"
      ));
    if (
      authenticationDenied
      && !skipAuthReset
      && isCurrentAuthenticatedSessionScope(authenticationScope)
    ) {
      resetAuthenticationSessionState();
    }
    throw createApiRequestError(translateApiError(data, response.status), {
      status: response.status,
      code: data?.error?.code ?? null,
      ambiguous: response.status >= 500
    });
  }

  return data;
}

function enqueueAccountProfilePatch(targetKey, body, { before } = {}) {
  const payload = Object.freeze({ ...body });
  return accountProfileMutationQueue.enqueue(targetKey, async () => {
    if (typeof before === "function") await before();
    return api("/api/auth/profile", { method: "PATCH", body: payload });
  });
}

async function loadNavigationPreferences() {
  const data = await api("/api/auth/navigation-preferences");
  if (
    !Array.isArray(data?.collapsedPageIds)
    || data.collapsedPageIds.some((pageId) => typeof pageId !== "string" || !pageId)
    || !Array.isArray(data?.navigationPageOrder)
    || data.navigationPageOrder.some((item) => (
      !item
      || typeof item.pageId !== "string"
      || !item.pageId
      || !Number.isSafeInteger(item.sortOrder)
      || item.sortOrder < 0
    ))
  ) {
    throw new Error(t("errors.invalidResponse"));
  }

  const navigationPageOrder = new Map();
  for (const item of data.navigationPageOrder) {
    if (navigationPageOrder.has(item.pageId)) throw new Error(t("errors.invalidResponse"));
    navigationPageOrder.set(item.pageId, item.sortOrder);
  }
  state.collapsedNavigationPageIds = new Set(data.collapsedPageIds);
  state.navigationPageOrder = navigationPageOrder;
}

function discardNavigationPreferenceSaves() {
  for (const queue of navigationPreferenceSaveQueues.values()) queue.discard();
  navigationPreferenceSaveQueues.clear();
}

function getNavigationPreferenceSaveQueue(pageId) {
  let queue = navigationPreferenceSaveQueues.get(pageId);
  if (queue) return queue;

  queue = createLatestWriteQueue(
    async (task) => {
      if (!isCurrentAuthenticatedSessionScope(task.authenticationScope)) return null;
      return api("/api/auth/navigation-preferences", {
        method: "PATCH",
        keepalive: true,
        body: { pageId: task.pageId, collapsed: task.collapsed }
      });
    },
    { shouldRetry: () => false }
  );
  navigationPreferenceSaveQueues.set(pageId, queue);
  return queue;
}

function persistNavigationPreference(pageId, collapsed) {
  const authenticationScope = captureAuthenticatedSessionScope();
  if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return;
  const queue = getNavigationPreferenceSaveQueue(pageId);
  queue.enqueue({ pageId, collapsed, authenticationScope }).catch((error) => {
    if (isCurrentAuthenticatedSessionScope(authenticationScope)) setStatus(error.message, true);
  });
}

const pageTitleSaveQueue = createLatestWriteQueue(async (task) => {
  const currentPage = state.selectedPage?.id === task.pageId
    ? state.selectedPage
    : state.allPages.find((page) => page.id === task.pageId);
  const storedExpectedVersion = task.userId
    ? pageDraftStore.loadPage(task.userId, task.pageId, task.draftSourceId)?.title?.expectedVersion
    : null;
  const expectedVersion = getLatestKnownVersion(
    state.selectedPage?.id === task.pageId ? pageTitleDraftExpectedVersion : null,
    storedExpectedVersion,
    task.expectedVersion,
    currentPage?.version
  );
  const data = await submitWithFreshMutationIdOnReuse(task, () =>
    api(`/api/pages/${task.pageId}`, {
      method: "PATCH",
      keepalive: task.keepalive === true,
      body: { title: task.title, expectedVersion, mutationId: task.mutationId }
    })
  );

  if (task.userId) {
    checkDraftStoreWrite(
      pageDraftStore.acknowledgeTitle({
        userId: task.userId,
        pageId: task.pageId,
        sourceId: task.draftSourceId,
        revision: task.editRevision,
        nextExpectedVersion: data.page.version
      })
    );
    if (task.recoveredConflictOrigin) {
      const removed = checkDraftStoreWrite(
        pageDraftStore.removeTitleIfUnchanged({
          userId: task.userId,
          pageId: task.pageId,
          ...task.recoveredConflictOrigin
        })
      );
      if (removed && pageTitleConflictOrigin === task.recoveredConflictOrigin) pageTitleConflictOrigin = null;
    }
  }

  const latestStoredTitle = task.userId
    ? pageDraftStore.loadPage(task.userId, task.pageId, task.draftSourceId)?.title
    : null;
  const hasNewerLocalTitle =
    state.selectedPage?.id === task.pageId &&
    (pageTitleEditRevision > task.editRevision || pageTitleTaskId > task.taskId);
  const committedPage = rebaseCommittedPageTitle(
    data.page,
    hasNewerLocalTitle ? latestStoredTitle?.value ?? normalizePageTitle(elements.pageTitle.value) : null
  );

  if (state.selectedPage?.id === task.pageId) {
    const currentBlocks = state.selectedPage.blocks;
    state.selectedPage = { ...committedPage, blocks: currentBlocks };
    applyPageSummaryUpdate(committedPage.id, {
      title: committedPage.title,
      version: committedPage.version,
      updatedAt: committedPage.updatedAt
    });
    renderPageHeader(state.selectedPage);
  }
  if (pageTitleTaskId === task.taskId && pageTitleEditRevision === task.editRevision) {
    pageTitleSavedRevision = task.editRevision;
    pageTitleDraftExpectedVersion = null;
    pageTitleDraftSourceId = pageDraftSourceId;
  } else if (hasNewerLocalTitle) {
    pageTitleDraftExpectedVersion = getPositiveVersion(data.page.version);
  }
  return { ...data, page: committedPage };
}, { shouldRetry: isAmbiguousApiError });

async function downloadAttachment(block) {
  const authenticationScope = captureAuthenticatedSessionScope();
  if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };

  const attachment = getBlockAttachmentData(block);
  const headers = new Headers();
  await applyClientNetworkVerificationHeaders(headers);

  let response;
  try {
    response = await fetch(`/api/blocks/${block.id}/attachment`, { headers, credentials: "include" });
  } catch {
    if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };
    throw new Error(t("errors.network"));
  }

  if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };
  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      // Use the localized fallback below when the response is not JSON.
    }
    if (
      response.status === 401
      && isCurrentAuthenticatedSessionScope(authenticationScope)
    ) {
      resetAuthenticationSessionState();
    }
    if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };
    throw new Error(translateApiError(data, response.status));
  }

  const blob = await response.blob();
  if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = attachment.originalName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  return { applied: true };
}

function getResponseFilename(response, fallback) {
  const contentDisposition = response.headers.get("content-disposition") ?? "";
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      // Fall back to the simple filename below.
    }
  }
  const quotedMatch = contentDisposition.match(/filename="([^"]+)"/i);
  return quotedMatch?.[1] || fallback;
}

async function downloadUserDataBackup({ operation = null } = {}) {
  const authenticationScope = captureAuthenticatedSessionScope();
  const targetKey = getAccountAvatarTargetKey(state.user);
  const activeOperation = operation ?? accountDataOperationGuard.begin(targetKey);
  if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };

  return withPageEditLock(async () =>
    withWorkspacePersistenceTransition("data-export", async () => {
      const ownedPageIds = await fetchOwnedWorkspacePageIds();
      if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };
      // A successful server export is still incomplete when another tab has a
      // browser-only direct draft or Yjs recovery snapshot. Require every local
      // editor to finish synchronization before generating the archive.
      assertNoPendingLocalPageDraftsForPages(ownedPageIds);
      assertNoPendingLocalCollaborationRecoveryForPages(ownedPageIds);

      const headers = new Headers();
      await applyClientNetworkVerificationHeaders(headers);
      let response;
      try {
        response = await fetch("/api/data/export", { headers, credentials: "include" });
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
        if (
          response.status === 401
          && isCurrentAuthenticatedSessionScope(authenticationScope)
        ) {
          resetAuthenticationSessionState();
        }
        if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };
        throw new Error(translateApiError(data, response.status));
      }

      const expectedLength = response.headers.get("content-length");
      if (!expectedLength || !/^\d+$/.test(expectedLength)) {
        throw new Error(t("errors.invalidResponse"));
      }
      const blob = await response.blob();
      if (BigInt(blob.size) !== BigInt(expectedLength)) {
        throw new Error(t("errors.invalidResponse"));
      }
      if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = getResponseFilename(response, `BrainVault-backup-${new Date().toISOString().slice(0, 10)}.zip`);
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      return { applied: true };
    })
  );
}

function resetDataImportSelection() {
  elements.accountDataInput.value = "";
  elements.accountDataFileName.textContent = t("account.noBackupSelected");
  syncAccountDataOperationControls();
}

async function restoreUserDataBackup(file, { operation = null } = {}) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  const activeOperation = operation ?? accountDataOperationGuard.begin(targetKey);
  if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };

  return withPageEditLock(async () =>
    withWorkspacePersistenceTransition("data-restore", async () => {
      const ownedPageIds = await fetchOwnedWorkspacePageIds();
      if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };
      // The server detects changes that reached SQL/Yjs persistence, but it cannot
      // see direct drafts or a full-document recovery snapshot that exists only in
      // another tab's localStorage. Recheck after every same-origin editor has had
      // a chance to flush, before replacing the owned workspace.
      assertNoPendingLocalPageDraftsForPages(ownedPageIds, "status.destructiveLocalDraftsPending");
      assertNoPendingLocalCollaborationRecoveryForPages(ownedPageIds);

      const formData = new FormData();
      formData.append("backup", file, file.name);
      const data = await api("/api/data/import", { method: "POST", body: formData });
      if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };
      if (getAccountAvatarTargetKey(data?.user) !== targetKey) {
        throw new Error(t("errors.invalidResponse"));
      }
      // Preserve durable drafts from every tab. Restored rows receive fresh edit versions,
      // so pre-restore drafts are recovered as explicit conflicts instead of overwriting data.
      state.user = data.user;
      applyUserTheme();
      await applyUserPreferredLanguage();
      if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };
      fillAccountSettings();
      resetSearchDialogState();
      state.searchQuery = "";
      state.activeTag = "";
      const pages = await fetchAllPageSummaries();
      if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };
      await loadNavigationPreferences();
      if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };
      state.pages = pages;
      state.allPages = pages;
      renderPages();
      await showHome({ skipFlush: true });
      if (!isCurrentAccountDataOperation(activeOperation)) return { applied: false };
      return { applied: true, counts: data.counts };
    })
  );
}

function getUserInitials(user = state.user) {
  const source = user?.name?.trim() || user?.username?.trim() || "BV";
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)[0]}` : source.slice(0, 2)).toUpperCase();
}

function renderUserAvatar(image, fallback, avatarData = state.user?.avatarData, initials = getUserInitials()) {
  const hasAvatar = typeof avatarData === "string" && avatarData.startsWith("data:image/");
  image.classList.toggle("hidden", !hasAvatar);
  if (hasAvatar) image.src = avatarData;
  else image.removeAttribute("src");
  fallback.classList.toggle("hidden", hasAvatar);
  fallback.textContent = initials;
}

function updateUserIdentityUi() {
  if (!state.user) return;
  const displayName = state.user.name?.trim() || state.user.username;
  const initials = getUserInitials(state.user);
  elements.userLabel.textContent = displayName;
  elements.userUsername.textContent = `@${state.user.username}`;
  elements.settingsNavName.textContent = displayName;
  elements.settingsNavUsername.textContent = `@${state.user.username}`;
  elements.accountSettingsTrigger.setAttribute("aria-label", `${t("account.open")}: ${displayName}`);
  renderUserAvatar(elements.sidebarUserAvatar, elements.sidebarUserAvatarFallback, state.user.avatarData, initials);
  renderUserAvatar(elements.settingsNavAvatar, elements.settingsNavAvatarFallback, state.user.avatarData, initials);
}

function renderShell() {
  const authenticated = Boolean(state.authenticated && state.user);
  document.body.classList.remove("boot-mode");
  const enteringMobileApp = authenticated && mobileSidebarMedia.matches && !document.body.classList.contains("app-mode");
  if (enteringMobileApp) suppressMobileSidebarTransition();
  if (!authenticated && state.searchDialogOpen) closeSearchDialog({ restoreFocus: false });
  if (!authenticated && state.accountSettingsOpen) closeAccountSettings({ restoreFocus: false });
  document.body.classList.toggle("auth-mode", !authenticated);
  document.body.classList.toggle("app-mode", authenticated);
  elements.authPanel.classList.toggle("hidden", authenticated);
  elements.workspacePanel.classList.toggle("hidden", !authenticated);
  if (authenticated) updateUserIdentityUi();
  syncMobileSidebarAccessibility();
}

function resetAuthenticationSessionState({ render = true } = {}) {
  workspaceNavigationGeneration += 1;
  authenticationSessionGeneration += 1;
  authFlowOperationGuard.invalidate();
  authenticatedSessionOperationGuard.invalidate();
  accountDataOperationGuard.invalidate();
  pageEditLockGeneration += 1;
  if (activePageTransitionLease) {
    pageTransitionLock.release(activePageTransitionLease);
    activePageTransitionLease = null;
  }
  void destroyPageCollaboration({ flush: false });
  closeSharePageDialog({ restoreFocus: false });
  closeSearchDialog({ restoreFocus: false });
  closePageVersionHistory({ restoreFocus: false });
  closePageCoverDialog();
  closePageCoverPositionEditor();
  // Input handlers persist durable per-account drafts before enqueueing writes. Keep those
  // records, but never carry live editor state or retry queues across an auth boundary.
  discardPendingPageEdits();
  pendingWorkspaceCreateTasks.clear();
  pendingPageVersionResetTasks.clear();
  pendingBlockCreateTasks.clear();
  pendingBlockDeleteTasks.clear();
  pendingAttachmentCreateTasks.clear();
  discardNavigationPreferenceSaves();
  closeAccountSettings({ restoreFocus: false, force: true });
  closeEmojiPicker({ restoreFocus: false });
  closeNavigationContextMenu();
  closeBlockContextMenu();
  closePageActionsMenu();
  closeInlineToolbar();
  closeSlashMenu();
  closeMobileSidebar();
  resetMfaLogin();
  setAuthenticated(false);
  state.user = null;
  state.pages = [];
  state.allPages = [];
  state.selectedPage = null;
  state.pageMode = pageModes.READ;
  state.pageModeChanging = false;
  state.pageEditLockDepth = 0;
  state.authOperationBusy = false;
  state.accountDataOperationBusy = false;
  state.workspaceCreateBusy = false;
  state.workspaceView = "home";
  state.activeCollectionId = null;
  state.activeTag = "";
  state.searchQuery = "";
  state.searchResults = [];
  state.searchLoading = false;
  state.searchSubmittedQuery = "";
  state.searchRequestId += 1;
  state.collapsedNavigationPageIds = new Set();
  state.navigationPageOrder = new Map();
  const navigationDrag = activeNavigationDrag;
  activeNavigationDrag = null;
  if (navigationDrag?.handle?.hasPointerCapture?.(navigationDrag.pointerId)) {
    navigationDrag.handle.releasePointerCapture(navigationDrag.pointerId);
  }
  clearNavigationDragVisuals(navigationDrag);
  navigationOrderSaving = false;
  state.pendingFocusBlockId = null;
  resetAccountSecurityOperationState({ clearSensitiveState: true });
  accountProfileSaveGuard.invalidate();
  accountLanguageOperationGuard.invalidate();
  accountThemeOperationGuard.invalidate();
  accountProfileMutationQueue.invalidate();
  state.pendingAvatarData = null;
  state.accountAvatarPreparing = false;
  state.accountProfileSaving = false;
  state.activeSecurityPanel = "settings";
  elements.searchInput.value = "";
  syncAuthOperationControls();
  syncAccountDataOperationControls();
  syncWorkspaceCreateControls();

  if (render) {
    renderShell();
    renderSelectedPage();
  }
}

function setAccountMessage(message = "", isError = false) {
  elements.accountSettingsMessage.textContent = message;
  elements.accountSettingsMessage.classList.toggle("error", isError);
}

function isCurrentAccountSecurityOperation(guard, operation) {
  return Boolean(
    state.accountSettingsOpen
      && guard.isCurrent(operation, getAccountAvatarTargetKey(state.user))
  );
}

function resetAccountSecurityOperationState({ clearSensitiveState = false } = {}) {
  Object.values(accountSecurityOperationGuards).forEach((guard) => guard.invalidate());
  state.activeSessions.loading = false;
  state.activeSessions.loaded = false;
  state.activeSessions.revokingSessionId = null;
  state.loginHistory.loading = false;
  state.loginHistory.loadedMonths = null;
  state.blockHistory.loading = false;
  state.blockHistory.loadedMonths = null;
  state.totpIpBlockPolicy.loading = false;
  state.totpIpBlockPolicy.saving = false;
  state.totpIpBlockPolicy.loaded = false;
  state.totpIpBlocks.loading = false;
  state.totpIpBlocks.loaded = false;
  state.totpIpBlocks.unblockingIp = null;
  state.countryLoginPolicy.loading = false;
  state.countryLoginPolicy.saving = false;
  state.countryLoginPolicy.loaded = false;
  state.vpnBlockPolicy.loading = false;
  state.vpnBlockPolicy.saving = false;
  state.vpnBlockPolicy.loaded = false;

  if (clearSensitiveState) {
    const months = state.loginHistory.months || 3;
    const blockMonths = state.blockHistory.months || 3;
    state.activeSessions = { sessions: [], loading: false, loaded: false, revokingSessionId: null };
    state.loginHistory = { months, attempts: [], truncated: false, loading: false, loadedMonths: null };
    state.blockHistory = { months: blockMonths, blocks: [], truncated: false, loading: false, loadedMonths: null };
    state.totpIpBlockPolicy = {
      enabled: false,
      maxAttempts: 3,
      minAttempts: 1,
      maxAllowedAttempts: 8,
      currentIp: "unknown",
      loading: false,
      saving: false,
      loaded: false
    };
    state.totpIpBlocks = { blocks: [], loading: false, loaded: false, unblockingIp: null };
    state.countryLoginPolicy = {
      mode: "OFF",
      countries: [],
      currentIp: "unknown",
      currentCountryCode: null,
      loading: false,
      saving: false,
      loaded: false
    };
    state.vpnBlockPolicy = {
      enabled: false,
      currentIp: "unknown",
      currentCountryCode: null,
      verdict: "UNKNOWN",
      confidence: 0,
      datacenter: false,
      timezoneMismatch: false,
      providerCount: 0,
      webRtcState: "ABSENT",
      webRtcObservedIps: [],
      webRtcIpMismatch: false,
      supportingSignals: [],
      loading: false,
      saving: false,
      loaded: false
    };
    state.mfaStatus = { totpEnabled: false, passkeys: [] };
    hideTotpSetup();
  }

  elements.accountPasswordSave.disabled = false;
  elements.accountTotpSetup.disabled = false;
  elements.accountTotpVerify.disabled = false;
  elements.accountTotpDisable.disabled = false;
  elements.accountTotpIpBlockPassword.value = "";
  elements.accountTotpIpUnblockPassword.value = "";
  elements.accountCountryLoginPassword.value = "";
  elements.accountVpnBlockPassword.value = "";
  setAccountPasskeyRegistering(false);
}

function populateLoginHistoryMonths() {
  const selectedMonths = Number(elements.accountLoginHistoryMonths.value) || state.loginHistory.months || 3;
  elements.accountLoginHistoryMonths.replaceChildren(
    ...Array.from({ length: 12 }, (_, index) => {
      const option = document.createElement("option");
      option.value = String(index + 1);
      option.textContent = t("account.loginHistoryMonths", { count: formatNumber(index + 1) });
      return option;
    })
  );
  elements.accountLoginHistoryMonths.value = String(Math.min(12, Math.max(1, selectedMonths)));
}

function populateBlockHistoryMonths() {
  const selectedMonths = Number(elements.accountBlockHistoryMonths.value) || state.blockHistory.months || 3;
  elements.accountBlockHistoryMonths.replaceChildren(
    ...Array.from({ length: 12 }, (_, index) => {
      const option = document.createElement("option");
      option.value = String(index + 1);
      option.textContent = t("account.blockHistoryMonths", { count: formatNumber(index + 1) });
      return option;
    })
  );
  elements.accountBlockHistoryMonths.value = String(Math.min(12, Math.max(1, selectedMonths)));
}

function getCountryLoginCountryLabel(countryCode) {
  const normalized = typeof countryCode === "string" ? countryCode.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(normalized)) return normalized;
  try {
    const label = new Intl.DisplayNames([getLocale()], { type: "region" }).of(normalized);
    return label && label !== normalized ? `${label} (${normalized})` : normalized;
  } catch {
    return normalized;
  }
}

function populateCountryLoginCountryOptions() {
  const previousValue = elements.accountCountryLoginCountry.value;
  const options = isoCountryCodes
    .map((countryCode) => ({ countryCode, label: getCountryLoginCountryLabel(countryCode) }))
    .sort((left, right) => left.label.localeCompare(right.label, getLocale()));

  elements.accountCountryLoginCountry.replaceChildren(
    ...options.map(({ countryCode, label }) => {
      const option = document.createElement("option");
      option.value = countryCode;
      option.textContent = label;
      return option;
    })
  );
  if (options.some(({ countryCode }) => countryCode === previousValue)) {
    elements.accountCountryLoginCountry.value = previousValue;
  }
}

function getActiveSessionDeviceTypeLabel(deviceType) {
  const key = deviceType === "mobile"
    ? "account.activeSessionsDeviceMobile"
    : deviceType === "tablet"
      ? "account.activeSessionsDeviceTablet"
      : deviceType === "desktop"
        ? "account.activeSessionsDeviceDesktop"
        : "account.activeSessionsDeviceOther";
  return t(key);
}

function renderActiveSessions() {
  const { sessions, loading, revokingSessionId } = state.activeSessions;
  elements.accountActiveSessionsBody.replaceChildren();
  elements.accountActiveSessionsEmpty.classList.add("hidden");
  elements.accountActiveSessionsRefresh.disabled = loading || Boolean(revokingSessionId);

  if (loading) {
    const row = document.createElement("tr");
    row.className = "login-history-loading";
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = t("account.activeSessionsLoading");
    row.append(cell);
    elements.accountActiveSessionsBody.append(row);
    elements.accountActiveSessionsSummary.textContent = t("account.activeSessionsLoading");
    return;
  }

  sessions.forEach((session) => {
    const row = document.createElement("tr");
    if (session.isCurrent) row.classList.add("active-session-current-row");

    const deviceCell = document.createElement("td");
    const device = document.createElement("div");
    device.className = "active-session-device";
    const browser = document.createElement("strong");
    const browserLabel = session.browserName === "Unknown browser"
      ? t("account.activeSessionsUnknownBrowser")
      : session.browserLabel || session.browserName || t("account.activeSessionsUnknownBrowser");
    const osLabel = session.osName === "Unknown OS"
      ? t("account.activeSessionsUnknownOs")
      : session.osName || t("account.activeSessionsUnknownOs");
    browser.textContent = browserLabel;
    const details = document.createElement("small");
    details.textContent = `${osLabel} · ${getActiveSessionDeviceTypeLabel(session.deviceType)}`;
    device.append(browser, details);
    if (session.isCurrent) {
      const currentBadge = document.createElement("span");
      currentBadge.className = "active-session-current-badge";
      currentBadge.textContent = t("account.activeSessionsCurrent");
      device.append(currentBadge);
    }
    deviceCell.append(device);

    const ipCell = document.createElement("td");
    ipCell.textContent = session.ipAddress === "unknown" ? t("account.loginHistoryUnknownIp") : session.ipAddress;

    const lastActiveCell = document.createElement("td");
    lastActiveCell.textContent = formatDate(session.lastSeenAt);
    const signedInCell = document.createElement("td");
    signedInCell.textContent = formatDate(session.createdAt);

    const actionCell = document.createElement("td");
    const logoutButton = document.createElement("button");
    logoutButton.type = "button";
    logoutButton.className = "secondary danger compact active-session-logout";
    logoutButton.dataset.revokeSession = session.id;
    const revoking = revokingSessionId === session.id;
    logoutButton.disabled = Boolean(revokingSessionId);
    logoutButton.textContent = t(revoking ? "account.activeSessionsLoggingOut" : "account.activeSessionsLogout");
    actionCell.append(logoutButton);

    row.append(deviceCell, ipCell, lastActiveCell, signedInCell, actionCell);
    elements.accountActiveSessionsBody.append(row);
  });

  elements.accountActiveSessionsEmpty.classList.toggle("hidden", sessions.length > 0);
  elements.accountActiveSessionsSummary.textContent = t("account.activeSessionsSummary", {
    count: formatNumber(sessions.length)
  });
}

async function loadActiveSessions({ force = false } = {}) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || !state.accountSettingsOpen || state.activeSessions.loading || state.activeSessions.revokingSessionId) return;
  if (!force && state.activeSessions.loaded) {
    renderActiveSessions();
    return;
  }

  const operation = accountSecurityOperationGuards.activeSessions.begin(targetKey);
  state.activeSessions.loading = true;
  renderActiveSessions();
  setAccountMessage();
  try {
    const data = await api("/api/auth/sessions");
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.activeSessions, operation)) return;
    state.activeSessions.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    state.activeSessions.loaded = true;
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.activeSessions, operation)) return;
    state.activeSessions.sessions = [];
    state.activeSessions.loaded = false;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.activeSessions, operation)) {
      state.activeSessions.loading = false;
      renderActiveSessions();
    }
  }
}

async function revokeActiveSession(sessionId) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  const session = state.activeSessions.sessions.find((item) => item?.id === sessionId);
  if (!targetKey || !session || state.activeSessions.loading || state.activeSessions.revokingSessionId) return;

  const ip = session.ipAddress === "unknown" ? t("account.loginHistoryUnknownIp") : session.ipAddress;
  const confirmed = window.confirm(session.isCurrent
    ? t("account.activeSessionsCurrentLogoutConfirm")
    : t("account.activeSessionsLogoutConfirm", { browser: session.browserLabel || session.browserName, ip }));
  if (!confirmed) return;

  const run = async () => {
    const operation = accountSecurityOperationGuards.activeSessions.begin(targetKey);
    state.activeSessions.revokingSessionId = session.id;
    renderActiveSessions();
    setAccountMessage();
    try {
      const data = await api(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.activeSessions, operation)) return;
      if (data?.currentSession) {
        resetAuthenticationSessionState();
        setStatus(t("status.loggedOut"));
        return;
      }
      state.activeSessions.sessions = state.activeSessions.sessions.filter((item) => item.id !== session.id);
      state.activeSessions.loaded = true;
      setAccountMessage(t("account.activeSessionLoggedOut"));
    } catch (error) {
      if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.activeSessions, operation)) return;
      setAccountMessage(error.message, true);
    } finally {
      if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.activeSessions, operation)) {
        state.activeSessions.revokingSessionId = null;
        renderActiveSessions();
      }
    }
  };

  if (session.isCurrent) return withPageEditLock(run);
  return run();
}

function renderLoginHistory() {
  const { attempts, truncated, loading, months } = state.loginHistory;
  elements.accountLoginHistoryBody.replaceChildren();
  elements.accountLoginHistoryEmpty.classList.add("hidden");
  elements.accountLoginHistoryTruncated.classList.toggle("hidden", !truncated || loading);
  elements.accountLoginHistoryMonths.disabled = loading;
  elements.accountLoginHistoryRefresh.disabled = loading;

  if (loading) {
    const row = document.createElement("tr");
    row.className = "login-history-loading";
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = t("account.loginHistoryLoading");
    row.append(cell);
    elements.accountLoginHistoryBody.append(row);
    elements.accountLoginHistorySummary.textContent = t("account.loginHistoryLoading");
    return;
  }

  attempts.forEach((attempt) => {
    const row = document.createElement("tr");
    const timeCell = document.createElement("td");
    timeCell.textContent = formatDate(attempt.attemptedAt);
    const ipCell = document.createElement("td");
    ipCell.textContent = attempt.ipAddress === "unknown" ? t("account.loginHistoryUnknownIp") : attempt.ipAddress;
    const countryCell = document.createElement("td");
    countryCell.className = "login-history-country";
    countryCell.textContent = formatLoginCountry(attempt.countryCode);
    const resultCell = document.createElement("td");
    const result = document.createElement("span");
    const succeeded = attempt.outcome === "SUCCESS";
    const resultKey = succeeded
      ? "account.loginHistorySuccess"
      : attempt.outcome === "LOCKED"
        ? "account.loginHistoryLocked"
        : "account.loginHistoryFailure";
    result.className = `login-history-result ${succeeded ? "success" : "failure"}`;
    result.textContent = t(resultKey);
    resultCell.append(result);
    row.append(timeCell, ipCell, countryCell, resultCell);
    elements.accountLoginHistoryBody.append(row);
  });

  elements.accountLoginHistoryEmpty.classList.toggle("hidden", attempts.length > 0);
  elements.accountLoginHistorySummary.textContent = t("account.loginHistorySummary", {
    count: formatNumber(attempts.length),
    months: formatNumber(months)
  });
}

async function loadLoginHistory({ force = false } = {}) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || !state.accountSettingsOpen || state.loginHistory.loading) return;
  const months = Math.min(12, Math.max(1, Number(elements.accountLoginHistoryMonths.value) || 3));
  state.loginHistory.months = months;
  if (!force && state.loginHistory.loadedMonths === months) {
    renderLoginHistory();
    return;
  }

  const operation = accountSecurityOperationGuards.loginHistory.begin(targetKey);
  state.loginHistory.loading = true;
  renderLoginHistory();
  setAccountMessage();
  try {
    const data = await api(`/api/auth/login-history?months=${encodeURIComponent(months)}`);
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.loginHistory, operation)) return;
    state.loginHistory.attempts = Array.isArray(data?.attempts) ? data.attempts : [];
    state.loginHistory.truncated = Boolean(data?.truncated);
    state.loginHistory.loadedMonths = months;
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.loginHistory, operation)) return;
    state.loginHistory.attempts = [];
    state.loginHistory.truncated = false;
    state.loginHistory.loadedMonths = null;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.loginHistory, operation)) {
      state.loginHistory.loading = false;
      renderLoginHistory();
    }
  }
}

function renderBlockHistory() {
  const { blocks, truncated, loading, months } = state.blockHistory;
  elements.accountBlockHistoryBody.replaceChildren();
  elements.accountBlockHistoryEmpty.classList.add("hidden");
  elements.accountBlockHistoryTruncated.classList.toggle("hidden", !truncated || loading);
  elements.accountBlockHistoryMonths.disabled = loading;
  elements.accountBlockHistoryRefresh.disabled = loading;

  if (loading) {
    const row = document.createElement("tr");
    row.className = "login-history-loading";
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = t("account.blockHistoryLoading");
    row.append(cell);
    elements.accountBlockHistoryBody.append(row);
    elements.accountBlockHistorySummary.textContent = t("account.blockHistoryLoading");
    return;
  }

  const reasonTranslationKeys = {
    NOT_ALLOWLISTED: "account.blockHistoryNotAllowlisted",
    BLOCKLISTED: "account.blockHistoryBlacklisted",
    COUNTRY_UNRESOLVED: "account.blockHistoryCountryUnresolved",
    POLICY_INVALID: "account.blockHistoryPolicyInvalid",
    VPN_DETECTED: "account.blockHistoryVpnDetected",
    VPN_GATE_DETECTED: "account.blockHistoryVpnGateDetected",
    PROXY_DETECTED: "account.blockHistoryProxyDetected",
    TOR_DETECTED: "account.blockHistoryTorDetected",
    TOTP_ATTEMPTS_EXCEEDED: "account.blockHistoryTotpAttemptsExceeded"
  };

  blocks.forEach((block) => {
    const row = document.createElement("tr");
    const timeCell = document.createElement("td");
    timeCell.textContent = formatDate(block.blockedAt);
    const ipCell = document.createElement("td");
    ipCell.textContent = block.ipAddress === "unknown" ? t("account.loginHistoryUnknownIp") : block.ipAddress;
    const countryCell = document.createElement("td");
    countryCell.className = "login-history-country";
    countryCell.textContent = formatLoginCountry(block.countryCode);
    const reasonCell = document.createElement("td");
    const reason = document.createElement("span");
    reason.className = "login-history-result failure";
    reason.textContent = t(reasonTranslationKeys[block.reason] ?? "account.blockHistoryPolicyInvalid");
    reasonCell.append(reason);
    row.append(timeCell, ipCell, countryCell, reasonCell);
    elements.accountBlockHistoryBody.append(row);
  });

  elements.accountBlockHistoryEmpty.classList.toggle("hidden", blocks.length > 0);
  elements.accountBlockHistorySummary.textContent = t("account.blockHistorySummary", {
    count: formatNumber(blocks.length),
    months: formatNumber(months)
  });
}

async function loadBlockHistory({ force = false } = {}) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || !state.accountSettingsOpen || state.blockHistory.loading) return;
  const months = Math.min(12, Math.max(1, Number(elements.accountBlockHistoryMonths.value) || 3));
  state.blockHistory.months = months;
  if (!force && state.blockHistory.loadedMonths === months) {
    renderBlockHistory();
    return;
  }

  const operation = accountSecurityOperationGuards.blockHistory.begin(targetKey);
  state.blockHistory.loading = true;
  renderBlockHistory();
  setAccountMessage();
  try {
    const data = await api(`/api/auth/block-history?months=${encodeURIComponent(months)}`);
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.blockHistory, operation)) return;
    state.blockHistory.blocks = Array.isArray(data?.blocks) ? data.blocks : [];
    state.blockHistory.truncated = Boolean(data?.truncated);
    state.blockHistory.loadedMonths = months;
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.blockHistory, operation)) return;
    state.blockHistory.blocks = [];
    state.blockHistory.truncated = false;
    state.blockHistory.loadedMonths = null;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.blockHistory, operation)) {
      state.blockHistory.loading = false;
      renderBlockHistory();
    }
  }
}

function normalizeTotpIpBlockAttempts(value, fallback = 3) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(8, Math.max(1, parsed));
}

function applyTotpIpBlockPolicyResponse(data) {
  state.totpIpBlockPolicy.enabled = Boolean(data?.enabled);
  state.totpIpBlockPolicy.minAttempts = normalizeTotpIpBlockAttempts(data?.minAttempts, 1);
  state.totpIpBlockPolicy.maxAllowedAttempts = normalizeTotpIpBlockAttempts(data?.maxAllowedAttempts, 8);
  if (state.totpIpBlockPolicy.maxAllowedAttempts < state.totpIpBlockPolicy.minAttempts) {
    state.totpIpBlockPolicy.minAttempts = 1;
    state.totpIpBlockPolicy.maxAllowedAttempts = 8;
  }
  state.totpIpBlockPolicy.maxAttempts = Math.min(
    state.totpIpBlockPolicy.maxAllowedAttempts,
    Math.max(state.totpIpBlockPolicy.minAttempts, normalizeTotpIpBlockAttempts(data?.maxAttempts, 3))
  );
  state.totpIpBlockPolicy.currentIp = typeof data?.currentIp === "string" ? data.currentIp : "unknown";
}

function renderTotpIpBlockPolicy() {
  const policy = state.totpIpBlockPolicy;
  const busy = policy.loading || policy.saving;
  elements.accountTotpIpBlockEnabled.value = String(policy.enabled);
  elements.accountTotpIpBlockThreshold.min = String(policy.minAttempts);
  elements.accountTotpIpBlockThreshold.max = String(policy.maxAllowedAttempts);
  elements.accountTotpIpBlockThreshold.value = String(policy.maxAttempts);
  elements.accountTotpIpBlockCurrentIp.textContent = policy.currentIp === "unknown"
    ? t("account.loginHistoryUnknownIp")
    : policy.currentIp;
  elements.accountTotpIpBlockStatus.textContent = t(policy.enabled ? "account.totpIpBlockOn" : "account.totpIpBlockOff");
  elements.accountTotpIpBlockStatus.dataset.mode = policy.enabled ? "enabled" : "disabled";
  elements.accountTotpIpBlockEnabled.disabled = busy;
  elements.accountTotpIpBlockThreshold.disabled = busy;
  elements.accountTotpIpBlockPassword.disabled = busy;
  elements.accountTotpIpBlockSave.disabled = busy;
  elements.accountTotpIpBlockSave.textContent = t(policy.saving ? "account.totpIpBlockSaving" : "account.totpIpBlockSave");
}

async function loadTotpIpBlockPolicy({ force = false } = {}) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || !state.accountSettingsOpen || state.totpIpBlockPolicy.loading) return;
  if (!force && state.totpIpBlockPolicy.loaded) {
    renderTotpIpBlockPolicy();
    return;
  }

  const operation = accountSecurityOperationGuards.totpIpPolicy.begin(targetKey);
  state.totpIpBlockPolicy.loading = true;
  renderTotpIpBlockPolicy();
  setAccountMessage();
  try {
    const data = await api("/api/auth/totp-ip-block-policy");
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpPolicy, operation)) return;
    applyTotpIpBlockPolicyResponse(data);
    state.totpIpBlockPolicy.loaded = true;
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpPolicy, operation)) return;
    state.totpIpBlockPolicy.loaded = false;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpPolicy, operation)) {
      state.totpIpBlockPolicy.loading = false;
      renderTotpIpBlockPolicy();
    }
  }
}

async function saveTotpIpBlockPolicy() {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || state.totpIpBlockPolicy.loading || state.totpIpBlockPolicy.saving) return;
  const enabled = elements.accountTotpIpBlockEnabled.value === "true";
  const maxAttempts = Math.min(
    state.totpIpBlockPolicy.maxAllowedAttempts,
    Math.max(
      state.totpIpBlockPolicy.minAttempts,
      normalizeTotpIpBlockAttempts(elements.accountTotpIpBlockThreshold.value, state.totpIpBlockPolicy.maxAttempts)
    )
  );

  const operation = accountSecurityOperationGuards.totpIpPolicy.begin(targetKey);
  state.totpIpBlockPolicy.enabled = enabled;
  state.totpIpBlockPolicy.maxAttempts = maxAttempts;
  state.totpIpBlockPolicy.saving = true;
  renderTotpIpBlockPolicy();
  setAccountMessage();
  try {
    const data = await api("/api/auth/totp-ip-block-policy", {
      method: "PUT",
      body: {
        currentPassword: elements.accountTotpIpBlockPassword.value,
        enabled,
        maxAttempts
      }
    });
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpPolicy, operation)) return;
    acceptRotatedAuthenticationSession();
    applyTotpIpBlockPolicyResponse(data);
    state.totpIpBlockPolicy.loaded = true;
    elements.accountTotpIpBlockPassword.value = "";
    state.blockHistory.loadedMonths = null;
    setAccountMessage(t("account.totpIpBlockSaved"));
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpPolicy, operation)) return;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpPolicy, operation)) {
      state.totpIpBlockPolicy.saving = false;
      renderTotpIpBlockPolicy();
    }
  }
}

function renderPermanentTotpIpBlocks() {
  const { blocks, loading, unblockingIp } = state.totpIpBlocks;
  elements.accountTotpIpBlocksBody.replaceChildren();
  elements.accountTotpIpBlocksEmpty.classList.add("hidden");
  elements.accountTotpIpBlocksRefresh.disabled = loading || Boolean(unblockingIp);
  elements.accountTotpIpUnblockPassword.disabled = loading || Boolean(unblockingIp);

  if (loading) {
    const row = document.createElement("tr");
    row.className = "login-history-loading";
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = t("account.totpIpBlocksLoading");
    row.append(cell);
    elements.accountTotpIpBlocksBody.append(row);
    elements.accountTotpIpBlocksSummary.textContent = t("account.totpIpBlocksLoading");
    return;
  }

  blocks.forEach((block) => {
    const row = document.createElement("tr");
    const timeCell = document.createElement("td");
    timeCell.textContent = formatDate(block.blockedAt);
    const ipCell = document.createElement("td");
    ipCell.textContent = block.ipAddress === "unknown" ? t("account.loginHistoryUnknownIp") : block.ipAddress;
    const attemptsCell = document.createElement("td");
    attemptsCell.textContent = formatNumber(Number(block.failedAttempts) || 0);
    const actionCell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary compact";
    button.dataset.unblockTotpIp = block.ipAddress;
    button.disabled = Boolean(unblockingIp);
    button.textContent = unblockingIp === block.ipAddress
      ? t("account.totpIpUnblocking")
      : t("account.totpIpUnblock");
    actionCell.append(button);
    row.append(timeCell, ipCell, attemptsCell, actionCell);
    elements.accountTotpIpBlocksBody.append(row);
  });

  elements.accountTotpIpBlocksEmpty.classList.toggle("hidden", blocks.length > 0);
  elements.accountTotpIpBlocksSummary.textContent = t("account.totpIpBlocksSummary", {
    count: formatNumber(blocks.length)
  });
}

async function loadPermanentTotpIpBlocks({ force = false } = {}) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || !state.accountSettingsOpen || state.totpIpBlocks.loading || state.totpIpBlocks.unblockingIp) return;
  if (!force && state.totpIpBlocks.loaded) {
    renderPermanentTotpIpBlocks();
    return;
  }

  const operation = accountSecurityOperationGuards.totpIpBlocks.begin(targetKey);
  state.totpIpBlocks.loading = true;
  renderPermanentTotpIpBlocks();
  setAccountMessage();
  try {
    const data = await api("/api/auth/totp-ip-blocks");
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpBlocks, operation)) return;
    state.totpIpBlocks.blocks = Array.isArray(data?.blocks) ? data.blocks : [];
    state.totpIpBlocks.loaded = true;
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpBlocks, operation)) return;
    state.totpIpBlocks.blocks = [];
    state.totpIpBlocks.loaded = false;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpBlocks, operation)) {
      state.totpIpBlocks.loading = false;
      renderPermanentTotpIpBlocks();
    }
  }
}

async function unblockPermanentTotpIp(ipAddress) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || !ipAddress || state.totpIpBlocks.loading || state.totpIpBlocks.unblockingIp) return;
  const currentPassword = elements.accountTotpIpUnblockPassword.value;
  if (!currentPassword) {
    setAccountMessage(t("account.totpIpUnblockPasswordRequired"), true);
    elements.accountTotpIpUnblockPassword.focus();
    return;
  }
  if (!window.confirm(t("account.totpIpUnblockConfirm", { ip: ipAddress }))) return;

  const operation = accountSecurityOperationGuards.totpIpBlocks.begin(targetKey);
  state.totpIpBlocks.unblockingIp = ipAddress;
  renderPermanentTotpIpBlocks();
  setAccountMessage();
  try {
    await api(`/api/auth/totp-ip-blocks/${encodeURIComponent(ipAddress)}`, {
      method: "DELETE",
      body: { currentPassword }
    });
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpBlocks, operation)) return;
    elements.accountTotpIpUnblockPassword.value = "";
    state.totpIpBlocks.blocks = state.totpIpBlocks.blocks.filter((block) => block.ipAddress !== ipAddress);
    state.totpIpBlocks.loaded = true;
    setAccountMessage(t("account.totpIpUnblocked", { ip: ipAddress }));
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpBlocks, operation)) return;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpIpBlocks, operation)) {
      state.totpIpBlocks.unblockingIp = null;
      renderPermanentTotpIpBlocks();
    }
  }
}

function normalizeCountryLoginMode(mode) {
  return ["OFF", "ALLOWLIST", "BLOCKLIST"].includes(mode) ? mode : "OFF";
}

function renderCountryLoginPolicy() {
  const policy = state.countryLoginPolicy;
  const enabled = policy.mode !== "OFF";
  const busy = policy.loading || policy.saving;
  elements.accountCountryLoginMode.value = policy.mode;
  elements.accountCountryLoginCurrentIp.textContent = policy.currentIp === "unknown"
    ? t("account.loginHistoryUnknownIp")
    : policy.currentIp;
  elements.accountCountryLoginCurrentCountry.textContent = formatLoginCountry(policy.currentCountryCode);
  elements.accountCountryLoginStatus.textContent = t(
    policy.mode === "ALLOWLIST"
      ? "account.countryLoginAllowlist"
      : policy.mode === "BLOCKLIST"
        ? "account.countryLoginBlocklist"
        : "account.countryLoginOff"
  );
  elements.accountCountryLoginStatus.dataset.mode = policy.mode.toLowerCase();

  elements.accountCountryLoginSelected.replaceChildren();
  if (!policy.countries.length) {
    const empty = document.createElement("span");
    empty.className = "country-login-selected-empty";
    empty.textContent = t("account.countryLoginNoCountries");
    elements.accountCountryLoginSelected.append(empty);
  } else {
    policy.countries.forEach((countryCode) => {
      const chip = document.createElement("span");
      chip.className = "country-login-chip";
      const label = document.createElement("span");
      label.textContent = getCountryLoginCountryLabel(countryCode);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.countryCode = countryCode;
      remove.setAttribute("aria-label", t("account.countryLoginRemove", { country: getCountryLoginCountryLabel(countryCode) }));
      remove.textContent = "×";
      remove.disabled = busy;
      chip.append(label, remove);
      elements.accountCountryLoginSelected.append(chip);
    });
  }

  elements.accountCountryLoginMode.disabled = busy;
  elements.accountCountryLoginCountry.disabled = busy || !enabled;
  elements.accountCountryLoginAdd.disabled = busy || !enabled;
  elements.accountCountryLoginPassword.disabled = busy;
  elements.accountCountryLoginSave.disabled = busy || (enabled && policy.countries.length === 0);
  elements.accountCountryLoginSave.textContent = t(policy.saving ? "account.countryLoginSaving" : "account.countryLoginSave");
}

async function loadCountryLoginPolicy({ force = false } = {}) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || !state.accountSettingsOpen || state.countryLoginPolicy.loading) return;
  if (!force && state.countryLoginPolicy.loaded) {
    renderCountryLoginPolicy();
    return;
  }

  const operation = accountSecurityOperationGuards.countryPolicy.begin(targetKey);
  state.countryLoginPolicy.loading = true;
  renderCountryLoginPolicy();
  setAccountMessage();
  try {
    const data = await api("/api/auth/country-login-policy");
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.countryPolicy, operation)) return;
    const validCountries = new Set(isoCountryCodes);
    state.countryLoginPolicy.mode = normalizeCountryLoginMode(data?.mode);
    state.countryLoginPolicy.countries = Array.isArray(data?.countries)
      ? [...new Set(data.countries
          .map((countryCode) => typeof countryCode === "string" ? countryCode.toUpperCase() : "")
          .filter((countryCode) => validCountries.has(countryCode)))]
      : [];
    state.countryLoginPolicy.currentIp = typeof data?.currentIp === "string" ? data.currentIp : "unknown";
    state.countryLoginPolicy.currentCountryCode = typeof data?.currentCountryCode === "string"
      ? data.currentCountryCode.toUpperCase()
      : null;
    state.countryLoginPolicy.loaded = true;
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.countryPolicy, operation)) return;
    state.countryLoginPolicy.loaded = false;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.countryPolicy, operation)) {
      state.countryLoginPolicy.loading = false;
      renderCountryLoginPolicy();
    }
  }
}

async function saveCountryLoginPolicy() {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || state.countryLoginPolicy.loading || state.countryLoginPolicy.saving) return;
  const mode = normalizeCountryLoginMode(elements.accountCountryLoginMode.value);
  const countries = [...new Set(state.countryLoginPolicy.countries)];
  if (mode !== "OFF" && countries.length === 0) {
    setAccountMessage(t("account.countryLoginCountriesRequired"), true);
    return;
  }

  const operation = accountSecurityOperationGuards.countryPolicy.begin(targetKey);
  state.countryLoginPolicy.mode = mode;
  state.countryLoginPolicy.saving = true;
  renderCountryLoginPolicy();
  setAccountMessage();
  try {
    const data = await api("/api/auth/country-login-policy", {
      method: "PUT",
      body: {
        currentPassword: elements.accountCountryLoginPassword.value,
        mode,
        countries
      }
    });
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.countryPolicy, operation)) return;
    acceptRotatedAuthenticationSession();
    const validCountries = new Set(isoCountryCodes);
    state.countryLoginPolicy.mode = normalizeCountryLoginMode(data?.mode);
    state.countryLoginPolicy.countries = Array.isArray(data?.countries)
      ? [...new Set(data.countries
          .map((countryCode) => typeof countryCode === "string" ? countryCode.toUpperCase() : "")
          .filter((countryCode) => validCountries.has(countryCode)))]
      : [];
    state.countryLoginPolicy.currentIp = typeof data?.currentIp === "string"
      ? data.currentIp
      : state.countryLoginPolicy.currentIp;
    state.countryLoginPolicy.currentCountryCode = typeof data?.currentCountryCode === "string"
      ? data.currentCountryCode.toUpperCase()
      : null;
    state.countryLoginPolicy.loaded = true;
    elements.accountCountryLoginPassword.value = "";
    state.blockHistory.loadedMonths = null;
    setAccountMessage(t("account.countryLoginSaved"));
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.countryPolicy, operation)) return;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.countryPolicy, operation)) {
      state.countryLoginPolicy.saving = false;
      renderCountryLoginPolicy();
    }
  }
}

function normalizeVpnRiskVerdict(value) {
  return ["CLEAR", "VPN", "VPN_GATE", "PROXY", "TOR", "UNKNOWN"].includes(value) ? value : "UNKNOWN";
}

function applyVpnBlockPolicyResponse(data) {
  state.vpnBlockPolicy.enabled = Boolean(data?.enabled);
  state.vpnBlockPolicy.currentIp = typeof data?.currentIp === "string" ? data.currentIp : "unknown";
  state.vpnBlockPolicy.currentCountryCode = typeof data?.currentCountryCode === "string"
    ? data.currentCountryCode.toUpperCase()
    : null;
  state.vpnBlockPolicy.verdict = normalizeVpnRiskVerdict(data?.verdict);
  state.vpnBlockPolicy.confidence = Number.isFinite(Number(data?.confidence))
    ? Math.min(100, Math.max(0, Math.round(Number(data.confidence))))
    : 0;
  state.vpnBlockPolicy.datacenter = Boolean(data?.datacenter);
  state.vpnBlockPolicy.timezoneMismatch = Boolean(data?.timezoneMismatch);
  state.vpnBlockPolicy.providerCount = Number.isFinite(Number(data?.providerCount))
    ? Math.max(0, Math.trunc(Number(data.providerCount)))
    : 0;
  state.vpnBlockPolicy.webRtcState = ["ABSENT", "AVAILABLE", "DISABLED", "UNAVAILABLE"].includes(data?.webRtcState)
    ? data.webRtcState
    : "ABSENT";
  state.vpnBlockPolicy.webRtcObservedIps = Array.isArray(data?.webRtcObservedIps)
    ? data.webRtcObservedIps.filter((value) => typeof value === "string" && value.length <= 64).slice(0, 4)
    : [];
  state.vpnBlockPolicy.webRtcIpMismatch = Boolean(data?.webRtcIpMismatch);
  state.vpnBlockPolicy.supportingSignals = Array.isArray(data?.supportingSignals)
    ? data.supportingSignals.filter((value) => typeof value === "string").slice(0, 16)
    : [];
}

function renderVpnBlockPolicy() {
  const policy = state.vpnBlockPolicy;
  const busy = policy.loading || policy.saving;
  elements.accountVpnBlockEnabled.value = String(policy.enabled);
  elements.accountVpnBlockStatus.textContent = t(policy.enabled ? "account.vpnBlockOn" : "account.vpnBlockOff");
  elements.accountVpnBlockStatus.dataset.mode = policy.enabled ? "enabled" : "disabled";
  elements.accountVpnBlockCurrentIp.textContent = policy.currentIp === "unknown"
    ? t("account.loginHistoryUnknownIp")
    : policy.currentIp;
  elements.accountVpnBlockCurrentCountry.textContent = formatLoginCountry(policy.currentCountryCode);

  const verdictKey = {
    CLEAR: "account.vpnBlockRiskClear",
    VPN: "account.vpnBlockRiskVpn",
    VPN_GATE: "account.vpnBlockRiskVpnGate",
    PROXY: "account.vpnBlockRiskProxy",
    TOR: "account.vpnBlockRiskTor",
    UNKNOWN: "account.vpnBlockRiskUnknown"
  }[policy.verdict] ?? "account.vpnBlockRiskUnknown";
  const verdict = t(verdictKey);
  elements.accountVpnBlockCurrentVerdict.textContent = policy.loading
    ? t("account.vpnBlockLoading")
    : policy.providerCount > 0 || policy.verdict !== "UNKNOWN"
      ? t("account.vpnBlockRiskWithConfidence", {
          risk: verdict,
          confidence: formatNumber(policy.confidence)
        })
      : verdict;

  const supportingSignals = [];
  if (policy.providerCount > 0) {
    supportingSignals.push(t("account.vpnBlockProviderCount", { count: formatNumber(policy.providerCount) }));
  }
  if (policy.datacenter) supportingSignals.push(t("account.vpnBlockDatacenterSignal"));
  if (policy.timezoneMismatch) supportingSignals.push(t("account.vpnBlockTimezoneSignal"));
  if (policy.supportingSignals.includes("WEBRTC_HTTP_IP_MISMATCH")) {
    supportingSignals.push(t("account.vpnBlockWebRtcMismatchSignal", {
      ips: policy.webRtcObservedIps.join(", ") || t("account.loginHistoryUnknownIp")
    }));
  } else if (policy.supportingSignals.includes("WEBRTC_HTTP_IP_MATCH")) {
    supportingSignals.push(t("account.vpnBlockWebRtcMatchSignal"));
  } else if (policy.supportingSignals.includes("WEBRTC_DISABLED")) {
    supportingSignals.push(t("account.vpnBlockWebRtcDisabledSignal"));
  } else if (policy.supportingSignals.includes("WEBRTC_STUN_UNAVAILABLE")) {
    supportingSignals.push(t("account.vpnBlockWebRtcUnavailableSignal"));
  }
  if (policy.supportingSignals.includes("VPN_GATE_DIRECTORY_DDNS_VERIFIED")) {
    supportingSignals.push(t("account.vpnBlockVpnGateDdnsVerified"));
  } else if (policy.supportingSignals.includes("VPN_GATE_DIRECTORY_PROVIDER_CORROBORATED")) {
    supportingSignals.push(t("account.vpnBlockVpnGateProviderCorroborated"));
  } else if (policy.supportingSignals.includes("VPN_GATE_DIRECTORY_UNVERIFIED")) {
    supportingSignals.push(t("account.vpnBlockVpnGateUnverified"));
  } else if (policy.supportingSignals.includes("VPN_GATE_PUBLIC_RELAY_DIRECTORY")) {
    supportingSignals.push(t("account.vpnBlockVpnGateListed"));
  }
  elements.accountVpnBlockCurrentSignals.textContent = supportingSignals.length
    ? supportingSignals.join(" · ")
    : t("account.vpnBlockNoSupportingSignals");

  elements.accountVpnBlockEnabled.disabled = busy;
  elements.accountVpnBlockPassword.disabled = busy;
  elements.accountVpnBlockSave.disabled = busy;
  elements.accountVpnBlockSave.textContent = t(policy.saving ? "account.vpnBlockSaving" : "account.vpnBlockSave");
}

async function loadVpnBlockPolicy({ force = false } = {}) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || !state.accountSettingsOpen || state.vpnBlockPolicy.loading) return;
  if (!force && state.vpnBlockPolicy.loaded) {
    renderVpnBlockPolicy();
    return;
  }

  const operation = accountSecurityOperationGuards.vpnPolicy.begin(targetKey);
  state.vpnBlockPolicy.loading = true;
  renderVpnBlockPolicy();
  setAccountMessage();
  try {
    const data = await api("/api/auth/vpn-block-policy");
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.vpnPolicy, operation)) return;
    applyVpnBlockPolicyResponse(data);
    state.vpnBlockPolicy.loaded = true;
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.vpnPolicy, operation)) return;
    state.vpnBlockPolicy.loaded = false;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.vpnPolicy, operation)) {
      state.vpnBlockPolicy.loading = false;
      renderVpnBlockPolicy();
    }
  }
}

async function saveVpnBlockPolicy() {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || state.vpnBlockPolicy.loading || state.vpnBlockPolicy.saving) return;
  const enabled = elements.accountVpnBlockEnabled.value === "true";
  const operation = accountSecurityOperationGuards.vpnPolicy.begin(targetKey);
  state.vpnBlockPolicy.enabled = enabled;
  state.vpnBlockPolicy.saving = true;
  renderVpnBlockPolicy();
  setAccountMessage();
  try {
    const data = await api("/api/auth/vpn-block-policy", {
      method: "PUT",
      body: {
        currentPassword: elements.accountVpnBlockPassword.value,
        enabled
      }
    });
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.vpnPolicy, operation)) return;
    acceptRotatedAuthenticationSession();
    applyVpnBlockPolicyResponse(data);
    state.vpnBlockPolicy.loaded = true;
    elements.accountVpnBlockPassword.value = "";
    state.blockHistory.loadedMonths = null;
    setAccountMessage(t("account.vpnBlockSaved"));
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.vpnPolicy, operation)) return;
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.vpnPolicy, operation)) {
      state.vpnBlockPolicy.saving = false;
      renderVpnBlockPolicy();
    }
  }
}

function loadActiveSecurityPanel() {
  if (state.activeSecurityPanel === "sessions") {
    void loadActiveSessions();
    return;
  }
  if (state.activeSecurityPanel === "history") {
    void loadLoginHistory();
    return;
  }
  if (state.activeSecurityPanel === "blocks") {
    void loadBlockHistory();
    return;
  }
  if (state.activeSecurityPanel === "totp-blocks") {
    void loadPermanentTotpIpBlocks();
    return;
  }
  void loadMfaSettings();
  void loadTotpIpBlockPolicy();
  void loadCountryLoginPolicy();
  void loadVpnBlockPolicy();
}

function setSecurityPanel(panel, { focusTab = false, load = true } = {}) {
  const nextPanel = ["settings", "sessions", "history", "blocks", "totp-blocks"].includes(panel) ? panel : "settings";
  state.activeSecurityPanel = nextPanel;
  elements.accountSecurityTabs.forEach((tab) => {
    const selected = tab.dataset.securityPanel === nextPanel;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focusTab) tab.focus();
  });
  elements.accountSecurityPanels.forEach((panelElement) => {
    panelElement.classList.toggle("hidden", panelElement.dataset.securityPanelContent !== nextPanel);
  });
  setAccountMessage();
  if (load && state.accountSettingsOpen && state.activeAccountPanel === "security") loadActiveSecurityPanel();
}

function handleSecurityTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = elements.accountSecurityTabs;
  const currentIndex = Math.max(0, tabs.indexOf(event.currentTarget));
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
  setSecurityPanel(tabs[nextIndex].dataset.securityPanel, { focusTab: true });
}

function setAccountPanel(panel, { focusTab = false } = {}) {
  const nextPanel = ["profile", "preferences", "security", "data"].includes(panel) ? panel : "profile";
  state.activeAccountPanel = nextPanel;
  elements.accountSettingsTabs.forEach((tab) => {
    const selected = tab.dataset.accountPanel === nextPanel;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focusTab) tab.focus();
  });
  elements.accountSettingsPanels.forEach((panelElement) => {
    panelElement.classList.toggle("hidden", panelElement.dataset.accountPanelContent !== nextPanel);
  });
  setAccountMessage();
  if (nextPanel === "security" && state.accountSettingsOpen) loadActiveSecurityPanel();
}

function hideTotpSetup() {
  state.totpSetupToken = null;
  elements.accountTotpSetupPanel.classList.add("hidden");
  elements.accountTotpVerifyForm.reset();
  elements.accountTotpQr.removeAttribute("src");
  elements.accountTotpSecret.textContent = "";
}

function requireMfaPassword() {
  const currentPassword = elements.accountMfaPassword.value;
  if (currentPassword) return currentPassword;
  setAccountMessage(t("mfa.passwordRequired"), true);
  elements.accountMfaPassword.focus();
  return null;
}

function createPasskeyActionButton(labelKey, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = t(labelKey);
  button.addEventListener("click", handler);
  return button;
}

function renderPasskeyList() {
  elements.accountPasskeyList.replaceChildren();
  const passkeys = Array.isArray(state.mfaStatus.passkeys) ? state.mfaStatus.passkeys : [];
  if (!passkeys.length) {
    const empty = document.createElement("p");
    empty.className = "passkey-empty";
    empty.textContent = t("mfa.noPasskeys");
    elements.accountPasskeyList.append(empty);
    return;
  }

  passkeys.forEach((passkey) => {
    const item = document.createElement("article");
    item.className = "passkey-list-item";

    const copy = document.createElement("div");
    copy.className = "passkey-list-copy";
    const name = document.createElement("strong");
    name.textContent = passkey.name;
    const metadata = document.createElement("small");
    const deviceLabel = passkey.deviceType === "multiDevice" ? t("mfa.multiDevice") : t("mfa.singleDevice");
    const backupLabel = passkey.backedUp ? t("mfa.backedUp") : t("mfa.notBackedUp");
    const usageLabel = passkey.lastUsedAt
      ? t("mfa.passkeyLastUsed", { date: formatDate(passkey.lastUsedAt) })
      : t("mfa.passkeyNeverUsed");
    metadata.textContent = `${deviceLabel} · ${backupLabel} · ${usageLabel}`;
    copy.append(name, metadata);

    const actions = document.createElement("div");
    actions.className = "passkey-list-actions";
    actions.append(
      createPasskeyActionButton("mfa.renamePasskey", "secondary compact", async () => {
        const nextName = window.prompt(t("mfa.renamePrompt"), passkey.name)?.trim();
        if (!nextName || nextName === passkey.name) return;
        try {
          await api(`/api/auth/mfa/passkeys/${encodeURIComponent(passkey.id)}`, {
            method: "PATCH",
            body: { name: nextName }
          });
          await loadMfaSettings({ showLoading: false });
          setAccountMessage(t("mfa.passkeyRenamed"));
        } catch (error) {
          setAccountMessage(error.message, true);
        }
      }),
      createPasskeyActionButton("mfa.removePasskey", "secondary danger compact", async () => {
        if (!window.confirm(t("mfa.removePasskeyConfirm", { name: passkey.name }))) return;
        const currentPassword = requireMfaPassword();
        const targetKey = getAccountAvatarTargetKey(state.user);
        if (!currentPassword || !targetKey) return;
        try {
          await api(`/api/auth/mfa/passkeys/${encodeURIComponent(passkey.id)}`, {
            method: "DELETE",
            body: { currentPassword }
          });
          if (!state.accountSettingsOpen || getAccountAvatarTargetKey(state.user) !== targetKey) return;
          acceptRotatedAuthenticationSession();
          elements.accountMfaPassword.value = "";
          await loadMfaSettings({ showLoading: false });
          setAccountMessage(t("mfa.passkeyRemoved"));
        } catch (error) {
          setAccountMessage(error.message, true);
        }
      })
    );

    item.append(copy, actions);
    elements.accountPasskeyList.append(item);
  });
}

function setAccountPasskeyRegistering(registering) {
  state.accountPasskeyRegistering = Boolean(registering);
  const disabled = !isWebAuthnSupported() || state.accountPasskeyRegistering;
  elements.accountPasskeyRegister.disabled = disabled;
  elements.accountPasskeyName.disabled = disabled;
  elements.accountPasskeyRegistrationTarget.disabled = disabled;
}

function renderMfaSettings() {
  const passkeys = Array.isArray(state.mfaStatus.passkeys) ? state.mfaStatus.passkeys : [];
  const configuredCount = (state.mfaStatus.totpEnabled ? 1 : 0) + passkeys.length;
  elements.accountMfaSummary.textContent = configuredCount
    ? t("mfa.configuredMethods", { count: formatNumber(configuredCount) })
    : t("mfa.notConfigured");
  elements.accountTotpStatus.textContent = t(state.mfaStatus.totpEnabled ? "mfa.enabled" : "mfa.disabled");
  elements.accountTotpStatus.classList.toggle("enabled", state.mfaStatus.totpEnabled);
  elements.accountTotpSetup.textContent = t(state.mfaStatus.totpEnabled ? "mfa.replaceTotp" : "mfa.setUpTotp");
  elements.accountTotpDisable.classList.toggle("hidden", !state.mfaStatus.totpEnabled);
  elements.accountPasskeyCount.textContent = t("mfa.passkeyCount", { count: formatNumber(passkeys.length) });

  elements.accountPasskeySupport.textContent = t(isWebAuthnSupported() ? "mfa.passkeyReady" : "mfa.passkeyUnsupported");
  void refreshPasskeyRegistrationSupport();
  setAccountPasskeyRegistering(state.accountPasskeyRegistering);
  renderPasskeyList();
}

async function loadMfaSettings({ showLoading = true } = {}) {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey || !state.accountSettingsOpen) return;
  const operation = accountSecurityOperationGuards.mfaStatus.begin(targetKey);
  if (showLoading) setAccountMessage(t("mfa.loading"));
  try {
    const data = await api("/api/auth/mfa/status");
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.mfaStatus, operation)) return;
    state.mfaStatus = {
      totpEnabled: Boolean(data?.totpEnabled),
      passkeys: Array.isArray(data?.passkeys) ? data.passkeys : []
    };
    renderMfaSettings();
    if (showLoading) setAccountMessage();
  } catch (error) {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.mfaStatus, operation)) {
      setAccountMessage(error.message, true);
    }
  }
}


function setSearchDialogMessage(message = "", isError = false) {
  elements.searchMessage.textContent = message;
  elements.searchMessage.classList.toggle("error", isError);
  elements.searchMessage.classList.toggle("hidden", !message);
}

function syncSearchClearButton() {
  elements.searchClear.hidden = !elements.searchInput.value;
}

function makeSearchResultItem(result, index) {
  const item = document.createElement("div");
  item.className = "search-result-entry";
  item.setAttribute("role", "listitem");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "search-result-item";
  button.dataset.searchResultIndex = String(index);

  const icon = document.createElement("span");
  icon.className = "search-result-icon";
  icon.setAttribute("aria-hidden", "true");
  renderIconValue(
    icon,
    result.kind === "page" ? result.icon : result.pageIcon,
    result.kind === "page" ? "📄" : "▤"
  );

  const copy = document.createElement("span");
  copy.className = "search-result-copy";

  const title = document.createElement("strong");
  title.textContent = result.kind === "page" ? result.title : result.pageTitle;

  const meta = document.createElement("small");
  meta.textContent = result.kind === "page"
    ? t("search.pageResult")
    : `${t("search.blockResult")}${result.type ? ` · ${result.type}` : ""}`;

  copy.append(title, meta);
  if (result.kind === "block" && result.snippet) {
    const snippet = document.createElement("span");
    snippet.className = "search-result-snippet";
    snippet.textContent = result.snippet;
    copy.append(snippet);
  }

  button.append(icon, copy);
  item.append(button);
  return item;
}

function renderSearchDialog() {
  if (!elements.searchResults) return;
  elements.searchResults.replaceChildren();
  elements.searchResults.setAttribute("aria-busy", String(state.searchLoading));
  elements.searchResultCount.textContent = "";
  syncSearchClearButton();

  if (state.searchLoading) {
    setSearchDialogMessage(t("search.loading"));
    return;
  }

  const query = elements.searchInput.value.trim();
  if (!query || state.searchSubmittedQuery !== query) {
    setSearchDialogMessage(t("search.start"));
    return;
  }

  elements.searchResultCount.textContent = t("search.resultCount", { count: formatNumber(state.searchResults.length) });
  if (!state.searchResults.length) {
    setSearchDialogMessage(t("search.empty"));
    return;
  }

  setSearchDialogMessage();
  state.searchResults.forEach((result, index) => {
    elements.searchResults.append(makeSearchResultItem(result, index));
  });
}

function resetSearchDialogState({ clearInput = true } = {}) {
  state.searchRequestId += 1;
  state.searchLoading = false;
  state.searchResults = [];
  state.searchSubmittedQuery = "";
  if (clearInput) elements.searchInput.value = "";
  renderSearchDialog();
}

function getSearchDialogFocusableElements() {
  return [...elements.searchDialog.querySelectorAll(mobileSidebarFocusableSelector)].filter((element) => {
    return !element.disabled && !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0;
  });
}

function openSearchDialog() {
  if (!state.user || state.searchDialogOpen) return;
  closeMobileSidebar();
  state.searchDialogOpen = true;
  elements.searchLayer.classList.remove("hidden");
  elements.searchLayer.setAttribute("aria-hidden", "false");
  elements.sidebarSearchShortcut.setAttribute("aria-expanded", "true");
  document.body.classList.add("search-dialog-open");
  elements.shell.inert = true;
  renderSearchDialog();
  window.requestAnimationFrame(() => {
    elements.searchInput.focus();
    elements.searchInput.select();
  });
}

function closeSearchDialog({ restoreFocus = true } = {}) {
  if (!state.searchDialogOpen) return;
  state.searchDialogOpen = false;
  state.searchRequestId += 1;
  if (state.searchLoading) {
    state.searchResults = [];
    state.searchSubmittedQuery = "";
  }
  state.searchLoading = false;
  elements.searchLayer.classList.add("hidden");
  elements.searchLayer.setAttribute("aria-hidden", "true");
  elements.sidebarSearchShortcut.setAttribute("aria-expanded", "false");
  document.body.classList.remove("search-dialog-open");
  elements.shell.inert = false;
  renderSearchDialog();
  syncMobileSidebarAccessibility();
  if (restoreFocus && state.user) elements.sidebarSearchShortcut.focus();
}

function handleSearchDialogKeydown(event) {
  if (!state.searchDialogOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeSearchDialog();
    return;
  }
  if (event.key !== "Tab") return;

  const focusableElements = getSearchDialogFocusableElements();
  if (!focusableElements.length) {
    event.preventDefault();
    elements.searchDialog.focus();
    return;
  }
  const first = focusableElements[0];
  const last = focusableElements.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function performWorkspaceSearch() {
  const query = elements.searchInput.value.trim();
  elements.searchInput.value = query;
  syncSearchClearButton();

  if (!query) {
    resetSearchDialogState({ clearInput: false });
    elements.searchInput.focus();
    return;
  }

  const requestId = ++state.searchRequestId;
  state.searchSubmittedQuery = query;
  state.searchLoading = true;
  state.searchResults = [];
  renderSearchDialog();

  try {
    const params = new URLSearchParams({ q: query, limit: "30" });
    const data = await api(`/api/search?${params.toString()}`);
    if (requestId !== state.searchRequestId || !state.searchDialogOpen) return;
    state.searchResults = Array.isArray(data?.results) ? data.results : [];
    state.searchLoading = false;
    renderSearchDialog();
    setStatus(t("status.searchLoaded"));
  } catch (error) {
    if (requestId !== state.searchRequestId || !state.searchDialogOpen) return;
    state.searchLoading = false;
    state.searchResults = [];
    elements.searchResults.replaceChildren();
    elements.searchResults.setAttribute("aria-busy", "false");
    elements.searchResultCount.textContent = "";
    setSearchDialogMessage(error.message, true);
  }
}

function revealSearchResultBlock(blockId) {
  window.requestAnimationFrame(() => {
    const row = elements.blockList.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    if (!row) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    row.classList.add("search-result-target");
    window.setTimeout(() => row.classList.remove("search-result-target"), 1800);
  });
}

async function openSearchResult(index) {
  const result = state.searchResults[index];
  if (!result?.pageId) return;

  try {
    await openPage(result.pageId);
    closeSearchDialog({ restoreFocus: false });
    if (result.kind === "block" && result.blockId) revealSearchResultBlock(result.blockId);
    else elements.pageTitle.focus({ preventScroll: true });
  } catch (error) {
    setSearchDialogMessage(error.message, true);
  }
}

function fillAccountSettings() {
  if (!state.user) return;
  state.pendingAvatarData = state.user.avatarData ?? null;
  elements.accountDisplayName.value = state.user.name ?? "";
  elements.accountLoginId.value = state.user.username;
  elements.languageSelect.value = state.user.preferredLanguage || getLanguage();
  elements.themeSelect.value = normalizeTheme(state.user.theme);
  renderUserAvatar(
    elements.accountAvatarPreview,
    elements.accountAvatarFallback,
    state.pendingAvatarData,
    getUserInitials(state.user)
  );
  syncAccountProfileControls();
  elements.accountPasswordForm.reset();
  resetDataImportSelection();
  elements.accountMfaPassword.value = "";
  elements.accountCountryLoginPassword.value = "";
  elements.accountVpnBlockPassword.value = "";
  elements.accountPasskeyRegisterForm.reset();
  hideTotpSetup();
  populateLoginHistoryMonths();
  populateBlockHistoryMonths();
  populateCountryLoginCountryOptions();
  setSecurityPanel(state.activeSecurityPanel, { load: false });
  renderMfaSettings();
  renderActiveSessions();
  renderLoginHistory();
  renderBlockHistory();
  renderCountryLoginPolicy();
  renderVpnBlockPolicy();
  updateUserIdentityUi();
}

function syncAccountProfileControls() {
  elements.accountAvatarInput.disabled = state.accountAvatarPreparing;
  elements.accountAvatarRemove.disabled = state.accountAvatarPreparing || !state.pendingAvatarData;
  elements.accountProfileSave.disabled = state.accountAvatarPreparing || state.accountProfileSaving;
}

function setAccountAvatarPreparing(preparing) {
  state.accountAvatarPreparing = Boolean(preparing);
  syncAccountProfileControls();
}

function setAccountProfileSaving(saving) {
  state.accountProfileSaving = Boolean(saving);
  syncAccountProfileControls();
}

function getAccountSettingsFocusableElements() {
  return [...elements.accountSettingsDialog.querySelectorAll(mobileSidebarFocusableSelector)].filter((element) => {
    return !element.disabled && !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0;
  });
}

function openAccountSettings(panel = "profile") {
  if (!state.user || state.accountSettingsOpen) return;
  accountAvatarOperationGuard.invalidate();
  state.accountAvatarPreparing = false;
  closeMobileSidebar();
  state.accountSettingsOpen = true;
  fillAccountSettings();
  setAccountAvatarPreparing(false);
  setAccountPanel(panel);
  elements.accountSettingsLayer.classList.remove("hidden");
  elements.accountSettingsLayer.setAttribute("aria-hidden", "false");
  document.body.classList.add("account-settings-open");
  elements.shell.inert = true;
  window.requestAnimationFrame(() => {
    const selectedTab = elements.accountSettingsTabs.find((tab) => tab.dataset.accountPanel === state.activeAccountPanel);
    (selectedTab ?? elements.accountSettingsDialog).focus();
  });
}

function closeAccountSettings({ restoreFocus = true, force = false } = {}) {
  if (!state.accountSettingsOpen || (state.accountDataOperationBusy && !force)) return;
  accountAvatarOperationGuard.invalidate();
  resetAccountSecurityOperationState({ clearSensitiveState: true });
  setAccountAvatarPreparing(false);
  state.accountSettingsOpen = false;
  elements.accountSettingsLayer.classList.add("hidden");
  elements.accountSettingsLayer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("account-settings-open");
  elements.shell.inert = false;
  setAccountMessage();
  elements.accountAvatarInput.value = "";
  elements.accountPasswordForm.reset();
  elements.accountMfaPassword.value = "";
  elements.accountCountryLoginPassword.value = "";
  elements.accountVpnBlockPassword.value = "";
  elements.accountPasskeyRegisterForm.reset();
  hideTotpSetup();
  syncMobileSidebarAccessibility();
  if (restoreFocus && state.user) elements.accountSettingsTrigger.focus();
}

function handleAccountSettingsKeydown(event) {
  if (!state.accountSettingsOpen) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAccountSettings();
    return;
  }
  if (event.key !== "Tab") return;

  const focusableElements = getAccountSettingsFocusableElements();
  if (!focusableElements.length) {
    event.preventDefault();
    elements.accountSettingsDialog.focus();
    return;
  }
  const first = focusableElements[0];
  const last = focusableElements.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function handleAccountTabKeydown(event) {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = elements.accountSettingsTabs;
  const currentIndex = Math.max(0, tabs.indexOf(event.currentTarget));
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (currentIndex + (["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1) + tabs.length) % tabs.length;
  setAccountPanel(tabs[nextIndex].dataset.accountPanel, { focusTab: true });
}

function estimateDataUrlBytes(dataUrl) {
  const payload = dataUrl.split(",", 2)[1] ?? "";
  return Math.floor((payload.length * 3) / 4);
}

async function createAvatarDataUrl(file) {
  const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowedTypes.has(file.type)) throw new Error(t("account.invalidAvatar"));
  if (file.size > 5 * 1024 * 1024) throw new Error(t("account.avatarTooLarge"));

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(t("account.invalidAvatar")));
      image.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("account.invalidAvatar"));
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, 320, 320);

    let dataUrl = canvas.toDataURL("image/webp", 0.86);
    if (!dataUrl.startsWith("data:image/webp")) dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    if (estimateDataUrlBytes(dataUrl) > 512 * 1024) dataUrl = canvas.toDataURL("image/jpeg", 0.72);
    if (estimateDataUrlBytes(dataUrl) > 512 * 1024) throw new Error(t("account.avatarTooLarge"));
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function applyUserPreferredLanguage() {
  const preferredLanguage = state.user?.preferredLanguage;
  if (preferredLanguage && preferredLanguage !== getLanguage()) setLanguage(preferredLanguage);
}

function resetMfaLogin({ focus = false } = {}) {
  state.mfaLogin = null;
  elements.authHeader.classList.remove("hidden");
  elements.authForm.classList.remove("hidden");
  elements.mfaLoginPanel.classList.add("hidden");
  elements.mfaLoginTotpForm.classList.remove("hidden");
  elements.mfaLoginPasskey.classList.remove("hidden");
  elements.mfaLoginTotpForm.reset();
  syncAuthOperationControls();
  if (focus) window.requestAnimationFrame(() => elements.username.focus());
}

function showMfaLogin(data) {
  const methods = {
    totp: Boolean(data?.methods?.totp),
    passkey: Boolean(data?.methods?.passkey)
  };
  if (!methods.totp && !methods.passkey) throw new Error(t("errors.unknown"));

  state.mfaLogin = { token: data.mfaToken, methods };
  elements.authHeader.classList.add("hidden");
  elements.authForm.classList.add("hidden");
  elements.mfaLoginPanel.classList.remove("hidden");
  elements.mfaLoginTotpForm.classList.toggle("hidden", !methods.totp);
  elements.mfaLoginPasskey.classList.toggle("hidden", !methods.passkey);
  syncAuthOperationControls();
  elements.mfaLoginDivider.classList.toggle("hidden", !(methods.totp && methods.passkey));
  elements.mfaLoginTotpForm.reset();
  setStatus(methods.passkey && !methods.totp && !isWebAuthnSupported() ? t("mfa.passkeyUnsupported") : "", true);
  window.requestAnimationFrame(() => {
    if (methods.totp) elements.mfaLoginCode.focus();
    else if (methods.passkey && isWebAuthnSupported()) elements.mfaLoginPasskey.focus();
    else elements.mfaLoginCancel.focus();
  });
}

async function completeAuthenticatedLogin(data) {
  resetAuthenticationSessionState({ render: false });
  setAuthenticated(true);
  state.user = data.user;
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey) {
    const error = new Error(t("errors.invalidResponse"));
    resetAuthenticationSessionState();
    setStatus(error.message, true);
    return { outcome: "invalid-response", error };
  }
  const operation = authenticatedSessionOperationGuard.begin(targetKey);
  setAuthOperationBusy(true);
  elements.password.value = "";
  resetMfaLogin();
  applyUserTheme();
  try {
    await applyUserPreferredLanguage();
    if (!isCurrentAuthenticatedSessionOperation(operation)) return { outcome: "superseded" };

    try {
      const [pages] = await Promise.all([fetchAllPageSummaries(), loadNavigationPreferences()]);
      if (!isCurrentAuthenticatedSessionOperation(operation)) return { outcome: "superseded" };
      state.searchQuery = "";
      state.activeTag = "";
      state.pages = pages;
      state.allPages = pages;
      renderPages();
      await restoreWorkspaceLocationFromHash({ fallbackToHome: true });
      if (!isCurrentAuthenticatedSessionOperation(operation)) return { outcome: "superseded" };
      renderShell();
      setStatus(t("status.loggedInAs", { username: state.user.username }));
      return { outcome: "ready" };
    } catch (error) {
      if (!isCurrentAuthenticatedSessionOperation(operation)) return { outcome: "superseded" };
      renderShell();
      setStatus(error.message, true);
      return { outcome: "workspace-unavailable", error };
    }
  } finally {
    if (isCurrentAuthenticatedSessionOperation(operation)) setAuthOperationBusy(false);
  }
}

async function logout() {
  return withPageEditLock(async () => {
    try {
      const headers = new Headers();
      await applyClientNetworkVerificationHeaders(headers);
      await fetch("/api/auth/logout", { method: "POST", credentials: "include", headers });
    } finally {
      resetAuthenticationSessionState();
      setStatus(t("status.loggedOut"));
    }
  });
}

function sortByRecent(items) {
  return [...items].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function sortByNavigationOrder(items) {
  return [...items].sort((a, b) => {
    const aOrder = state.navigationPageOrder.get(a.id);
    const bOrder = state.navigationPageOrder.get(b.id);
    const aRanked = Number.isSafeInteger(aOrder) && aOrder >= 0;
    const bRanked = Number.isSafeInteger(bOrder) && bOrder >= 0;

    // Pages without an explicit preference keep the historical recent-first
    // behavior. Newly created pages therefore appear first until the user
    // explicitly reorders that sibling group.
    if (aRanked !== bRanked) return aRanked ? 1 : -1;
    if (aRanked && bRanked && aOrder !== bOrder) return aOrder - bOrder;

    const recent = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (recent !== 0) return recent;
    return String(a.id).localeCompare(String(b.id));
  });
}

function buildPageTree(pages, { useNavigationOrder = false } = {}) {
  const ids = new Set(pages.map((page) => page.id));
  const groups = new Map([[rootParentKey, []]]);

  for (const page of pages) {
    const parentKey = page.parentPageId && ids.has(page.parentPageId) ? page.parentPageId : rootParentKey;
    if (!groups.has(parentKey)) groups.set(parentKey, []);
    groups.get(parentKey).push(page);
  }

  const sortChildren = useNavigationOrder ? sortByNavigationOrder : sortByRecent;
  for (const [key, children] of groups) groups.set(key, sortChildren(children));
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

function isCollectionPage(page) {
  return page?.isCollection === true;
}

function getRootCollections(pages = state.allPages) {
  return sortByNavigationOrder(pages.filter(isCollectionPage));
}

function getCollectionRootId(pageId, pages = state.allPages) {
  if (!pageId) return null;

  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const visited = new Set();
  let page = pagesById.get(pageId);

  while (page && !visited.has(page.id)) {
    if (isCollectionPage(page)) return page.id;
    visited.add(page.id);
    page = page.parentPageId ? pagesById.get(page.parentPageId) : null;
  }

  return null;
}

function getDefaultCollectionPages(pages = state.allPages) {
  return pages.filter((page) => !getCollectionRootId(page.id, pages));
}

function getCollectionPageCount(collectionId, pages = state.allPages) {
  return pages.filter(
    (page) => page.id !== collectionId && getCollectionRootId(page.id, pages) === collectionId
  ).length;
}

function getCollectionPages(collectionId, pages = state.allPages) {
  if (collectionId === defaultCollectionKey) return getDefaultCollectionPages(pages);
  return pages.filter(
    (page) => page.id !== collectionId && getCollectionRootId(page.id, pages) === collectionId
  );
}

function getPagePathSegments(page = state.selectedPage) {
  if (!page) return [];

  const pagesById = new Map(state.allPages.map((item) => [item.id, item]));
  pagesById.set(page.id, { ...(pagesById.get(page.id) ?? {}), ...page });
  const segments = [];
  const visited = new Set();
  let current = pagesById.get(page.id);

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const collection = isCollectionPage(current);
    segments.unshift({
      id: current.id,
      kind: collection ? "collection" : "page",
      title: current.title || t("newDocumentTitle"),
      icon: current.icon ?? (collection ? "📁" : "📄")
    });
    current = current.parentPageId ? pagesById.get(current.parentPageId) : null;
  }

  if (!segments.length || segments[0].kind !== "collection") {
    segments.unshift({
      id: defaultCollectionKey,
      kind: "collection",
      title: getDefaultCollectionName(),
      icon: getDefaultCollectionEmoji()
    });
  }

  return segments;
}

function renderPagePath(page = state.selectedPage) {
  elements.pagePath.replaceChildren();
  if (!page) return;

  const segments = getPagePathSegments(page);
  segments.forEach((segment, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "page-view-path-separator";
      separator.setAttribute("aria-hidden", "true");
      separator.textContent = "/";
      elements.pagePath.append(separator);
    }

    const isCurrent = index === segments.length - 1;
    const item = document.createElement(isCurrent ? "span" : "button");
    item.className = `page-view-path-segment${isCurrent ? " page-view-path-current" : ""}`;
    if (item instanceof HTMLButtonElement) {
      item.type = "button";
      item.dataset.pagePathId = segment.id;
      item.dataset.pagePathKind = segment.kind;
    } else {
      item.setAttribute("aria-current", "page");
    }

    const emoji = document.createElement("span");
    emoji.className = "page-view-path-emoji";
    emoji.setAttribute("aria-hidden", "true");
    renderIconValue(emoji, segment.icon, segment.kind === "collection" ? "📁" : "📄");

    const title = document.createElement("span");
    title.className = "page-view-path-title";
    title.textContent = segment.title;
    item.append(emoji, title);
    elements.pagePath.append(item);
  });
}

function renderPageHeader(page = state.selectedPage) {
  renderPagePath(page);
  if (!page) return;
  const title = page.title || t("newDocumentTitle");
  const actionsLabel = t("page.moreActions", { title });
  elements.pageActionsButton.setAttribute("aria-label", actionsLabel);
  elements.pageActionsButton.setAttribute("title", actionsLabel);
  elements.pageActionsMenu.setAttribute("aria-label", t("page.actionsAria", { title }));
}

function getActiveCollectionId() {
  if (state.workspaceView === "collection") return state.activeCollectionId;
  if (state.workspaceView === "page" && state.selectedPage) {
    return getCollectionRootId(state.selectedPage.id) ?? defaultCollectionKey;
  }
  return null;
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

function getUserScopedStorageKey(baseKey) {
  return `${baseKey}.${state.user?.id ?? "anonymous"}`;
}

function readJsonStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or a full storage quota should not block emoji selection.
  }
}

function getDefaultCollectionName() {
  return t("collection.heading").replace(/^📁\s*/, "");
}

function getDefaultCollectionEmoji() {
  return state.user?.defaultCollectionIcon || "📁";
}

function getRecentEmojis() {
  const values = readJsonStorage(getUserScopedStorageKey(recentEmojiStorageKey), []);
  if (!Array.isArray(values)) return [];
  return values.filter((emoji) => typeof emoji === "string" && emojiRecordByValue.has(emoji)).slice(0, 36);
}

function rememberRecentEmoji(emoji) {
  const next = [emoji, ...getRecentEmojis().filter((item) => item !== emoji)].slice(0, 36);
  writeJsonStorage(getUserScopedStorageKey(recentEmojiStorageKey), next);
}

function getEmojiCategoryLabel(category) {
  return getLanguage() === "ko" ? category.labelKo : category.labelEn;
}

function getEmojiRecordLabel(record) {
  return getLanguage() === "ko" ? record[2] : record[3];
}

function getIconCategoryLabel(category) {
  return getLanguage() === "ko" ? category.labelKo : category.labelEn;
}

function getIconRecordLabel(record) {
  return getLanguage() === "ko" ? record.labelKo : record.labelEn;
}

function normalizeEmojiSearch(value) {
  return value.trim().normalize("NFKC").toLocaleLowerCase();
}

function createBuiltInIconSvg(name) {
  const nodes = iconSvgNodes[name];
  if (!nodes) return null;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("app-icon-svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const [tagName, attributes] of nodes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tagName);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    svg.append(node);
  }
  return svg;
}

function getCustomImageSource(iconValue) {
  if (typeof iconValue !== "string" || !iconValue.startsWith(imageIconPrefix)) return null;
  const source = iconValue.slice(imageIconPrefix.length).trim();
  if (/^\/upload\/icons\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,96}\.(?:png|jpg|webp|ico)$/.test(source)) return source;
  if (/^data:image\/(?:png|jpeg|webp|vnd\.microsoft\.icon|x-icon);base64,[a-z0-9+/]+=*$/i.test(source)) return source;
  try {
    const url = new URL(source);
    if (source.length > customIconMaxUrlLength || url.username || url.password) return null;
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function createIconVisual(iconValue, fallback = "📄") {
  const value = typeof iconValue === "string" && iconValue ? iconValue : fallback;
  if (value.startsWith(builtInIconPrefix)) {
    const svg = createBuiltInIconSvg(value.slice(builtInIconPrefix.length));
    if (svg) return svg;
  }

  const imageSource = getCustomImageSource(value);
  if (imageSource) {
    const image = document.createElement("img");
    image.className = "app-icon-image";
    image.src = imageSource;
    image.alt = "";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.setAttribute("aria-hidden", "true");
    const missingFileFallback = imageSource.startsWith("/upload/icons/") ? "📄" : fallback;
    image.addEventListener("error", () => image.replaceWith(createIconVisual(missingFileFallback, "📄")), { once: true });
    return image;
  }

  const emojiValue = value.startsWith(imageIconPrefix) || value.startsWith(builtInIconPrefix) ? fallback : value;
  if (emojiRecordByValue.has(emojiValue)) return createEmojiVisual(emojiValue);

  const emoji = document.createElement("span");
  emoji.className = "app-icon-emoji";
  emoji.textContent = emojiValue;
  emoji.setAttribute("aria-hidden", "true");
  return emoji;
}

function renderIconValue(container, iconValue, fallback = "📄") {
  container.replaceChildren(createIconVisual(iconValue, fallback));
}

function hydrateAccordionIcons(root = document) {
  root?.querySelectorAll?.(".rendered-accordion-item-icon[data-icon-value]").forEach((container) => {
    renderIconValue(container, container.dataset.iconValue, "📄");
  });
}

function renderIconLabel(container, iconValue, fallback, labelText) {
  const icon = document.createElement("span");
  icon.className = "app-inline-icon";
  renderIconValue(icon, iconValue, fallback);
  const label = document.createElement("span");
  label.className = "app-icon-label-text";
  label.textContent = labelText;
  container.replaceChildren(icon, label);
}

function normalizeCustomIconLibraryValue(value) {
  const source = getCustomImageSource(value);
  return source ? `${imageIconPrefix}${source}` : null;
}

function mergeCustomIconLibraryEntries(...groups) {
  const entriesByValue = new Map();

  for (const entries of groups) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const value = normalizeCustomIconLibraryValue(entry?.value);
      if (!value) continue;
      const lastUsedAt = Number(entry?.lastUsedAt);
      const timestamp = Number.isFinite(lastUsedAt) && lastUsedAt > 0 ? lastUsedAt : 0;
      const previous = entriesByValue.get(value);
      if (!previous || timestamp > previous.lastUsedAt) {
        entriesByValue.set(value, { value, lastUsedAt: timestamp });
      }
    }
  }

  return [...entriesByValue.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, customIconLibraryLimit);
}

function collectWorkspaceCustomIconLibraryEntries() {
  const userId = state.user?.id;
  if (!userId) return [];

  const entries = [];
  const add = (value, updatedAt) => {
    const normalized = normalizeCustomIconLibraryValue(value);
    if (!normalized) return;
    const timestamp = Date.parse(updatedAt ?? "");
    entries.push({
      value: normalized,
      lastUsedAt: Number.isFinite(timestamp) ? timestamp : 0
    });
  };

  add(state.user?.defaultCollectionIcon, state.user?.updatedAt);
  for (const page of state.allPages) {
    if (page?.ownerId === userId) add(page.icon, page.updatedAt);
  }
  if (state.selectedPage?.ownerId === userId) add(state.selectedPage.icon, state.selectedPage.updatedAt);

  return mergeCustomIconLibraryEntries(entries);
}

function renderCustomIconLibrary() {
  const entries = state.customIconLibrary;
  elements.emojiCustomLibraryCount.textContent = t("emoji.customLibraryCount", {
    count: formatNumber(entries.length)
  });

  const fragment = document.createDocumentFragment();
  entries.forEach((entry, index) => {
    const item = document.createElement("div");
    item.className = "custom-icon-library-item";
    item.setAttribute("role", "none");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-option custom-icon-option";
    button.dataset.customIconIndex = String(index);
    const label = t("emoji.customLibraryItem", { index: formatNumber(index + 1) });
    button.setAttribute("aria-label", label);
    button.title = label;
    renderIconValue(button, entry.value, "📄");

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "custom-icon-library-remove";
    removeButton.dataset.customIconRemoveIndex = String(index);
    removeButton.setAttribute("aria-label", t("emoji.customLibraryRemove", { index: formatNumber(index + 1) }));
    removeButton.title = t("emoji.customLibraryRemoveShort");
    removeButton.disabled = state.customIconLibraryRemovingValues.has(entry.value);
    const removeGlyph = document.createElement("span");
    removeGlyph.textContent = "×";
    removeGlyph.setAttribute("aria-hidden", "true");
    removeButton.append(removeGlyph);

    item.append(button, removeButton);
    fragment.append(item);
  });

  elements.emojiCustomLibraryGrid.replaceChildren(fragment);
  elements.emojiCustomLibraryGrid.classList.toggle("hidden", entries.length === 0);
  elements.emojiCustomLibraryEmpty.classList.toggle("hidden", entries.length > 0);
}

async function refreshCustomIconLibrary() {
  const userId = state.user?.id ?? null;
  const generation = ++customIconLibraryLoadGeneration;

  if (state.customIconLibraryUserId !== userId) {
    state.customIconLibraryUserId = userId;
    state.customIconLibrary = [];
    state.customIconLibraryRemovedKeys = new Set();
    state.customIconLibraryRemovingValues = new Set();
  }

  const workspaceEntries = collectWorkspaceCustomIconLibraryEntries();
  if (!userId) {
    state.customIconLibrary = mergeCustomIconLibraryEntries(workspaceEntries, state.customIconLibrary);
    if (state.activeIconPickerTab === "custom") renderCustomIconLibrary();
    return;
  }

  try {
    const libraryState = await listCustomIconLibrary(userId);
    if (generation !== customIconLibraryLoadGeneration || state.user?.id !== userId) return;
    state.customIconLibraryRemovedKeys = new Set(libraryState.removedKeys);
    const mergedEntries = mergeCustomIconLibraryEntries(libraryState.entries, workspaceEntries, state.customIconLibrary);
    state.customIconLibrary = await filterRemovedCustomIconLibraryEntries(mergedEntries, state.customIconLibraryRemovedKeys);
    if (generation !== customIconLibraryLoadGeneration || state.user?.id !== userId) return;
    if (state.activeIconPickerTab === "custom") renderCustomIconLibrary();
    void rememberCustomIconLibraryEntries(userId, workspaceEntries).catch(() => {});
  } catch (error) {
    if (Number(error?.status ?? 0) === 401 && state.user?.id === userId) {
      resetAuthenticationSessionState();
      return;
    }
    // The workspace-derived list still provides reuse when the server library is unavailable.
    state.customIconLibrary = mergeCustomIconLibraryEntries(workspaceEntries, state.customIconLibrary);
    if (state.activeIconPickerTab === "custom") renderCustomIconLibrary();
  }
}

function rememberCustomIconSelection(value) {
  const normalized = normalizeCustomIconLibraryValue(value);
  const userId = state.user?.id;
  if (!normalized || !userId) return;

  if (state.customIconLibraryUserId !== userId) {
    state.customIconLibraryUserId = userId;
    state.customIconLibrary = [];
  }

  const entry = { value: normalized, lastUsedAt: Date.now() };
  state.customIconLibrary = mergeCustomIconLibraryEntries([entry], state.customIconLibrary);
  if (state.activeIconPickerTab === "custom") renderCustomIconLibrary();
  void rememberCustomIconLibraryEntry(userId, normalized, entry.lastUsedAt)
    .then(() => refreshCustomIconLibrary())
    .catch(() => {});
}

function isEmojiIconValue(value) {
  return typeof value === "string" && !value.startsWith(builtInIconPrefix) && !value.startsWith(imageIconPrefix) && emojiRecordByValue.has(value);
}

function getStoredEmojiSkinTone() {
  const value = readJsonStorage(getUserScopedStorageKey(emojiSkinToneStorageKey), "");
  return emojiSkinToneModifiers.includes(value) ? value : "";
}

function recordMatchesEmojiSkinTone(record) {
  const recordTone = emojiSkinToneModifiers.find((modifier) => record[0].includes(modifier));
  return !state.emojiSkinTone || !recordTone || recordTone === state.emojiSkinTone;
}

function filterEmojiResultsForSkinTone(indices) {
  return indices.filter((index) => {
    const record = emojiRecords[index];
    return record && recordMatchesEmojiSkinTone(record);
  });
}

function getEmojiResults() {
  const query = normalizeEmojiSearch(elements.emojiSearchInput.value);
  if (state.activeIconPickerTab === "icons") {
    if (query) {
      const terms = query.split(/\s+/).filter(Boolean);
      return iconSearchIndex.reduce((matches, searchText, index) => {
        if (terms.every((term) => searchText.includes(term))) matches.push(index);
        return matches;
      }, []);
    }
    return iconRecords.reduce((matches, record, index) => {
      if (record.category === state.activeIconCategory) matches.push(index);
      return matches;
    }, []);
  }

  let results;
  if (query) {
    const terms = query.split(/\s+/).filter(Boolean);
    results = emojiSearchIndex.reduce((matches, searchText, index) => {
      if (terms.every((term) => searchText.includes(term))) matches.push(index);
      return matches;
    }, []);
  } else if (state.activeEmojiCategory === "recent") {
    results = getRecentEmojis()
      .map((emoji) => emojiRecordByValue.get(emoji)?.index)
      .filter((index) => Number.isInteger(index));
  } else {
    const group = emojiCategoryById.get(state.activeEmojiCategory)?.group;
    results = emojiRecords.reduce((matches, record, index) => {
      if (record[1] === group) matches.push(index);
      return matches;
    }, []);
  }

  return filterEmojiResultsForSkinTone(results);
}

function renderEmojiCategories() {
  const isIcons = state.activeIconPickerTab === "icons";
  const definitions = isIcons ? iconCategoryDefinitions : emojiCategoryDefinitions;
  const activeCategory = isIcons ? state.activeIconCategory : state.activeEmojiCategory;
  const fragment = document.createDocumentFragment();

  for (const category of definitions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-category-button";
    button.classList.toggle("active", activeCategory === category.id);
    button.dataset.emojiCategory = category.id;
    if (isIcons) renderIconValue(button, `${builtInIconPrefix}${category.icon}`, "◇");
    else renderEmojiVisual(button, category.icon);
    const label = isIcons ? getIconCategoryLabel(category) : getEmojiCategoryLabel(category);
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(activeCategory === category.id));
    fragment.append(button);
  }
  elements.emojiCategoryList.replaceChildren(fragment);
  elements.emojiCategoryList.setAttribute("aria-label", t(isIcons ? "emoji.iconCategories" : "emoji.categories"));
}

function createEmojiOption(recordIndex) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "emoji-option";
  button.setAttribute("role", "option");

  if (state.activeIconPickerTab === "icons") {
    const record = iconRecords[recordIndex];
    if (!record) return null;
    button.classList.add("icon-option");
    button.dataset.iconName = record.name;
    renderIconValue(button, `${builtInIconPrefix}${record.name}`, "◇");
    const label = getIconRecordLabel(record);
    button.setAttribute("aria-label", label);
    button.title = getLanguage() === "ko" ? `${label} · ${record.labelEn}` : label;
    return button;
  }

  const record = emojiRecords[recordIndex];
  if (!record) return null;
  button.dataset.emojiIndex = String(recordIndex);
  renderEmojiVisual(button, record[0]);
  const localizedLabel = getEmojiRecordLabel(record);
  button.setAttribute("aria-label", localizedLabel);
  button.title = getLanguage() === "ko" && record[3] ? `${localizedLabel} · ${record[3]}` : localizedLabel;
  return button;
}

function appendEmojiBatch() {
  if (state.emojiRenderedCount >= state.emojiPickerResults.length) return;

  const nextCount = Math.min(state.emojiRenderedCount + emojiBatchSize, state.emojiPickerResults.length);
  const fragment = document.createDocumentFragment();
  for (let position = state.emojiRenderedCount; position < nextCount; position += 1) {
    const button = createEmojiOption(state.emojiPickerResults[position]);
    if (button) fragment.append(button);
  }

  elements.emojiGrid.append(fragment);
  state.emojiRenderedCount = nextCount;
}

function renderEmojiSkinToneControl() {
  renderEmojiVisual(elements.emojiSkinToneButton, `👋${state.emojiSkinTone}`);
  elements.emojiSkinToneMenu.querySelectorAll("[data-emoji-skin-tone]").forEach((button) => {
    renderEmojiVisual(button, `👋${button.dataset.emojiSkinTone ?? ""}`);
    button.setAttribute("aria-checked", String(button.dataset.emojiSkinTone === state.emojiSkinTone));
  });
}

function hideEmojiSkinToneMenu() {
  elements.emojiSkinToneMenu.classList.add("hidden");
  elements.emojiSkinToneButton.setAttribute("aria-expanded", "false");
}

function renderRecentEmojiSection() {
  if (state.activeIconPickerTab !== "emojis") {
    elements.emojiRecentGrid.replaceChildren();
    elements.emojiRecentSection.classList.add("hidden");
    return;
  }

  const query = normalizeEmojiSearch(elements.emojiSearchInput.value);
  const shouldShow = !query && state.activeEmojiCategory !== "recent";
  const indices = shouldShow
    ? filterEmojiResultsForSkinTone(
        getRecentEmojis()
          .map((emoji) => emojiRecordByValue.get(emoji)?.index)
          .filter((index) => Number.isInteger(index))
      ).slice(0, 16)
    : [];

  elements.emojiRecentGrid.replaceChildren(
    ...indices.map((index) => createEmojiOption(index)).filter(Boolean)
  );
  elements.emojiRecentSection.classList.toggle("hidden", indices.length === 0);
}

function renderEmojiPickerResults() {
  const isIcons = state.activeIconPickerTab === "icons";
  state.emojiPickerResults = getEmojiResults();
  state.emojiRenderedCount = 0;
  elements.emojiGrid.replaceChildren();

  const query = normalizeEmojiSearch(elements.emojiSearchInput.value);
  const category = isIcons
    ? iconCategoryById.get(state.activeIconCategory)
    : emojiCategoryById.get(state.activeEmojiCategory);
  elements.emojiResultsTitle.textContent = query
    ? t("emoji.searchResults")
    : isIcons
      ? getIconCategoryLabel(category ?? iconCategoryDefinitions[0])
      : getEmojiCategoryLabel(category ?? emojiCategoryDefinitions[1]);
  elements.emojiResultsCount.textContent = t(isIcons ? "emoji.iconResultCount" : "emoji.resultCount", {
    count: formatNumber(state.emojiPickerResults.length)
  });
  elements.emojiEmpty.textContent = t(isIcons ? "emoji.iconEmpty" : "emoji.empty");
  elements.emojiGrid.setAttribute("aria-label", t(isIcons ? "emoji.iconResults" : "emoji.results"));
  elements.emojiEmpty.classList.toggle("hidden", state.emojiPickerResults.length > 0);
  elements.emojiGrid.classList.toggle("hidden", state.emojiPickerResults.length === 0);
  elements.emojiRandomButton.disabled = state.emojiPickerResults.length === 0 || state.emojiSaving;
  renderRecentEmojiSection();
  appendEmojiBatch();
  elements.emojiGrid.scrollTop = 0;
}

function renderIconPickerTabs() {
  const tabs = [elements.emojiTabEmojis, elements.emojiTabIcons, elements.emojiTabCustom];
  for (const tab of tabs) {
    const active = tab.dataset.iconPickerTab === state.activeIconPickerTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }

  const custom = state.activeIconPickerTab === "custom";
  elements.emojiBrowserPanel.classList.toggle("hidden", custom);
  elements.emojiCustomPanel.classList.toggle("hidden", !custom);
  if (!custom) {
    const tabId = state.activeIconPickerTab === "icons" ? "emoji-tab-icons" : "emoji-tab-emojis";
    elements.emojiBrowserPanel.setAttribute("aria-labelledby", tabId);
  }
}

function renderCustomIconPreview(value = state.emojiPickerTarget?.currentEmoji) {
  renderIconValue(
    elements.emojiCustomPreview,
    value,
    state.emojiPickerTarget?.defaultEmoji ?? "📄"
  );
}

function setCustomIconMessage(message = "", isError = false) {
  elements.emojiCustomMessage.textContent = message;
  elements.emojiCustomMessage.classList.toggle("error", isError);
}

function renderEmojiPicker() {
  renderIconPickerTabs();
  if (state.activeIconPickerTab === "custom") {
    renderCustomIconPreview();
    renderCustomIconLibrary();
    return;
  }

  const isIcons = state.activeIconPickerTab === "icons";
  elements.emojiSearchLabelText.textContent = t(isIcons ? "emoji.iconSearchLabel" : "emoji.searchLabel");
  elements.emojiSearchInput.setAttribute("aria-label", t(isIcons ? "emoji.iconSearchLabel" : "emoji.searchLabel"));
  elements.emojiSearchInput.setAttribute("placeholder", t(isIcons ? "emoji.iconSearchPlaceholder" : "emoji.searchPlaceholder"));
  elements.emojiRandomButton.setAttribute("aria-label", t(isIcons ? "emoji.randomIcon" : "emoji.random"));
  elements.emojiRandomButton.setAttribute("title", t(isIcons ? "emoji.randomIcon" : "emoji.random"));
  elements.emojiSkinToneButton.closest(".emoji-skin-tone-control")?.classList.toggle("hidden", isIcons);
  if (isIcons) hideEmojiSkinToneMenu();
  else renderEmojiSkinToneControl();
  renderEmojiCategories();
  renderEmojiPickerResults();
}

function setIconPickerTab(tabName, { focus = true } = {}) {
  if (!["emojis", "icons", "custom"].includes(tabName)) return;
  if (state.activeIconPickerTab !== tabName) iconPickerOperationGuard.invalidate();
  state.activeIconPickerTab = tabName;
  elements.emojiSearchInput.value = "";
  hideEmojiSkinToneMenu();
  setCustomIconMessage();
  if (tabName === "icons" && !iconCategoryById.has(state.activeIconCategory)) state.activeIconCategory = "general";
  if (tabName === "emojis" && !emojiCategoryById.has(state.activeEmojiCategory)) state.activeEmojiCategory = "smileys-emotion";
  if (tabName === "custom") {
    const currentSource = getCustomImageSource(state.emojiPickerTarget?.currentEmoji);
    elements.emojiCustomUrlInput.value = currentSource?.startsWith("http") ? currentSource : "";
    elements.emojiCustomFileInput.value = "";
    void refreshCustomIconLibrary();
  }
  renderEmojiPicker();
  if (!focus) return;
  requestAnimationFrame(() => {
    if (tabName === "custom") elements.emojiCustomUrlInput.focus();
    else elements.emojiSearchInput.focus();
  });
}

function normalizeCustomIconUrl(value) {
  try {
    const source = value.trim();
    const url = new URL(source);
    if (
      source.length > customIconMaxUrlLength ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) return null;
    return `${imageIconPrefix}${url.toString()}`;
  } catch {
    return null;
  }
}

function hasValidIcoStructure(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return false;
  const imageCount = view.getUint16(4, true);
  const directoryEnd = 6 + imageCount * 16;
  if (!imageCount || directoryEnd > bytes.byteLength) return false;

  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16;
    const imageSize = view.getUint32(entryOffset + 8, true);
    const imageOffset = view.getUint32(entryOffset + 12, true);
    if (
      !imageSize
      || imageOffset < directoryEnd
      || imageOffset > bytes.byteLength
      || imageSize > bytes.byteLength - imageOffset
    ) return false;
  }
  return true;
}

function detectCustomIconMimeType(bytes) {
  if (
    bytes.byteLength >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.byteLength >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  if (hasValidIcoStructure(bytes)) return "image/vnd.microsoft.icon";
  return null;
}

function isSupportedCustomIconFile(file) {
  const mimeType = String(file?.type ?? "").trim().toLowerCase();
  if (customIconMimeTypes.includes(mimeType)) return true;
  return /\.(?:png|jpe?g|webp|ico)$/i.test(String(file?.name ?? ""));
}

async function validateCustomIconFileContents(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return Boolean(detectCustomIconMimeType(bytes));
}

async function uploadCustomIconFile(file) {
  const formData = new FormData();
  formData.append("icon", file, file.name || "icon");
  const data = await api("/api/custom-icons", {
    method: "POST",
    body: formData
  });
  const value = data?.icon?.value;
  if (typeof value !== "string" || !value.startsWith(`${imageIconPrefix}/upload/icons/`) || !getCustomImageSource(value)) {
    throw new Error(t("errors.invalidResponse"));
  }
  return value;
}


function positionEmojiPicker(trigger) {
  elements.emojiPicker.style.removeProperty("--emoji-picker-left");
  elements.emojiPicker.style.removeProperty("--emoji-picker-top");
  if (window.matchMedia("(max-width: 560px)").matches || !(trigger instanceof HTMLElement)) return;

  const rect = trigger.getBoundingClientRect();
  const pickerWidth = Math.min(432, window.innerWidth - 24);
  const pickerHeight = Math.min(560, window.innerHeight - 24);
  const halfWidth = pickerWidth / 2;
  const halfHeight = pickerHeight / 2;
  const centerX = Math.min(window.innerWidth - halfWidth - 12, Math.max(halfWidth + 12, rect.left + rect.width / 2));
  const belowCenter = rect.bottom + 10 + halfHeight;
  const aboveCenter = rect.top - 10 - halfHeight;
  const centerY = belowCenter <= window.innerHeight - 12
    ? belowCenter
    : Math.max(halfHeight + 12, aboveCenter);

  elements.emojiPicker.style.setProperty("--emoji-picker-left", `${centerX}px`);
  elements.emojiPicker.style.setProperty("--emoji-picker-top", `${centerY}px`);
}

function openEmojiPicker(target, trigger) {
  iconPickerOperationGuard.invalidate();
  state.emojiPickerTarget = target;
  state.emojiPickerReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  state.emojiSkinTone = getStoredEmojiSkinTone();
  state.activeIconPickerTab = "emojis";
  state.activeEmojiCategory = "smileys-emotion";
  state.activeIconCategory = "general";
  elements.emojiSearchInput.value = "";
  elements.emojiCustomUrlInput.value = "";
  elements.emojiCustomFileInput.value = "";
  setCustomIconMessage();
  hideEmojiSkinToneMenu();

  elements.emojiPickerLayer.classList.remove("hidden");
  elements.emojiPickerLayer.setAttribute("aria-hidden", "false");
  elements.emojiPicker.toggleAttribute("aria-busy", state.emojiSaving);
  elements.emojiResetButton.disabled = state.emojiSaving;
  elements.emojiCustomUrlButton.disabled = state.emojiSaving;
  elements.emojiCustomUploadButton.disabled = state.emojiSaving;
  renderEmojiPicker();
  positionEmojiPicker(trigger);
  requestAnimationFrame(() => elements.emojiSearchInput.focus());
}

function closeEmojiPicker({ restoreFocus = true } = {}) {
  if (elements.emojiPickerLayer.classList.contains("hidden")) return;
  iconPickerOperationGuard.invalidate();
  elements.emojiPickerLayer.classList.add("hidden");
  elements.emojiPickerLayer.setAttribute("aria-hidden", "true");
  const returnFocus = state.emojiPickerReturnFocus;
  state.emojiPickerTarget = null;
  state.emojiPickerReturnFocus = null;
  state.emojiPickerResults = [];
  elements.emojiCustomFileInput.value = "";
  setCustomIconMessage();
  hideEmojiSkinToneMenu();
  if (restoreFocus && returnFocus instanceof HTMLElement) returnFocus.focus();
}

function openAccordionItemIconPicker(row, itemId, trigger) {
  if (!row?.dataset.blockId || !itemId || !state.selectedPage || !requireWritablePage()) return;
  const data = extractAccordionData(row);
  const item = data.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  openEmojiPicker(
    {
      type: "accordionItem",
      pageId: state.selectedPage.id,
      blockId: row.dataset.blockId,
      itemId,
      currentEmoji: item.icon ?? "📄",
      defaultEmoji: "📄"
    },
    trigger
  );
}

function openPageEmojiPicker(page, trigger) {
  if (!page) return;
  if (state.selectedPage?.id === page.id && !isCollectionPage(page) && !requireWritablePage()) return;
  openEmojiPicker(
    {
      type: "page",
      pageId: page.id,
      currentEmoji: page.icon ?? (isCollectionPage(page) ? "📁" : "📄"),
      defaultEmoji: isCollectionPage(page) ? "📁" : "📄",
      isCollection: isCollectionPage(page)
    },
    trigger
  );
}

async function saveEmojiSelection(emoji, { operation = null } = {}) {
  const target = state.emojiPickerTarget;
  if (!target || state.emojiSaving) return;
  const targetKey = getIconPickerTargetKey(target);
  const activeOperation = operation ?? iconPickerOperationGuard.begin(targetKey);
  if (!iconPickerOperationGuard.isCurrent(activeOperation, targetKey)) return;

  state.emojiSaving = true;
  elements.emojiPicker.setAttribute("aria-busy", "true");
  elements.emojiResetButton.disabled = true;
  elements.emojiRandomButton.disabled = true;
  elements.emojiCustomUrlButton.disabled = true;
  elements.emojiCustomUploadButton.disabled = true;

  try {
    if (target.type === "defaultCollection") {
      const accountTargetKey = getAccountAvatarTargetKey(state.user);
      if (!accountTargetKey) return;
      const result = await enqueueAccountProfilePatch(accountTargetKey, {
        defaultCollectionIcon: emoji
      });
      if (!result.applied) return;
      const data = result.value;
      state.user = data.user;
      if (isEmojiIconValue(emoji)) rememberRecentEmoji(emoji);
      else if (getCustomImageSource(emoji)) rememberCustomIconSelection(emoji);
      renderDefaultCollection();
      syncVisibleBlocksToState();
      renderSelectedPage();
      if (iconPickerOperationGuard.isCurrent(activeOperation, targetKey)) {
        closeEmojiPicker({ restoreFocus: false });
        elements.collectionIconButton.focus();
      }
      setStatus(t("emoji.collectionSaved"));
      return;
    }

    if (target.type === "accordionItem") {
      if (state.selectedPage?.id !== target.pageId || !requireWritablePage()) return;
      const row = elements.blockList.querySelector(`[data-block-id="${CSS.escape(target.blockId)}"]`);
      if (!row || row.dataset.blockType !== "ACCORDION" || !promoteBlockDraftConflict(row)) return;
      if (!setAccordionItemIcon(row, target.itemId, emoji, renderIconValue)) return;
      if (isEmojiIconValue(emoji)) rememberRecentEmoji(emoji);
      else if (getCustomImageSource(emoji)) rememberCustomIconSelection(emoji);
      await saveBlockRow(row, { quiet: true });
      if (iconPickerOperationGuard.isCurrent(activeOperation, targetKey)) {
        closeEmojiPicker({ restoreFocus: false });
        row.querySelector(`[data-action="accordion-pick-icon"][data-accordion-item-id="${CSS.escape(target.itemId)}"]`)?.focus();
      }
      setStatus(t("accordion.iconSaved"));
      return;
    }

    if (state.selectedPage?.id === target.pageId && !isCollectionPage(state.selectedPage) && !requireWritablePage()) return;
    const savePageEmoji = async () => {
      const currentPage = state.selectedPage?.id === target.pageId
        ? state.selectedPage
        : state.allPages.find((page) => page.id === target.pageId);

      const data = await api(`/api/pages/${target.pageId}`, {
        method: "PATCH",
        body: { icon: emoji, expectedVersion: currentPage?.version }
      });
      if (state.selectedPage?.id === data.page.id) state.selectedPage = data.page;
      applyPageSummaryUpdate(data.page.id, {
        icon: data.page.icon,
        isCollection: data.page.isCollection,
        version: data.page.version,
        updatedAt: data.page.updatedAt
      });
      if (isEmojiIconValue(emoji)) rememberRecentEmoji(emoji);
      else if (getCustomImageSource(emoji)) rememberCustomIconSelection(emoji);
      renderSelectedPage();
      if (iconPickerOperationGuard.isCurrent(activeOperation, targetKey)) {
        closeEmojiPicker({ restoreFocus: false });
        (target.isCollection ? elements.collectionIconButton : elements.pageIconButton).focus();
      }
      setStatus(t(target.isCollection ? "emoji.collectionSaved" : "emoji.pageSaved"));
    };

    if (state.selectedPage?.id === target.pageId) await withPageEditLock(savePageEmoji);
    else await savePageEmoji();
  } catch (error) {
    setStatus(error.message, true);
    if (
      state.activeIconPickerTab === "custom"
      && iconPickerOperationGuard.isCurrent(activeOperation, getIconPickerTargetKey(state.emojiPickerTarget))
    ) {
      setCustomIconMessage(error.message, true);
    }
  } finally {
    state.emojiSaving = false;
    elements.emojiPicker.removeAttribute("aria-busy");
    elements.emojiResetButton.disabled = false;
    elements.emojiCustomUrlButton.disabled = false;
    elements.emojiCustomUploadButton.disabled = false;
    elements.emojiRandomButton.disabled = state.activeIconPickerTab === "custom"
      || state.emojiPickerResults.length === 0;
  }
}

function handleEmojiPickerKeydown(event) {
  if (elements.emojiPickerLayer.classList.contains("hidden")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (!elements.emojiSkinToneMenu.classList.contains("hidden")) {
      hideEmojiSkinToneMenu();
      elements.emojiSkinToneButton.focus();
    } else {
      closeEmojiPicker();
    }
    return;
  }

  if (event.key !== "Tab") return;
  const focusable = [...elements.emojiPicker.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.closest(".hidden"));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function renderDefaultCollection() {
  elements.collectionCount.textContent = String(getDefaultCollectionPages().length);
  renderIconLabel(
    elements.defaultCollectionHeading,
    getDefaultCollectionEmoji(),
    "📁",
    getDefaultCollectionName()
  );
  const isActive = state.workspaceView === "collection" && state.activeCollectionId === defaultCollectionKey;
  elements.defaultCollectionButton.classList.toggle("active", isActive);
  elements.defaultCollectionButton.closest(".collection-title-row")?.classList.toggle("active", isActive);
}

function makeNavigationMenuButton({ id, kind, title }) {
  const labelKey = kind === "collection" ? "navigationMenu.openCollection" : "navigationMenu.openPage";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "navigation-more-button";
  button.dataset.navigationMenuId = id;
  button.dataset.navigationMenuKind = kind;
  button.dataset.navigationMenuTitle = title;
  button.setAttribute("aria-label", t(labelKey, { title }));
  button.setAttribute("title", t(labelKey, { title }));
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "navigation-context-menu");
  button.setAttribute("aria-grabbed", "false");
  button.dataset.navigationOrderId = id;
  button.textContent = "⋮";
  return button;
}

function makeDocumentChildrenToggle({ page, expanded, controlsId }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "doc-expand-button";
  button.dataset.pageChildrenToggleId = page.id;
  button.dataset.pageChildrenToggleTitle = page.title;
  button.setAttribute("aria-controls", controlsId);
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute(
    "aria-label",
    t(expanded ? "navigation.collapseSubpages" : "navigation.expandSubpages", { title: page.title })
  );
  button.setAttribute(
    "title",
    t(expanded ? "navigation.collapseSubpages" : "navigation.expandSubpages", { title: page.title })
  );

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6.75 8.5 17.25 8.5 12 14.5Z");
  icon.append(path);
  button.append(icon);
  button.classList.toggle("collapsed", !expanded);
  return button;
}

function setNavigationSubpagesExpanded(pageId, expanded) {
  if (!pageId) return;
  if (expanded) state.collapsedNavigationPageIds.delete(pageId);
  else state.collapsedNavigationPageIds.add(pageId);
  persistNavigationPreference(pageId, !expanded);

  const selector = `[data-page-children-toggle-id="${CSS.escape(pageId)}"]`;
  for (const button of document.querySelectorAll(selector)) {
    const title = button.dataset.pageChildrenToggleTitle || t("newDocumentTitle");
    const label = t(expanded ? "navigation.collapseSubpages" : "navigation.expandSubpages", { title });
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.classList.toggle("collapsed", !expanded);

    const controlsId = button.getAttribute("aria-controls");
    if (controlsId) document.getElementById(controlsId)?.classList.toggle("hidden", !expanded);
  }
}


function renderDocumentNode(page, groups, depth = 0) {
  const wrapper = document.createElement("div");
  wrapper.className = "document-node";
  wrapper.dataset.navigationOrderId = page.id;
  wrapper.style.setProperty("--depth", String(depth));

  const row = document.createElement("div");
  row.className = "document-item-row";

  const children = groups.get(page.id) ?? [];
  const expanded = children.length > 0 && !state.collapsedNavigationPageIds.has(page.id);
  const childrenId = children.length ? `document-children-${++documentChildrenRenderId}` : null;
  const isActive = state.selectedPage?.id === page.id;
  row.classList.toggle("has-children", children.length > 0);
  row.classList.toggle("active", isActive);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "document-item";
  button.classList.toggle("active", isActive);
  button.dataset.pageId = page.id;

  const icon = document.createElement("span");
  icon.className = "doc-icon";
  renderIconValue(icon, page.icon, "📄");

  const label = document.createElement("span");
  label.className = "doc-label";
  label.textContent = page.title;

  if (children.length && childrenId) {
    row.append(makeDocumentChildrenToggle({ page, expanded, controlsId: childrenId }));
  }
  button.append(icon, label);
  row.append(button);
  if (isPageOwner(page)) {
    row.append(makeNavigationMenuButton({ id: page.id, kind: "page", title: page.title }));
  }
  wrapper.append(row);

  if (children.length) {
    const group = document.createElement("div");
    group.className = "document-children";
    group.id = childrenId;
    group.classList.toggle("hidden", !expanded);
    for (const child of children) group.append(renderDocumentNode(child, groups, depth + 1));
    wrapper.append(group);
  }

  return wrapper;
}

function renderCollectionSection(collection, pages) {
  const section = document.createElement("section");
  section.className = "nav-section custom-collection";
  section.dataset.navigationOrderId = collection.id;

  const row = document.createElement("div");
  row.className = "collection-title-row";

  const isActive = state.workspaceView === "collection" && state.activeCollectionId === collection.id;
  row.classList.toggle("active", isActive);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "collection-title-button";
  button.classList.toggle("active", isActive);
  button.dataset.collectionId = collection.id;

  const title = document.createElement("span");
  title.className = "collection-title-main";
  renderIconLabel(title, collection.icon, "📁", collection.title);

  const count = document.createElement("span");
  count.className = "count-pill";
  count.textContent = String(getCollectionPageCount(collection.id));

  button.append(title, count);
  row.append(
    button,
    makeNavigationMenuButton({ id: collection.id, kind: "collection", title: collection.title })
  );
  section.append(row);

  if (pages.length) {
    const tree = document.createElement("div");
    tree.className = "document-tree";
    const groups = buildPageTree(pages, { useNavigationOrder: true });
    for (const page of groups.get(rootParentKey) ?? []) {
      tree.append(renderDocumentNode(page, groups));
    }
    section.append(tree);
  }

  return section;
}

function renderDocumentTree() {
  closeNavigationContextMenu();
  elements.pageList.replaceChildren();
  elements.collectionList.replaceChildren();

  const collectionRoots = getRootCollections();
  const collectionPages = new Map(collectionRoots.map((collection) => [collection.id, []]));
  const matchedCollectionIds = new Set();
  const defaultPages = [];

  for (const page of state.pages) {
    const collectionId = getCollectionRootId(page.id);
    if (!collectionId) {
      defaultPages.push(page);
      continue;
    }

    matchedCollectionIds.add(collectionId);
    if (page.id !== collectionId) collectionPages.get(collectionId)?.push(page);
  }

  const defaultGroups = buildPageTree(defaultPages, { useNavigationOrder: true });
  const defaultRoots = defaultGroups.get(rootParentKey) ?? [];
  if (!defaultRoots.length) {
    const message = state.searchQuery || state.activeTag
      ? t("empty.noSearchResults")
      : t("empty.noDocumentsSidebar");
    elements.pageList.append(makeEmptyMessage(message));
  } else {
    for (const page of defaultRoots) elements.pageList.append(renderDocumentNode(page, defaultGroups));
  }

  const isFiltering = Boolean(state.searchQuery || state.activeTag);
  for (const collection of collectionRoots) {
    if (isFiltering && !matchedCollectionIds.has(collection.id)) continue;
    elements.collectionList.append(renderCollectionSection(collection, collectionPages.get(collection.id) ?? []));
  }
}


function getNavigationDragNode(handle) {
  const node = handle?.closest(".document-node, .custom-collection");
  if (!node?.dataset.navigationOrderId) return null;
  const container = node.parentElement;
  if (!container) return null;
  const validContainer = container === elements.pageList
    || container === elements.collectionList
    || container.classList.contains("document-tree")
    || container.classList.contains("document-children");
  return validContainer ? node : null;
}

function getNavigationSiblingNodes(node) {
  const container = node?.parentElement;
  if (!container) return [];
  return [...container.children].filter((candidate) => (
    candidate instanceof HTMLElement
    && Boolean(candidate.dataset.navigationOrderId)
  ));
}

function getNavigationInsertionIndex(clientY, candidates) {
  for (let index = 0; index < candidates.length; index += 1) {
    const anchor = candidates[index].querySelector(".document-item-row, .collection-title-row");
    const rect = (anchor ?? candidates[index]).getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return index;
  }
  return candidates.length;
}

function placeNavigationDropIndicator(drag) {
  if (!drag?.indicator || !drag.container) return;
  const candidate = drag.candidates[drag.targetIndex];
  if (candidate) {
    drag.container.insertBefore(drag.indicator, candidate);
    return;
  }
  const last = drag.candidates.at(-1);
  if (last) last.after(drag.indicator);
  else drag.container.insertBefore(drag.indicator, drag.node);
}

function autoScrollForNavigationDrag(clientY) {
  const scroller = elements.appSidebar?.querySelector(".sidebar-nav");
  if (!scroller) return;
  const rect = scroller.getBoundingClientRect();
  const edge = Math.min(64, Math.max(36, rect.height * 0.14));
  if (clientY < rect.top + edge) {
    scroller.scrollBy(0, -Math.max(5, (rect.top + edge - clientY) * 0.18));
  } else if (clientY > rect.bottom - edge) {
    scroller.scrollBy(0, Math.max(5, (clientY - (rect.bottom - edge)) * 0.18));
  }
}

function activateNavigationDrag(event) {
  const drag = activeNavigationDrag;
  if (!drag || drag.active || navigationOrderSaving) return false;

  const siblingNodes = getNavigationSiblingNodes(drag.node);
  if (siblingNodes.length < 2) return false;

  closeNavigationContextMenu();
  drag.active = true;
  drag.siblingNodes = siblingNodes;
  drag.candidates = siblingNodes.filter((node) => node !== drag.node);
  drag.initialIndex = siblingNodes.indexOf(drag.node);
  drag.targetIndex = drag.initialIndex;
  drag.indicator = document.createElement("div");
  drag.indicator.className = "navigation-drop-indicator";
  drag.indicator.setAttribute("aria-hidden", "true");
  drag.indicator.style.setProperty("--navigation-drop-depth", drag.node.style.getPropertyValue("--depth") || "0");

  drag.node.classList.add("is-navigation-dragging");
  drag.handle.classList.add("is-pressed");
  drag.handle.setAttribute("aria-grabbed", "true");
  document.body.classList.add("is-navigation-dragging");
  placeNavigationDropIndicator(drag);
  event.preventDefault();
  return true;
}

function updateNavigationDrag(event) {
  const drag = activeNavigationDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;

  if (!drag.active) {
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    const threshold = event.pointerType === "touch" ? 7 : 4;
    if (distance < threshold) return;
    if (!activateNavigationDrag(event)) return;
  }

  event.preventDefault();
  drag.targetIndex = getNavigationInsertionIndex(event.clientY, drag.candidates);
  placeNavigationDropIndicator(drag);
  autoScrollForNavigationDrag(event.clientY);
}

function clearNavigationDragVisuals(drag) {
  if (!drag) return;
  drag.node?.classList.remove("is-navigation-dragging");
  drag.indicator?.remove();
  drag.handle?.classList.remove("is-pressed");
  drag.handle?.setAttribute("aria-grabbed", "false");
  document.body.classList.remove("is-navigation-dragging");
}

function snapshotNavigationPageOrder(pageIds) {
  return new Map(pageIds.map((pageId) => [
    pageId,
    state.navigationPageOrder.has(pageId)
      ? { present: true, value: state.navigationPageOrder.get(pageId) }
      : { present: false, value: null }
  ]));
}

function applyNavigationPageOrder(pageIds) {
  pageIds.forEach((pageId, index) => state.navigationPageOrder.set(pageId, index));
}

function restoreNavigationPageOrder(snapshot) {
  for (const [pageId, previous] of snapshot) {
    if (previous.present) state.navigationPageOrder.set(pageId, previous.value);
    else state.navigationPageOrder.delete(pageId);
  }
}

async function finishNavigationDrag(event, { cancelled = false } = {}) {
  const drag = activeNavigationDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  activeNavigationDrag = null;

  if (drag.handle.hasPointerCapture?.(drag.pointerId)) {
    drag.handle.releasePointerCapture(drag.pointerId);
  }

  if (!drag.active) {
    drag.handle.classList.remove("is-pressed");
    return;
  }

  event.preventDefault();
  suppressNavigationMenuClickUntil = Date.now() + 500;
  clearNavigationDragVisuals(drag);
  if (cancelled || drag.targetIndex === drag.initialIndex) return;

  const orderedIds = drag.candidates.map((node) => node.dataset.navigationOrderId);
  orderedIds.splice(drag.targetIndex, 0, drag.node.dataset.navigationOrderId);
  if (orderedIds.some((pageId) => !pageId)) return;

  const previousOrder = snapshotNavigationPageOrder(orderedIds);
  const authenticationScope = captureAuthenticatedSessionScope();
  applyNavigationPageOrder(orderedIds);
  renderPages();
  navigationOrderSaving = true;
  setStatus(t("status.savingNavigationOrder"));

  try {
    await api("/api/auth/navigation-order", {
      method: "PATCH",
      body: { pageIds: orderedIds }
    });
    if (isCurrentAuthenticatedSessionScope(authenticationScope)) {
      setStatus(t("status.navigationOrderChanged"));
    }
  } catch (error) {
    if (isCurrentAuthenticatedSessionScope(authenticationScope)) {
      restoreNavigationPageOrder(previousOrder);
      renderPages();
    }
    throw error;
  } finally {
    if (isCurrentAuthenticatedSessionScope(authenticationScope)) navigationOrderSaving = false;
  }
}

function renderSubpageIndexItem(page, groups, depth = 0) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "subpage-index-item";
  button.dataset.subpageIndexPageId = page.id;
  button.style.setProperty("--subpage-depth", String(depth));

  const icon = document.createElement("span");
  icon.className = "subpage-index-icon";
  icon.setAttribute("aria-hidden", "true");
  renderIconValue(icon, page.icon, "📄");

  const title = document.createElement("span");
  title.className = "subpage-index-title";
  title.textContent = page.title || t("newDocumentTitle");

  const arrow = document.createElement("span");
  arrow.className = "subpage-index-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";

  button.append(icon, title, arrow);

  const fragment = document.createDocumentFragment();
  fragment.append(button);
  for (const child of groups.get(page.id) ?? []) {
    fragment.append(renderSubpageIndexItem(child, groups, depth + 1));
  }
  return fragment;
}

function renderSubpageIndex(page = state.selectedPage) {
  elements.subpageIndexList.replaceChildren();
  if (!page || state.workspaceView !== "page") {
    elements.subpageIndex.classList.add("hidden");
    elements.subpageIndexCount.textContent = "";
    return;
  }

  const groups = buildPageTree(state.allPages);
  const children = groups.get(page.id) ?? [];
  if (!children.length) {
    elements.subpageIndex.classList.add("hidden");
    elements.subpageIndexCount.textContent = "";
    return;
  }

  let descendantCount = 0;
  const countDescendants = (parentId) => {
    for (const child of groups.get(parentId) ?? []) {
      descendantCount += 1;
      countDescendants(child.id);
    }
  };
  countDescendants(page.id);

  for (const child of children) {
    elements.subpageIndexList.append(renderSubpageIndexItem(child, groups));
  }
  elements.subpageIndexCount.textContent = formatNumber(descendantCount);
  elements.subpageIndex.classList.remove("hidden");
}

function renderParentOptions() {
  // BrainVault now uses one simple default collection. New documents are created directly as root documents.
}


function makeHomeDocumentButton(page) {
  const row = document.createElement("div");
  row.className = "home-document-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "home-row home-document-item";
  button.dataset.pageId = page.id;

  const title = document.createElement("strong");
  renderIconLabel(title, page.icon, isCollectionPage(page) ? "📁" : "📄", page.title);

  button.append(title);
  row.append(button);
  if (isPageOwner(page)) {
    row.append(
      makeNavigationMenuButton({
        id: page.id,
        kind: isCollectionPage(page) ? "collection" : "page",
        title: page.title
      })
    );
  }
  return row;
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

function getPageSubtreeIds(pageId, pages = state.allPages) {
  const ids = new Set([pageId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const page of pages) {
      if (!page.parentPageId || !ids.has(page.parentPageId) || ids.has(page.id)) continue;
      ids.add(page.id);
      changed = true;
    }
  }

  return ids;
}


function getPageActionsMenuItems() {
  return [...elements.pageActionsMenu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].filter(
    (item) => !item.disabled
  );
}

function isPageReadOnly() {
  return state.pageMode !== pageModes.WRITE;
}

function isPageOwner(page = state.selectedPage) {
  if (!page) return false;
  if (page.access && typeof page.access.isOwner === "boolean") return page.access.isOwner;
  return Boolean(state.user?.id && page.ownerId === state.user.id);
}

function isCollaborativePage(page = state.selectedPage) {
  return Boolean(page?.collaboration?.enabled);
}

function isCollaborationReady() {
  return !isCollaborativePage() || Boolean(state.collaborationSession?.isReady);
}

function getWorkspaceTransitionId(userId = state.user?.id) {
  return userId ? `${workspaceTransitionPagePrefix}:${userId}` : null;
}

function getPageWorkspaceTransitionId(page = state.selectedPage) {
  return getWorkspaceTransitionId(page?.ownerId ?? (isPageOwner(page) ? state.user?.id : null));
}

function isWorkspaceTransitionId(pageId) {
  return typeof pageId === "string" && pageId.startsWith(`${workspaceTransitionPagePrefix}:`);
}

function getPageTransitionBusyMessage(pageId) {
  return isWorkspaceTransitionId(pageId)
    ? t("status.workspaceTransitionBusy")
    : t("sharing.transitionBusy");
}

function assertBrowserRecoveryInspectionSafe(inspection) {
  if (inspection?.reliable && !(inspection.unreadableKeys?.length > 0)) return;
  throw new Error(t("status.localRecoveryInspectionFailed"));
}

function inspectPageTransitionSafely(pageId) {
  const inspection = pageTransitionLock.inspect(pageId);
  if (inspection.status === "invalid" || inspection.status === "error") {
    throw new Error(t("status.localRecoveryInspectionFailed"));
  }
  return inspection.status === "active" || inspection.status === "expired"
    ? inspection.record
    : null;
}

function inspectPageTransitionForStart(pageId) {
  const inspection = pageTransitionLock.inspect(pageId);
  if (inspection.status === "invalid" || inspection.status === "error") {
    throw new Error(t("status.localRecoveryInspectionFailed"));
  }
  // An expired lease is still an editor fence, but it may be reaped only after
  // this contender acquires every authoritative Web Lock used by old/new tabs.
  return inspection.status === "active" ? inspection.record : null;
}

function inspectPageTransitionForUi(pageId) {
  const inspection = pageTransitionLock.inspect(pageId);
  if (inspection.status === "active" || inspection.status === "expired") {
    return { locked: true, record: inspection.record };
  }
  if (inspection.status === "missing") return { locked: false, record: null };
  // A storage read or decode failure must never be interpreted as an unlocked
  // editor while a destructive operation may still be running in another tab.
  return { locked: true, record: null };
}

function getPageTransitionExclusiveIds(transition, page = null) {
  if (!transition?.pageId) return [];
  const transitionPage = page
    ?? (state.selectedPage?.id === transition.pageId ? state.selectedPage : null)
    ?? state.allPages.find((candidate) => candidate.id === transition.pageId)
    ?? null;
  const inferredWorkspaceId = isWorkspaceTransitionId(transition.pageId)
    ? transition.pageId
    : getPageWorkspaceTransitionId(transitionPage);
  const exclusiveId = transition.exclusiveId ?? inferredWorkspaceId;
  if (!exclusiveId) return [];
  // New page transitions intentionally hold both scopes. This also permits
  // safe cleanup of a pre-fix lease: older builds used either the page lock or
  // the owner workspace lock, so both must be observed free before deletion.
  return [...new Set([transition.pageId, exclusiveId])];
}

async function reapExpiredPageTransition(transition, page = null) {
  if (!transition?.pageId || !Number.isFinite(transition.expiresAt) || transition.expiresAt > Date.now()) {
    return false;
  }
  const exclusiveIds = getPageTransitionExclusiveIds(transition, page);
  if (!exclusiveIds.length) return false;
  const result = await pageTransitionLock.runExclusive(exclusiveIds, async () => {
    const current = pageTransitionLock.inspect(transition.pageId);
    if (current.status === "missing") return true;
    if (current.status !== "expired") return false;
    return pageTransitionLock.releaseExpired(transition.pageId);
  });
  return Boolean(result?.acquired && result.value);
}

function schedulePageTransitionUnlock(transition) {
  window.clearTimeout(pageTransitionUnlockTimer);
  pageTransitionUnlockTimer = null;
  if (!transition?.expiresAt) return;
  const isExpired = transition.expiresAt <= Date.now();
  const delay = isExpired
    ? 1_000
    : Math.max(0, transition.expiresAt - Date.now() + 25);
  pageTransitionUnlockTimer = window.setTimeout(() => {
    pageTransitionUnlockTimer = null;
    const cleanup = transition.expiresAt <= Date.now()
      ? reapExpiredPageTransition(transition)
      : Promise.resolve(false);
    void cleanup.catch(() => false).finally(() => syncPageModeUi());
  }, delay);
}

function isPagePersistenceTransitionLocked(page = state.selectedPage) {
  const workspaceTransitionId = getPageWorkspaceTransitionId(page);
  if (
    activePageTransitionLease?.pageId === page?.id
    || (workspaceTransitionId && activePageTransitionLease?.pageId === workspaceTransitionId)
  ) return true;
  const states = [
    page?.id ? inspectPageTransitionForUi(page.id) : null,
    workspaceTransitionId ? inspectPageTransitionForUi(workspaceTransitionId) : null
  ].filter(Boolean);
  const transitions = states.map((transitionState) => transitionState.record).filter(Boolean);
  const earliestExpiry = transitions.sort((left, right) => left.expiresAt - right.expiresAt)[0] ?? null;
  schedulePageTransitionUnlock(earliestExpiry);
  return states.some((transitionState) => transitionState.locked);
}

function isWorkspacePersistenceTransitionLocked() {
  const workspaceTransitionId = getWorkspaceTransitionId();
  if (!workspaceTransitionId) return false;
  if (activePageTransitionLease?.pageId === workspaceTransitionId) return true;
  const transitionState = inspectPageTransitionForUi(workspaceTransitionId);
  schedulePageTransitionUnlock(transitionState.record);
  return transitionState.locked;
}

async function assertWorkspacePersistenceUnlocked() {
  const workspaceTransitionId = getWorkspaceTransitionId();
  if (!workspaceTransitionId) return;
  let transition = inspectPageTransitionSafely(workspaceTransitionId);
  if (transition?.expiresAt <= Date.now()) {
    await reapExpiredPageTransition(transition);
    transition = inspectPageTransitionSafely(workspaceTransitionId);
  }
  if (transition) throw new Error(t("status.workspaceTransitionBusy"));
}

function isPageInteractionLocked() {
  return (
    state.pageModeChanging ||
    state.pageEditLockDepth > 0 ||
    blockOrderSaving ||
    isPagePersistenceTransitionLocked() ||
    (isCollaborativePage() && !isCollaborationReady())
  );
}

function canPersistSelectedPage() {
  return Boolean(state.selectedPage && state.workspaceView === "page" && !isPageReadOnly());
}

function canEditSelectedPage() {
  return canPersistSelectedPage() && !isPageInteractionLocked();
}

function reportReadOnlyBlocked() {
  if (isCollaborativePage() && !isCollaborationReady()) {
    setStatus(t("sharing.syncRequired"), true);
    return;
  }
  setStatus(t("status.readOnlyBlocked"));
}

function requireWritablePage({ announce = true } = {}) {
  if (canEditSelectedPage()) return true;
  if (announce && state.selectedPage && state.workspaceView === "page") reportReadOnlyBlocked();
  return false;
}

function setControlReadOnlyState(control, readOnly) {
  if (!(control instanceof HTMLElement)) return;

  if (control instanceof HTMLButtonElement || control instanceof HTMLSelectElement) {
    const allowedInReadMode = control.matches('[data-action="download-attachment"]');
    if (readOnly) {
      if (!control.dataset.pageModeWasDisabled) control.dataset.pageModeWasDisabled = String(control.disabled);
      if (!allowedInReadMode) control.disabled = true;
    } else if (control.dataset.pageModeWasDisabled) {
      control.disabled = control.dataset.pageModeWasDisabled === "true";
      delete control.dataset.pageModeWasDisabled;
    }
    return;
  }

  if (control instanceof HTMLInputElement) {
    if (["checkbox", "radio", "file", "button", "submit", "reset", "range"].includes(control.type)) {
      if (readOnly) {
        if (!control.dataset.pageModeWasDisabled) control.dataset.pageModeWasDisabled = String(control.disabled);
        control.disabled = true;
      } else if (control.dataset.pageModeWasDisabled) {
        control.disabled = control.dataset.pageModeWasDisabled === "true";
        delete control.dataset.pageModeWasDisabled;
      }
      return;
    }

    if (readOnly) {
      if (!control.dataset.pageModeWasReadOnly) control.dataset.pageModeWasReadOnly = String(control.readOnly);
      control.readOnly = true;
    } else if (control.dataset.pageModeWasReadOnly) {
      control.readOnly = control.dataset.pageModeWasReadOnly === "true";
      delete control.dataset.pageModeWasReadOnly;
    }
    return;
  }

  if (control instanceof HTMLTextAreaElement) {
    if (readOnly) {
      if (!control.dataset.pageModeWasReadOnly) control.dataset.pageModeWasReadOnly = String(control.readOnly);
      control.readOnly = true;
    } else if (control.dataset.pageModeWasReadOnly) {
      control.readOnly = control.dataset.pageModeWasReadOnly === "true";
      delete control.dataset.pageModeWasReadOnly;
    }
  }
}

function syncBlockReadOnlyState(row, readOnly = isPageReadOnly() || isPageInteractionLocked()) {
  if (!row) return;
  row.classList.toggle("is-read-only", readOnly);
  row.setAttribute("aria-readonly", String(readOnly));

  for (const control of row.querySelectorAll("input, textarea, select, button")) {
    setControlReadOnlyState(control, readOnly);
  }

  for (const draggable of row.querySelectorAll("[draggable]")) {
    if (readOnly) {
      if (!draggable.dataset.pageModeWasDraggable) {
        draggable.dataset.pageModeWasDraggable = String(draggable.draggable);
      }
      draggable.draggable = false;
    } else if (draggable.dataset.pageModeWasDraggable) {
      draggable.draggable = draggable.dataset.pageModeWasDraggable === "true";
      delete draggable.dataset.pageModeWasDraggable;
    }
  }

  for (const details of row.querySelectorAll("details:not(.rendered-toggle):not(.rendered-accordion-item)")) {
    if (readOnly) details.removeAttribute("open");
  }
}

function syncPageModeUi() {
  syncWorkspaceLocation();
  const readOnly = isPageReadOnly();
  const interactionLocked = isPageInteractionLocked();
  const controlsReadOnly = readOnly || interactionLocked;
  const modeLabelKey = readOnly ? "page.readMode" : "page.writeMode";
  const modeDescriptionKey = readOnly ? "page.readModeDescription" : "page.writeModeDescription";
  const owner = isPageOwner();

  elements.pageView.classList.toggle("is-read-only", readOnly);
  elements.pageView.classList.toggle("is-collaborative", isCollaborativePage());
  elements.pageView.classList.toggle("is-edit-locked", interactionLocked);
  elements.pageView.setAttribute("aria-busy", String(interactionLocked));
  elements.pageView.dataset.pageMode = state.pageMode;
  elements.pageTitle.readOnly = controlsReadOnly;
  elements.pageIconButton.disabled = controlsReadOnly || !owner;
  elements.savePageButton.disabled = controlsReadOnly;
  elements.savePageButton.classList.toggle("hidden", readOnly);
  elements.archivePageButton.disabled = controlsReadOnly || !owner;
  elements.archivePageButton.classList.toggle("hidden", !owner);
  elements.sharePageButton.classList.toggle("hidden", !state.selectedPage || !owner);
  elements.sharePageButton.disabled = interactionLocked;
  elements.pageVersionHistoryButton.classList.toggle("hidden", !state.selectedPage || !owner);
  elements.pageVersionHistoryButton.disabled = interactionLocked || !owner;
  elements.blockList.setAttribute("aria-readonly", String(controlsReadOnly));
  elements.blockList.setAttribute("aria-label", t(readOnly ? "page.readerAria" : "page.editorAria"));
  elements.blockEditorHelp.innerHTML = t(readOnly ? "page.readOnlyHelp" : "page.editorHelp");

  elements.pageModeToggle.disabled = interactionLocked;
  elements.pageModeToggle.setAttribute("aria-checked", String(!readOnly));
  elements.pageModeToggle.classList.toggle("is-write-mode", !readOnly);
  elements.pageModeToggleIcon.textContent = readOnly ? "◉" : "✎";
  elements.pageModeToggleLabel.textContent = t(modeLabelKey);
  elements.pageModeToggleDescription.textContent = t(modeDescriptionKey);
  elements.pageModeBadge.classList.toggle("is-write-mode", !readOnly);
  elements.pageModeBadgeLabel.textContent = t(modeLabelKey);
  syncPageCoverControls();

  for (const row of elements.blockList.querySelectorAll(".editor-block-row")) {
    syncBlockReadOnlyState(row, controlsReadOnly);
  }
  renderCollaborationChrome();
  requestAnimationFrame(() => hydrateMathExpressions(elements.pageView));

  if (readOnly) {
    closeSlashMenu();
    closeInlineToolbar();
    closeBlockContextMenu();
    closeKanbanCardStyleMenus();
  }
}

function hasPendingPageEdits() {
  if (!state.selectedPage || state.workspaceView !== "page") return false;
  if (isCollaborativePage()) return Boolean(state.collaborationSession?.hasPendingChanges);
  if (pageTitleSaveTimer !== null || pageTitleSaveQueue.busy || pageTitleSavedRevision < pageTitleEditRevision) return true;
  if (blockSaveTimers.size > 0) return true;
  if ([...blockSaveQueues.values()].some((queue) => queue.busy)) return true;
  if (pendingBlockOrderTask) return true;
  return Boolean(elements.blockList.querySelector(".editor-block-row.is-dirty"));
}

function handleBeforeUnload(event) {
  if (!hasPendingPageEdits()) return;
  event.preventDefault();
  event.returnValue = "";
}

function syncBeforeUnloadProtection() {
  const shouldProtect = hasPendingPageEdits();
  if (shouldProtect === beforeUnloadProtectionActive) return;
  beforeUnloadProtectionActive = shouldProtect;
  if (shouldProtect) window.addEventListener("beforeunload", handleBeforeUnload);
  else window.removeEventListener("beforeunload", handleBeforeUnload);
}

function getDraftScope(pageId = state.selectedPage?.id) {
  const userId = state.user?.id;
  return userId && pageId ? { userId, pageId } : null;
}

function getPositiveVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

function getLatestKnownVersion(...values) {
  const versions = values.map(getPositiveVersion).filter((version) => version !== null);
  return versions.length ? Math.max(...versions) : null;
}

function reportLocalDraftStorageFailure() {
  if (localDraftStorageWarningShown) return;
  localDraftStorageWarningShown = true;
  setStatus(t("status.localDraftStorageFailed"), true);
}

function checkDraftStoreWrite(succeeded) {
  if (!succeeded) reportLocalDraftStorageFailure();
  return succeeded;
}

function persistPageTitleDraft() {
  const scope = getDraftScope();
  if (!scope || !state.selectedPage) return false;
  const draftSourceId = pageTitleDraftSourceId || pageDraftSourceId;
  const storedDraft = pageDraftStore.loadPage(scope.userId, scope.pageId, draftSourceId)?.title;
  const expectedVersion = pageTitleDraftConflict
    ? getLatestKnownVersion(pageTitleDraftExpectedVersion, storedDraft?.expectedVersion)
    : getLatestKnownVersion(pageTitleDraftExpectedVersion, storedDraft?.expectedVersion, state.selectedPage.version);
  if (expectedVersion === null || pageTitleEditRevision < 1) return false;
  pageTitleDraftExpectedVersion = expectedVersion;
  return checkDraftStoreWrite(
    pageDraftStore.saveTitle({
      ...scope,
      sourceId: draftSourceId,
      value: normalizePageTitle(elements.pageTitle.value),
      expectedVersion,
      revision: pageTitleEditRevision
    })
  );
}

function persistBlockDraft(row, payload = null) {
  const scope = getDraftScope();
  const blockId = row?.dataset.blockId;
  const editRevision = Number.parseInt(row?.dataset.editRevision ?? "0", 10) || 0;
  if (!scope || !blockId || editRevision < 1) return false;
  const draftSourceId = row.dataset.draftSourceId || pageDraftSourceId;
  const storedDraft = pageDraftStore.loadPage(scope.userId, scope.pageId, draftSourceId)?.blocks?.[blockId];
  const expectedVersion = row.dataset.draftConflict === "true"
    ? getLatestKnownVersion(row.dataset.draftExpectedVersion, storedDraft?.expectedVersion)
    : getLatestKnownVersion(row.dataset.draftExpectedVersion, storedDraft?.expectedVersion, getBlockById(blockId)?.version);
  if (expectedVersion === null) return false;
  row.dataset.draftExpectedVersion = String(expectedVersion);
  row.dataset.draftSourceId = draftSourceId;
  const saved = checkDraftStoreWrite(
    pageDraftStore.saveBlock({
      ...scope,
      sourceId: draftSourceId,
      blockId,
      payload: payload ?? buildBlockPayload(row),
      expectedVersion,
      revision: editRevision
    })
  );
  if (saved) blockDraftRenderSources.set(blockId, draftSourceId);
  return saved;
}

function confirmRecoveredDraftOverwrite() {
  return window.confirm(t("confirm.overwriteRecoveredDraft"));
}

function promotePageTitleDraftConflict() {
  if (!pageTitleDraftConflict) return true;
  if (!confirmRecoveredDraftOverwrite()) {
    setStatus(t("status.localDraftOverwriteCancelled"), true);
    return false;
  }
  const previousSourceId = pageTitleDraftSourceId;
  const previousExpectedVersion = pageTitleDraftExpectedVersion;
  pageTitleDraftConflict = false;
  pageTitleDraftSourceId = pageDraftSourceId;
  pageTitleDraftExpectedVersion = getPositiveVersion(state.selectedPage?.version);
  elements.pageTitle.classList.remove("save-error");
  if (!persistPageTitleDraft()) {
    pageTitleDraftConflict = true;
    pageTitleDraftSourceId = previousSourceId;
    pageTitleDraftExpectedVersion = previousExpectedVersion;
    elements.pageTitle.classList.add("save-error");
    return false;
  }
  return true;
}

function promoteBlockDraftConflict(row) {
  const blockId = row?.dataset.blockId;
  const storedOrigin = blockId ? blockDraftConflictOrigins.get(blockId) : null;
  const hasStoredConflict = Boolean(storedOrigin && storedOrigin.resolved !== true);
  if (row?.dataset.draftConflict !== "true" && !hasStoredConflict) return true;

  if (row.dataset.draftConflict !== "true" && storedOrigin) {
    const scope = getDraftScope();
    const currentDraft = scope
      ? pageDraftStore.loadPage(scope.userId, scope.pageId, pageDraftSourceId)?.blocks?.[blockId]
      : null;
    row.dataset.draftConflict = "true";
    row.dataset.draftSourceId = pageDraftSourceId;
    row.dataset.draftExpectedVersion = String(currentDraft?.expectedVersion ?? storedOrigin.expectedVersion);
    row.dataset.editRevision = String(currentDraft?.revision ?? storedOrigin.revision);
    row.classList.add("is-dirty", "save-error");
  }
  if (!confirmRecoveredDraftOverwrite()) {
    setStatus(t("status.localDraftOverwriteCancelled"), true);
    return false;
  }
  const conflictOrigin = blockDraftConflictOrigins.get(blockId);
  const previousResolved = conflictOrigin?.resolved;
  if (conflictOrigin) conflictOrigin.resolved = true;
  delete row.dataset.draftConflict;
  row.dataset.draftSourceId = pageDraftSourceId;
  const serverVersion = getPositiveVersion(getBlockById(blockId)?.version);
  if (serverVersion !== null) row.dataset.draftExpectedVersion = String(serverVersion);
  row.classList.remove("save-error");
  if (!persistBlockDraft(row)) {
    if (conflictOrigin) conflictOrigin.resolved = previousResolved;
    restoreBlockRowFromDurableState(row);
    return false;
  }
  return true;
}

function hasUnresolvedDraftConflicts() {
  return (
    pageTitleDraftConflict ||
    [...blockDraftConflictOrigins.values()].some((origin) => origin.resolved !== true) ||
    Boolean(elements.blockList.querySelector('.editor-block-row[data-draft-conflict="true"]'))
  );
}

function reportUnresolvedDraftConflict() {
  setStatus(t("status.resolveRecoveredDraftConflict"), true);
}

function disableBeforeUnloadProtection() {
  window.removeEventListener("beforeunload", handleBeforeUnload);
  beforeUnloadProtectionActive = false;
}

function resetPageEditTracking() {
  window.clearTimeout(pageTitleSaveTimer);
  pageTitleSaveTimer = null;
  pageTitleEditRevision = 0;
  pageTitleSavedRevision = 0;
  pageTitleTaskId = 0;
  pageTitleDraftExpectedVersion = null;
  pageTitleDraftSourceId = pageDraftSourceId;
  pageTitleDraftConflict = false;
  pageTitleConflictOrigin = null;
  blockDraftConflictOrigins.clear();
  blockDraftRenderSources.clear();
  for (const timer of blockSaveTimers.values()) window.clearTimeout(timer);
  blockSaveTimers.clear();
  blockSaveRows.clear();
  blockSaveQueues.clear();
  blockSaveTaskIds.clear();
  pendingBlockOrderTask = null;
  blockOrderSaving = false;
  elements.pageTitle.classList.remove("local-draft-recovered", "save-error");
  disableBeforeUnloadProtection();
}

function discardPendingPageEdits() {
  window.clearTimeout(pageTitleSaveTimer);
  pageTitleSaveTimer = null;
  pageTitleSaveQueue.discard();
  for (const timer of blockSaveTimers.values()) window.clearTimeout(timer);
  blockSaveTimers.clear();
  blockSaveRows.clear();
  for (const queue of blockSaveQueues.values()) queue.discard();
  blockSaveQueues.clear();
  blockSaveTaskIds.clear();
  pendingBlockOrderTask = null;
  blockOrderSaving = false;
  pageTitleEditRevision = 0;
  pageTitleSavedRevision = 0;
  pageTitleTaskId = 0;
  pageTitleDraftExpectedVersion = null;
  pageTitleDraftSourceId = pageDraftSourceId;
  pageTitleDraftConflict = false;
  pageTitleConflictOrigin = null;
  blockDraftConflictOrigins.clear();
  blockDraftRenderSources.clear();
  disableBeforeUnloadProtection();
}

function discardBlockSave(blockId) {
  window.clearTimeout(blockSaveTimers.get(blockId));
  blockSaveTimers.delete(blockId);
  blockSaveRows.delete(blockId);
  blockSaveQueues.get(blockId)?.discard();
  blockSaveQueues.delete(blockId);
  blockSaveTaskIds.delete(blockId);
  syncBeforeUnloadProtection();
}

function lockPageEdits() {
  const generation = pageEditLockGeneration;
  state.pageEditLockDepth += 1;
  syncPageModeUi();
  return generation;
}

function unlockPageEdits(generation) {
  if (generation !== pageEditLockGeneration) return;
  state.pageEditLockDepth = Math.max(0, state.pageEditLockDepth - 1);
  syncPageModeUi();
}

async function withPageEditLock(action, { flush = true } = {}) {
  const lockGeneration = lockPageEdits();
  try {
    if (flush) await flushPendingPageEdits({ allowLocked: true });
    return await action();
  } finally {
    unlockPageEdits(lockGeneration);
  }
}

function waitForPageTransitionPropagation() {
  return new Promise((resolve) => window.setTimeout(resolve, 50));
}

async function withPagePersistenceTransition(pageId, kind, action) {
  const busyMessage = getPageTransitionBusyMessage(pageId);
  const page = state.selectedPage?.id === pageId
    ? state.selectedPage
    : state.allPages.find((candidate) => candidate.id === pageId) ?? null;
  const workspaceTransitionId = isWorkspaceTransitionId(pageId)
    ? null
    : getPageWorkspaceTransitionId(page);
  // Page-level and workspace-level destructive transitions for the same owner
  // share the owner Web Lock. Page transitions also retain the page lock so an
  // expired lease written by a pre-owner-scope build can be reaped safely.
  const exclusiveTransitionId = workspaceTransitionId ?? pageId;
  const exclusiveTransitionIds = [...new Set([pageId, exclusiveTransitionId])];
  const currentTransition = inspectPageTransitionForStart(pageId);
  const workspaceTransition = workspaceTransitionId && pageId !== workspaceTransitionId
    ? inspectPageTransitionForStart(workspaceTransitionId)
    : null;
  if (activePageTransitionLease || currentTransition || workspaceTransition) throw new Error(busyMessage);

  const result = await pageTransitionLock.runExclusive(exclusiveTransitionIds, async () => {
    const transitionIds = [
      pageId,
      ...(workspaceTransitionId && pageId !== workspaceTransitionId ? [workspaceTransitionId] : [])
    ];
    for (const transitionId of transitionIds) {
      const inspection = pageTransitionLock.inspect(transitionId);
      if (inspection.status === "invalid" || inspection.status === "error") {
        throw new Error(t("status.localRecoveryInspectionFailed"));
      }
      if (inspection.status === "active") throw new Error(busyMessage);
      if (inspection.status === "expired" && !pageTransitionLock.releaseExpired(transitionId)) {
        throw new Error(busyMessage);
      }
      const verified = pageTransitionLock.inspect(transitionId);
      if (verified.status !== "missing") {
        if (verified.status === "invalid" || verified.status === "error") {
          throw new Error(t("status.localRecoveryInspectionFailed"));
        }
        throw new Error(busyMessage);
      }
    }

    const lease = pageTransitionLock.acquire(pageId, kind, exclusiveTransitionId);
    if (!lease) throw new Error(busyMessage);
    let currentLease = lease;
    activePageTransitionLease = currentLease;
    const renewalTimer = window.setInterval(() => {
      const renewed = pageTransitionLock.renew(currentLease);
      if (!renewed) return;
      currentLease = renewed;
      if (activePageTransitionLease?.token === lease.token) activePageTransitionLease = renewed;
    }, Math.max(1_000, Math.floor(pageTransitionLock.ttlMs / 3)));
    syncPageModeUi();
    try {
      // Give other same-origin tabs a storage event turn. They lock their editor
      // and flush any durable draft before this tab validates the transition.
      await waitForPageTransitionPropagation();
      if (workspaceTransitionId && pageId !== workspaceTransitionId) {
        const propagatedWorkspaceTransition = inspectPageTransitionSafely(workspaceTransitionId);
        if (propagatedWorkspaceTransition) throw new Error(busyMessage);
      }
      if (!pageTransitionLock.owns(currentLease)) throw new Error(busyMessage);
      return await action();
    } finally {
      window.clearInterval(renewalTimer);
      pageTransitionLock.release(currentLease);
      if (activePageTransitionLease?.token === lease.token) activePageTransitionLease = null;
      syncPageModeUi();
    }
  });
  if (!result?.acquired) {
    throw new Error(
      result?.reason === "lock-manager-unavailable"
        ? t("status.exclusiveTransitionLockUnavailable")
        : busyMessage
    );
  }
  return result.value;
}

async function withWorkspacePersistenceTransition(kind, action) {
  const workspaceTransitionId = getWorkspaceTransitionId();
  if (!workspaceTransitionId) throw new Error(t("status.workspaceTransitionBusy"));
  return withPagePersistenceTransition(workspaceTransitionId, kind, async () => {
    // The owner lock proves that no current page transition for this workspace
    // is running. Remove only expired leases that explicitly name this owner
    // scope; legacy page leases stay fail-closed because their authority is
    // ambiguous without also acquiring each historical page lock.
    let transitionInspection = pageTransitionLock.inspectActive();
    assertBrowserRecoveryInspectionSafe(transitionInspection);
    for (const transition of transitionInspection.records) {
      if (
        transition.pageId !== workspaceTransitionId
        && transition.expiresAt <= Date.now()
        && transition.exclusiveId === workspaceTransitionId
      ) {
        pageTransitionLock.releaseExpired(transition.pageId);
      }
    }
    transitionInspection = pageTransitionLock.inspectActive();
    assertBrowserRecoveryInspectionSafe(transitionInspection);
    const competingTransitions = transitionInspection.records
      .filter((transition) => transition.pageId !== workspaceTransitionId);
    if (competingTransitions.length) throw new Error(t("status.workspaceTransitionBusy"));
    return action();
  });
}

function getJsonPayloadByteLength(payload) {
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function getPendingSavePayloadBytes({ saveTitle, rowsToSave }) {
  let totalBytes = 0;
  if (saveTitle) {
    totalBytes += getJsonPayloadByteLength({
      title: normalizePageTitle(elements.pageTitle.value),
      expectedVersion: getPositiveVersion(pageTitleDraftExpectedVersion) ?? state.selectedPage?.version
    });
  }

  for (const [blockId, row] of rowsToSave) {
    if (!row?.dataset.blockId || row.dataset.deleting === "true") continue;
    totalBytes += getJsonPayloadByteLength({
      ...buildBlockPayload(row),
      expectedVersion: getPositiveVersion(row.dataset.draftExpectedVersion) ?? getBlockById(blockId)?.version
    });
  }
  return totalBytes;
}

async function flushPendingPageEdits({ keepalive = false, allowLocked = false, collaborationCompact = true } = {}) {
  if (isCollaborativePage()) {
    const session = state.collaborationSession;
    assertCollaborationExitSafe(session, t("sharing.syncRequired"));
    const materialization = session?.isReady
      ? await session.flushMaterialization({ compact: collaborationCompact })
      : null;
    syncBeforeUnloadProtection();
    return materialization;
  }
  if (pendingBlockOrderTask && canPersistSelectedPage()) {
    await retryPendingBlockOrder({ keepalive });
  }
  if (!(allowLocked ? canPersistSelectedPage() : canEditSelectedPage())) return;

  const titleWasPending = pageTitleSaveTimer !== null;
  const shouldSaveTitle = titleWasPending || pageTitleSavedRevision < pageTitleEditRevision;
  window.clearTimeout(pageTitleSaveTimer);
  pageTitleSaveTimer = null;

  const rowsToSave = new Map(blockSaveRows);
  for (const row of elements.blockList.querySelectorAll(".editor-block-row.is-dirty")) {
    if (row.dataset.blockId) rowsToSave.set(row.dataset.blockId, row);
  }
  const pendingSavePayloadBytes = keepalive ? getPendingSavePayloadBytes({ saveTitle: shouldSaveTitle, rowsToSave }) : 0;
  const useKeepalive = keepalive && pendingSavePayloadBytes <= keepaliveSaveBudgetBytes;

  if (shouldSaveTitle) {
    await savePageTitleNow({ quiet: true, keepalive: useKeepalive, allowLocked });
  } else if (pageTitleSaveQueue.busy) {
    await pageTitleSaveQueue.flush();
  }

  await Promise.all(
    [...rowsToSave.entries()].map(([blockId, row]) => {
      window.clearTimeout(blockSaveTimers.get(blockId));
      blockSaveTimers.delete(blockId);
      blockSaveRows.delete(blockId);
      return saveBlockRow(row, { quiet: true, keepalive: useKeepalive, allowLocked });
    })
  );

  const visibleBlockIds = new Set(
    [...elements.blockList.querySelectorAll(".editor-block-row[data-block-id]")].map((row) => row.dataset.blockId)
  );
  await Promise.all(
    [...blockSaveQueues.entries()]
      .filter(([blockId]) => visibleBlockIds.has(blockId))
      .map(([, queue]) => queue.flush())
  );
  syncBeforeUnloadProtection();
  return null;
}

function applyMaterializedHtmlCaches(result) {
  if (!result?.blocks?.length || !state.selectedPage) return;
  const localBlocks = new Map(flattenBlocks(state.selectedPage.blocks ?? []).map((block) => [block.id, block]));
  for (const serverBlock of result.blocks) {
    const block = localBlocks.get(serverBlock?.id);
    if (!block || typeof serverBlock?.htmlCache !== "string") continue;
    block.htmlCache = serverBlock.htmlCache;
    const row = findRenderedBlockRow(block.id);
    if (row) updateRenderedBlockPreview(row, block);
  }
}

async function setPageMode(nextMode, { announce = true } = {}) {
  if (!state.selectedPage || state.workspaceView !== "page" || state.pageModeChanging) return;
  const normalizedMode = nextMode === pageModes.WRITE ? pageModes.WRITE : pageModes.READ;
  if (state.pageMode === normalizedMode) return;

  state.pageModeChanging = true;
  syncPageModeUi();
  try {
    if (normalizedMode === pageModes.READ) {
      const materialization = await flushPendingPageEdits({ allowLocked: true });
      applyMaterializedHtmlCaches(materialization);
    }
    state.pageMode = normalizedMode;
    state.pendingFocusBlockId = null;
    syncPageModeUi();

    const hasBlocks = flattenBlocks(state.selectedPage.blocks).length > 0;
    if (!hasBlocks) renderSelectedPage();

    if (normalizedMode === pageModes.WRITE && !hasBlocks) {
      // The mode transition intentionally holds pageModeChanging until the first editor block is ready.
      // Bypass only that self-owned interaction lock; createEmptyBlock still requires active write mode.
      const data = await createEmptyBlock(state.selectedPage.id, { allowLocked: true });
      if (!data) return;
      state.pendingFocusBlockId = data.block.id;
      await openPage(state.selectedPage.id);
    }

    if (announce) setStatus(t(normalizedMode === pageModes.READ ? "status.readModeEnabled" : "status.writeModeEnabled"));
  } finally {
    state.pageModeChanging = false;
    syncPageModeUi();
  }
}


function closePageActionsMenu({ restoreFocus = false } = {}) {
  elements.pageActionsMenu.classList.add("hidden");
  elements.pageActionsMenu.style.removeProperty("left");
  elements.pageActionsMenu.style.removeProperty("top");
  elements.pageActionsMenu.style.removeProperty("visibility");
  elements.pageActionsButton.setAttribute("aria-expanded", "false");
  if (restoreFocus && elements.pageActionsButton.isConnected) elements.pageActionsButton.focus();
}

function positionPageActionsMenu() {
  const triggerRect = elements.pageActionsButton.getBoundingClientRect();
  elements.pageActionsMenu.style.visibility = "hidden";
  elements.pageActionsMenu.classList.remove("hidden");

  const menuRect = elements.pageActionsMenu.getBoundingClientRect();
  const viewportPadding = 10;
  const gap = 6;
  const maxLeft = Math.max(viewportPadding, window.innerWidth - menuRect.width - viewportPadding);
  const left = Math.min(Math.max(triggerRect.right - menuRect.width, viewportPadding), maxLeft);
  let top = triggerRect.bottom + gap;

  if (top + menuRect.height > window.innerHeight - viewportPadding) {
    top = triggerRect.top - menuRect.height - gap;
  }

  elements.pageActionsMenu.style.left = `${left}px`;
  elements.pageActionsMenu.style.top = `${Math.max(viewportPadding, top)}px`;
  elements.pageActionsMenu.style.visibility = "visible";
}

function openPageActionsMenu({ focusFirst = false } = {}) {
  if (!state.selectedPage) return;
  if (!elements.pageActionsMenu.classList.contains("hidden")) {
    closePageActionsMenu({ restoreFocus: true });
    return;
  }

  closeSlashMenu();
  closeInlineToolbar();
  closeBlockContextMenu();
  closeNavigationContextMenu();
  closePageActionsMenu();
  elements.pageActionsButton.setAttribute("aria-expanded", "true");
  elements.pageActionsMenu.setAttribute(
    "aria-label",
    t("page.actionsAria", { title: state.selectedPage.title || t("newDocumentTitle") })
  );
  positionPageActionsMenu();
  if (focusFirst) getPageActionsMenuItems()[0]?.focus();
}

const pageVersionFieldTranslationKeys = Object.freeze({
  title: "versions.fieldTitle",
  icon: "versions.fieldIcon",
  coverUrl: "versions.fieldCoverUrl",
  coverPositionX: "versions.fieldCoverPositionX",
  coverPositionY: "versions.fieldCoverPositionY",
  isArchived: "versions.fieldIsArchived",
  isCollection: "versions.fieldIsCollection",
  parentPageId: "versions.fieldParentPageId",
  tags: "versions.fieldTags",
  parentBlockId: "versions.fieldParentBlockId",
  type: "versions.fieldType",
  markdown: "versions.fieldMarkdown",
  checked: "versions.fieldChecked",
  sortOrder: "versions.fieldSortOrder",
  metadata: "versions.fieldMetadata"
});

function getPageVersionFieldLabel(field) {
  return t(pageVersionFieldTranslationKeys[field] ?? field);
}

function getPageVersionActorName(actor) {
  if (!actor) return t("versions.unknownActor");
  const name = String(actor.name ?? "").trim();
  if (name) return name;
  const username = String(actor.username ?? "").trim();
  return username ? `@${username}` : t("versions.unknownActor");
}

function getPageVersionActorLabel(actors = []) {
  if (!actors.length) return t("versions.unknownActor");
  const first = getPageVersionActorName(actors[0]);
  if (actors.length === 1) return first;
  return t("versions.actorsMore", { first, count: actors.length - 1 });
}

function getPageVersionInitials(actors = []) {
  const label = getPageVersionActorName(actors[0]);
  const normalized = label.replace(/^@/, "").trim();
  if (!normalized) return "?";
  return normalized.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function summarizePageVersion(version) {
  const summary = version?.summary ?? {};
  const parts = [];
  if (Number(summary.baseline ?? 0) > 0) parts.push(t("versions.historyStarted"));
  if (Number(summary.pageCreated ?? 0) > 0) parts.push(t("versions.summaryPageCreated"));
  const pageFields = Array.isArray(summary.pageFields) ? summary.pageFields : [];
  if (pageFields.length) {
    parts.push(t("versions.summaryPageFields", {
      fields: pageFields.map(getPageVersionFieldLabel).join(", ")
    }));
  }

  const created = Number(summary.blocksCreated ?? 0);
  const updated = Number(summary.blocksUpdated ?? 0);
  const deleted = Number(summary.blocksDeleted ?? 0);
  const moved = Math.min(updated, Number(summary.blocksMoved ?? 0));
  const contentUpdated = Math.max(0, updated - moved);
  if (created) parts.push(t("versions.summaryBlocksCreated", { count: formatNumber(created) }));
  if (contentUpdated) parts.push(t("versions.summaryBlocksUpdated", { count: formatNumber(contentUpdated) }));
  if (moved) parts.push(t("versions.summaryBlocksMoved", { count: formatNumber(moved) }));
  if (deleted) parts.push(t("versions.summaryBlocksDeleted", { count: formatNumber(deleted) }));
  return parts.join(" · ") || t("versions.noChanges");
}

function formatPageVersionValue(field, value) {
  if (value === null || value === undefined || value === "") return t("versions.emptyValue");
  if (typeof value === "boolean") return t(value ? "versions.yes" : "versions.no");
  if (field === "type") return t(blockTypeLabels[value] ?? String(value));
  if (Array.isArray(value)) return value.length ? value.join(", ") : t("versions.emptyValue");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function createPageVersionValuePane(label, value, field) {
  const pane = document.createElement("div");
  pane.className = "page-version-value-pane";
  const heading = document.createElement("span");
  heading.textContent = label;
  const content = document.createElement("pre");
  content.textContent = formatPageVersionValue(field, value);
  pane.append(heading, content);
  return pane;
}

function createPageVersionFieldChange(fieldChange) {
  const row = document.createElement("div");
  row.className = "page-version-field-change";
  const label = document.createElement("div");
  label.className = "page-version-field-name";
  label.textContent = getPageVersionFieldLabel(fieldChange.field);
  const values = document.createElement("div");
  values.className = "page-version-before-after";
  values.append(
    createPageVersionValuePane(t("versions.before"), fieldChange.before, fieldChange.field),
    createPageVersionValuePane(t("versions.after"), fieldChange.after, fieldChange.field)
  );
  row.append(label, values);
  return row;
}

function createPageVersionChangeCard(change) {
  const card = document.createElement("article");
  card.className = "page-version-change-card";
  const header = document.createElement("div");
  header.className = "page-version-change-card-header";
  const title = document.createElement("strong");
  const meta = document.createElement("span");
  const fields = document.createElement("div");
  fields.className = "page-version-field-list";

  if (change.kind === "history-started") {
    title.textContent = t("versions.historyStarted");
    meta.textContent = t("versions.baselineDescription");
    for (const [field, after] of Object.entries(change.page ?? {})) {
      fields.append(createPageVersionFieldChange({ field, before: null, after }));
    }
  } else if (change.kind === "page-created") {
    title.textContent = t("versions.pageCreated");
    meta.textContent = t("versions.pageUpdated");
    for (const [field, after] of Object.entries(change.page ?? {})) {
      fields.append(createPageVersionFieldChange({ field, before: null, after }));
    }
  } else if (change.kind === "page-updated") {
    title.textContent = t("versions.pageUpdated");
    meta.textContent = t("versions.changesCount", { count: change.fields?.length ?? 0 });
    for (const fieldChange of change.fields ?? []) fields.append(createPageVersionFieldChange(fieldChange));
  } else if (change.kind === "block-created" || change.kind === "block-deleted") {
    const created = change.kind === "block-created";
    title.textContent = t(created ? "versions.blockCreated" : "versions.blockDeleted");
    meta.textContent = t("versions.blockLabel", {
      type: t(blockTypeLabels[change.block?.type] ?? String(change.block?.type ?? ""))
    });
    for (const field of ["type", "markdown", "checked", "parentBlockId", "sortOrder", "metadata"]) {
      const value = change.block?.[field];
      fields.append(createPageVersionFieldChange({
        field,
        before: created ? null : value,
        after: created ? value : null
      }));
    }
  } else if (change.kind === "block-updated") {
    title.textContent = t("versions.blockUpdated");
    meta.textContent = t("versions.blockLabel", {
      type: t(blockTypeLabels[change.blockType] ?? String(change.blockType ?? ""))
    });
    for (const fieldChange of change.fields ?? []) fields.append(createPageVersionFieldChange(fieldChange));
  }

  header.append(title, meta);
  card.append(header, fields);
  return card;
}

function getPageVersionResetTaskKey(scope, pageId) {
  return `${scope.generation}\u0000${scope.targetKey}\u0000${pageId}`;
}

function getCurrentPageVersionResetTask(pageId) {
  if (!pageId) return null;
  const scope = captureAuthenticatedSessionScope();
  if (!scope.targetKey) return null;
  return pendingPageVersionResetTasks.get(getPageVersionResetTaskKey(scope, pageId)) ?? null;
}

function getOrCreatePageVersionResetTask(pageId) {
  const scope = captureAuthenticatedSessionScope();
  if (!scope.targetKey) return null;
  const taskKey = getPageVersionResetTaskKey(scope, pageId);
  let task = pendingPageVersionResetTasks.get(taskKey);
  if (!task) {
    task = {
      taskKey,
      pageId,
      scope,
      mutationId: createMutationId(),
      inFlight: false
    };
    pendingPageVersionResetTasks.set(taskKey, task);
  }
  return task;
}

async function submitPageVersionResetTask(task) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await api(`/api/pages/${encodeURIComponent(task.pageId)}/versions`, {
        method: "DELETE",
        body: { mutationId: task.mutationId }
      });
    } catch (error) {
      if (attempt === 0 && isAmbiguousApiError(error)) continue;
      throw error;
    }
  }
  throw new Error(t("versions.resetError"));
}

function renderPageVersionHistoryList() {
  const history = state.pageVersionHistory;
  elements.pageVersionHistoryList.replaceChildren();
  for (const version of history.versions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "page-version-history-item";
    button.dataset.versionId = String(version.id);
    button.disabled = history.resetting;
    button.classList.toggle("is-selected", String(history.selectedId) === String(version.id));

    const avatar = document.createElement("span");
    avatar.className = "page-version-history-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = getPageVersionInitials(version.actors);

    const copy = document.createElement("span");
    copy.className = "page-version-history-item-copy";
    const title = document.createElement("strong");
    title.textContent = summarizePageVersion(version);
    const byline = document.createElement("span");
    byline.textContent = t("versions.actorDate", {
      actors: getPageVersionActorLabel(version.actors),
      date: formatDate(version.createdAt)
    });
    const count = document.createElement("small");
    count.textContent = `${t("versions.pageVersion", { version: version.pageVersion })} · ${t("versions.contentVersion", { version: version.contentVersion })}`;
    copy.append(title, byline, count);

    const revision = document.createElement("span");
    revision.className = "page-version-history-revision";
    revision.textContent = `v${version.revision}`;
    button.append(avatar, copy, revision);
    elements.pageVersionHistoryList.append(button);
  }

  elements.pageVersionHistoryMore.classList.toggle("hidden", !history.nextCursor);
  elements.pageVersionHistoryMore.disabled = history.loading || history.resetting;
  elements.pageVersionHistoryReset.disabled = history.loading || history.resetting;
}

function renderPageVersionHistoryDetail(version) {
  elements.pageVersionHistoryDetailEmpty.classList.add("hidden");
  elements.pageVersionHistoryDetail.classList.remove("hidden");
  elements.pageVersionHistoryDetail.replaceChildren();

  const header = document.createElement("header");
  header.className = "page-version-detail-header";
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = summarizePageVersion(version);
  const byline = document.createElement("p");
  byline.textContent = t("versions.actorDate", {
    actors: getPageVersionActorLabel(version.actors),
    date: formatDate(version.createdAt)
  });
  copy.append(title, byline);

  const versionStack = document.createElement("div");
  versionStack.className = "page-version-detail-version-stack";
  for (const text of [
    t("versions.revision", { revision: version.revision }),
    t("versions.pageVersion", { version: version.pageVersion }),
    t("versions.contentVersion", { version: version.contentVersion })
  ]) {
    const badge = document.createElement("span");
    badge.textContent = text;
    versionStack.append(badge);
  }
  header.append(copy, versionStack);

  const changeList = document.createElement("div");
  changeList.className = "page-version-change-list";
  const changes = Array.isArray(version.changes) ? version.changes : [];
  if (changes.length) {
    for (const change of changes) changeList.append(createPageVersionChangeCard(change));
  } else {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = t("versions.noChanges");
    changeList.append(empty);
  }
  elements.pageVersionHistoryDetail.append(header, changeList);
}

function resetPageVersionHistoryDetail() {
  state.pageVersionHistory.selectedId = null;
  elements.pageVersionHistoryDetail.classList.add("hidden");
  elements.pageVersionHistoryDetail.replaceChildren();
  elements.pageVersionHistoryDetailEmpty.classList.remove("hidden");
}

async function loadPageVersionHistory({ append = false } = {}) {
  const pageId = state.pageVersionHistory.pageId;
  if (!pageId) return false;
  const requestId = ++state.pageVersionHistory.requestId;
  state.pageVersionHistory.loading = true;
  elements.pageVersionHistoryMessage.classList.remove("error");
  elements.pageVersionHistoryMessage.textContent = t("versions.loading");
  elements.pageVersionHistoryMore.disabled = true;
  elements.pageVersionHistoryReset.disabled = true;

  try {
    const cursor = append ? state.pageVersionHistory.nextCursor : null;
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : "?limit=50";
    const data = await api(`/api/pages/${encodeURIComponent(pageId)}/versions${query}`);
    if (requestId !== state.pageVersionHistory.requestId || pageId !== state.pageVersionHistory.pageId) return false;
    state.pageVersionHistory.current = data.current ?? null;
    state.pageVersionHistory.versions = append
      ? [...state.pageVersionHistory.versions, ...(data.versions ?? [])]
      : (data.versions ?? []);
    state.pageVersionHistory.nextCursor = data.nextCursor ?? null;
    elements.pageVersionHistoryCurrent.textContent = t("versions.current", {
      revision: data.current?.revision ?? 0
    });
    elements.pageVersionHistoryMessage.textContent = state.pageVersionHistory.versions.length
      ? ""
      : t("versions.empty");
    renderPageVersionHistoryList();
    return true;
  } catch (error) {
    if (requestId !== state.pageVersionHistory.requestId) return false;
    elements.pageVersionHistoryMessage.classList.add("error");
    elements.pageVersionHistoryMessage.textContent = error?.message || t("versions.loadError");
    return false;
  } finally {
    if (requestId === state.pageVersionHistory.requestId) {
      state.pageVersionHistory.loading = false;
      elements.pageVersionHistoryMore.disabled = state.pageVersionHistory.resetting;
      elements.pageVersionHistoryReset.disabled = state.pageVersionHistory.resetting;
    }
  }
}

async function resetPageVersionHistory() {
  const history = state.pageVersionHistory;
  const page = state.selectedPage;
  const pageId = history.pageId;
  if (!pageId || !page || page.id !== pageId || !isPageOwner(page) || history.loading || history.resetting) return;

  const title = page.title || t("newDocumentTitle");
  if (!window.confirm(t("versions.resetConfirm", { title }))) return;

  const task = getOrCreatePageVersionResetTask(pageId);
  if (!task || task.inFlight) return;
  task.inFlight = true;
  history.resetting = true;
  history.requestId += 1;
  history.detailRequestId += 1;
  elements.pageVersionHistoryReset.disabled = true;
  elements.pageVersionHistoryReset.setAttribute("aria-busy", "true");
  elements.pageVersionHistoryMore.disabled = true;
  elements.pageVersionHistoryMessage.classList.remove("error");
  elements.pageVersionHistoryMessage.textContent = t("versions.resetting");
  renderPageVersionHistoryList();

  let synchronized = false;
  try {
    await submitPageVersionResetTask(task);
    if (!isCurrentAuthenticatedSessionScope(task.scope) || pageId !== history.pageId) return;

    history.versions = [];
    history.nextCursor = null;
    history.current = null;
    elements.pageVersionHistoryCurrent.textContent = "";
    resetPageVersionHistoryDetail();
    renderPageVersionHistoryList();
    const loaded = await loadPageVersionHistory();
    if (loaded && isCurrentAuthenticatedSessionScope(task.scope) && pageId === history.pageId) {
      synchronized = true;
      elements.pageVersionHistoryMessage.classList.remove("error");
      elements.pageVersionHistoryMessage.textContent = t("versions.resetSuccess");
    }
  } catch (error) {
    if (isDefinitiveApiError(error) && pendingPageVersionResetTasks.get(task.taskKey) === task) {
      pendingPageVersionResetTasks.delete(task.taskKey);
    }
    if (!isCurrentAuthenticatedSessionScope(task.scope) || pageId !== history.pageId) return;
    elements.pageVersionHistoryMessage.classList.add("error");
    elements.pageVersionHistoryMessage.textContent = error?.message || t("versions.resetError");
  } finally {
    task.inFlight = false;
    if (synchronized && pendingPageVersionResetTasks.get(task.taskKey) === task) {
      pendingPageVersionResetTasks.delete(task.taskKey);
    }
    if (isCurrentAuthenticatedSessionScope(task.scope) && pageId === history.pageId) {
      const currentTask = getCurrentPageVersionResetTask(pageId);
      history.resetting = Boolean(currentTask?.inFlight);
      elements.pageVersionHistoryReset.disabled = history.loading || history.resetting;
      if (history.resetting) elements.pageVersionHistoryReset.setAttribute("aria-busy", "true");
      else elements.pageVersionHistoryReset.removeAttribute("aria-busy");
      elements.pageVersionHistoryMore.disabled = history.loading || history.resetting;
      renderPageVersionHistoryList();
    }
  }
}

async function loadPageVersionDetail(versionId) {
  const pageId = state.pageVersionHistory.pageId;
  if (!pageId || !versionId) return;
  const requestId = ++state.pageVersionHistory.detailRequestId;
  state.pageVersionHistory.selectedId = String(versionId);
  renderPageVersionHistoryList();
  elements.pageVersionHistoryDetailEmpty.classList.add("hidden");
  elements.pageVersionHistoryDetail.classList.remove("hidden");
  elements.pageVersionHistoryDetail.textContent = t("versions.detailsLoading");

  try {
    const data = await api(`/api/pages/${encodeURIComponent(pageId)}/versions/${encodeURIComponent(versionId)}`);
    if (requestId !== state.pageVersionHistory.detailRequestId || pageId !== state.pageVersionHistory.pageId) return;
    renderPageVersionHistoryDetail(data.version);
  } catch (error) {
    if (requestId !== state.pageVersionHistory.detailRequestId) return;
    elements.pageVersionHistoryDetail.textContent = error?.message || t("versions.loadError");
  }
}

function openPageVersionHistory() {
  const page = state.selectedPage;
  if (!page || !isPageOwner(page)) return;
  closePageActionsMenu();
  state.pageVersionHistory.pageId = page.id;
  state.pageVersionHistory.versions = [];
  state.pageVersionHistory.nextCursor = null;
  state.pageVersionHistory.current = null;
  state.pageVersionHistory.resetting = Boolean(getCurrentPageVersionResetTask(page.id)?.inFlight);
  state.pageVersionHistory.requestId += 1;
  state.pageVersionHistory.detailRequestId += 1;
  elements.pageVersionHistoryPageTitle.textContent = page.title || t("newDocumentTitle");
  elements.pageVersionHistoryReset.classList.toggle("hidden", !isPageOwner(page));
  elements.pageVersionHistoryReset.disabled = state.pageVersionHistory.resetting;
  if (state.pageVersionHistory.resetting) {
    elements.pageVersionHistoryReset.setAttribute("aria-busy", "true");
  } else {
    elements.pageVersionHistoryReset.removeAttribute("aria-busy");
  }
  elements.pageVersionHistoryCurrent.textContent = "";
  elements.pageVersionHistoryMessage.textContent = "";
  elements.pageVersionHistoryList.replaceChildren();
  resetPageVersionHistoryDetail();
  if (!elements.pageVersionHistoryDialog.open) elements.pageVersionHistoryDialog.showModal();
  requestAnimationFrame(() => elements.pageVersionHistoryClose.focus());
  void loadPageVersionHistory();
}

function closePageVersionHistory({ restoreFocus = true } = {}) {
  state.pageVersionHistory.requestId += 1;
  state.pageVersionHistory.detailRequestId += 1;
  state.pageVersionHistory.resetting = false;
  state.pageVersionHistory.loading = false;
  state.pageVersionHistory.pageId = null;
  state.pageVersionHistory.versions = [];
  state.pageVersionHistory.nextCursor = null;
  state.pageVersionHistory.current = null;
  state.pageVersionHistory.selectedId = null;
  resetPageVersionHistoryDetail();
  elements.pageVersionHistoryList.replaceChildren();
  if (elements.pageVersionHistoryDialog.open) elements.pageVersionHistoryDialog.close();
  if (restoreFocus && elements.pageActionsButton.isConnected) elements.pageActionsButton.focus();
}

function getNavigationContextMenuItems() {
  return [...elements.navigationContextMenu.querySelectorAll('[role="menuitem"]')].filter(
    (item) => !item.disabled && !item.classList.contains("hidden")
  );
}

function closeNavigationContextMenu({ restoreFocus = false } = {}) {
  const trigger = state.activeNavigationMenuTrigger;
  trigger?.closest(".document-item-row, .collection-title-row, .home-document-row")?.classList.remove("is-menu-open");
  elements.navigationContextMenu.classList.add("hidden");
  elements.navigationContextMenu.style.removeProperty("left");
  elements.navigationContextMenu.style.removeProperty("top");
  elements.navigationContextMenu.style.removeProperty("visibility");
  trigger?.setAttribute("aria-expanded", "false");
  state.activeNavigationMenuTarget = null;
  state.activeNavigationMenuTrigger = null;

  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function positionNavigationContextMenu(trigger) {
  const triggerRect = trigger.getBoundingClientRect();
  elements.navigationContextMenu.style.visibility = "hidden";
  elements.navigationContextMenu.classList.remove("hidden");

  const menuRect = elements.navigationContextMenu.getBoundingClientRect();
  const viewportPadding = 10;
  const gap = 6;
  const maxLeft = Math.max(viewportPadding, window.innerWidth - menuRect.width - viewportPadding);
  const left = Math.min(Math.max(triggerRect.right - menuRect.width, viewportPadding), maxLeft);
  let top = triggerRect.bottom + gap;

  if (top + menuRect.height > window.innerHeight - viewportPadding) {
    top = triggerRect.top - menuRect.height - gap;
  }

  elements.navigationContextMenu.style.left = `${left}px`;
  elements.navigationContextMenu.style.top = `${Math.max(viewportPadding, top)}px`;
  elements.navigationContextMenu.style.visibility = "visible";
}

function openNavigationContextMenu(trigger, { focusFirst = false } = {}) {
  const id = trigger?.dataset.navigationMenuId;
  const kind = trigger?.dataset.navigationMenuKind;
  const title = trigger?.dataset.navigationMenuTitle;
  if (!id || !title || !["page", "collection"].includes(kind)) return;

  const isSameOpenMenu =
    state.activeNavigationMenuTarget?.id === id &&
    !elements.navigationContextMenu.classList.contains("hidden");
  if (isSameOpenMenu) {
    closeNavigationContextMenu({ restoreFocus: true });
    return;
  }

  closeSlashMenu();
  closeInlineToolbar();
  closeBlockContextMenu();
  closeNavigationContextMenu();

  state.activeNavigationMenuTarget = { id, kind, title };
  state.activeNavigationMenuTrigger = trigger;
  trigger.closest(".document-item-row, .collection-title-row, .home-document-row")?.classList.add("is-menu-open");
  trigger.setAttribute("aria-expanded", "true");
  elements.navigationContextMenu.setAttribute(
    "aria-label",
    t(kind === "collection" ? "navigationMenu.collectionAria" : "navigationMenu.pageAria", { title })
  );
  elements.navigationAddSubpageButton.classList.toggle("hidden", kind !== "page");
  elements.navigationAddSubpageButton.disabled = state.workspaceCreateBusy;
  elements.navigationDeleteLabel.textContent = t(
    kind === "collection" ? "navigationMenu.deleteCollection" : "navigationMenu.deletePage"
  );
  positionNavigationContextMenu(trigger);

  if (focusFirst) getNavigationContextMenuItems()[0]?.focus();
}

async function createNavigationSubpage() {
  const target = state.activeNavigationMenuTarget;
  if (!target || target.kind !== "page") return { applied: false };

  const parentPageId = target.id;
  closeNavigationContextMenu();
  setNavigationSubpagesExpanded(parentPageId, true);
  return createWorkspacePage(
    { title: t("newDocumentTitle"), icon: "📄", parentPageId },
    { creatingKey: "status.creatingSubpage", createdKey: "status.subpageCreated" }
  );
}

async function deleteNavigationTarget() {
  const target = state.activeNavigationMenuTarget;
  if (!target) return;
  await assertWorkspacePersistenceUnlocked();

  const subtreeIds = getPageSubtreeIds(target.id);
  if (isPageReadOnly() && state.selectedPage?.id && subtreeIds.has(state.selectedPage.id)) {
    closeNavigationContextMenu({ restoreFocus: true });
    reportReadOnlyBlocked();
    return;
  }
  if (state.selectedPage?.id && subtreeIds.has(state.selectedPage.id) && hasUnresolvedDraftConflicts()) {
    closeNavigationContextMenu({ restoreFocus: true });
    reportUnresolvedDraftConflict();
    return;
  }

  return withPageEditLock(async () => {
    const isCollection = target.kind === "collection";
    const selectedPageWasDeleted = Boolean(state.selectedPage?.id && subtreeIds.has(state.selectedPage.id));
    const activeCollectionWasDeleted = state.activeCollectionId === target.id;
    const fallbackCollectionId = isCollection
      ? defaultCollectionKey
      : getCollectionRootId(target.id) ?? defaultCollectionKey;

    const deletionSnapshot = await api(`/api/pages/${target.id}/deletion-snapshot`);
    const localPageIds = [...subtreeIds].sort();
    const serverPageIds = Array.isArray(deletionSnapshot.pageIds) ? [...deletionSnapshot.pageIds].sort() : [];
    const serverPages = new Map(
      (Array.isArray(deletionSnapshot.pages) ? deletionSnapshot.pages : []).map((page) => [page.id, page])
    );
    const localPages = new Map(
      [...state.allPages, ...(state.selectedPage ? [state.selectedPage] : [])].map((page) => [page.id, page])
    );
    if (
      localPageIds.length !== serverPageIds.length ||
      localPageIds.some((pageId, index) => pageId !== serverPageIds[index]) ||
      localPageIds.some((pageId) => {
        const localPage = localPages.get(pageId);
        const serverPage = serverPages.get(pageId);
        return (
          !localPage ||
          !serverPage ||
          Number(localPage.version ?? 1) !== Number(serverPage.version ?? 1) ||
          Number(localPage.contentVersion ?? 1) !== Number(serverPage.contentVersion ?? 1)
        );
      })
    ) {
      closeNavigationContextMenu();
      await loadPages(elements.searchInput.value.trim(), state.activeTag);
      throw new Error(t("errors.PAGE_DELETE_SCOPE_CHANGED"));
    }

    const ok = window.confirm(
      t(isCollection ? "confirm.deleteCollection" : "confirm.deletePage", { title: target.title })
    );
    if (!ok) return;

    closeNavigationContextMenu();
    setStatus(t(isCollection ? "status.deletingCollection" : "status.deletingPage"));

    await withWorkspacePersistenceTransition("page-delete", async () => {
      // Another tab may hold direct-mode drafts or a newer Yjs document that
      // has not reached the server and is absent from the deletion snapshot.
      assertNoPendingLocalPageDraftsForPages(serverPageIds, "status.destructiveLocalDraftsPending");
      assertNoPendingLocalCollaborationRecoveryForPages(serverPageIds);
      await api(`/api/pages/${target.id}?permanent=true`, {
        method: "DELETE",
        body: { expectedSnapshot: deletionSnapshot.snapshot }
      });
    });
    if (state.user?.id) {
      checkDraftStoreWrite(pageDraftStore.removePages(state.user.id, serverPageIds, pageDraftSourceId));
    }

    if (selectedPageWasDeleted) {
      resetPageEditTracking();
      state.selectedPage = null;
    }
    await loadPages(elements.searchInput.value.trim(), state.activeTag);

    if (selectedPageWasDeleted || activeCollectionWasDeleted) {
      await showCollection(fallbackCollectionId, { skipFlush: true });
    }

    setStatus(t(isCollection ? "status.collectionDeleted" : "status.pageDeleted"));
  });
}

function renderCollectionView() {
  if (state.workspaceView !== "collection") return;

  const collectionId = state.activeCollectionId;
  const collection = collectionId === defaultCollectionKey
    ? null
    : state.allPages.find((page) => page.id === collectionId && isCollectionPage(page));
  const pages = getCollectionPages(collectionId);

  renderIconValue(
    elements.collectionIconButton,
    collection?.icon ?? getDefaultCollectionEmoji(),
    "📁"
  );
  elements.collectionViewTitle.textContent = collection ? collection.title : getDefaultCollectionName();
  elements.collectionViewList.replaceChildren();

  const groups = buildPageTree(pages);
  const roots = groups.get(rootParentKey) ?? [];
  if (!roots.length) {
    elements.collectionViewList.append(makeEmptyMessage(t("empty.noDocumentsSidebar")));
    return;
  }

  for (const page of roots) {
    elements.collectionViewList.append(renderDocumentNode(page, groups));
  }
}

function inspectLocalPageDraftRecords(pageId) {
  if (!state.user?.id || !pageId) {
    return { records: [], reliable: false, unreadableKeys: [] };
  }
  return pageDraftStore.inspectPageDrafts(state.user.id, pageId);
}

function getLocalPageDraftRecords(pageId) {
  return inspectLocalPageDraftRecords(pageId).records;
}

function assertNoPendingLocalPageDrafts(pageId, messageKey = "sharing.localDraftsPending") {
  const inspection = inspectLocalPageDraftRecords(pageId);
  assertBrowserRecoveryInspectionSafe(inspection);
  if (!inspection.records.length) return;
  throw new Error(t(messageKey, { count: formatNumber(inspection.records.length) }));
}

function inspectLocalPageDraftRecordsForPages(pageIds) {
  if (!state.user?.id) return { records: [], reliable: false, unreadableKeys: [] };
  const targetPageIds = new Set(pageIds ?? []);
  if (!targetPageIds.size) return { records: [], reliable: true, unreadableKeys: [] };
  const inspection = pageDraftStore.inspectUserDrafts(state.user.id);
  return {
    ...inspection,
    records: inspection.records.filter((record) => targetPageIds.has(record.pageId))
  };
}

function getLocalPageDraftRecordsForPages(pageIds) {
  return inspectLocalPageDraftRecordsForPages(pageIds).records;
}

function assertNoPendingLocalPageDraftsForPages(
  pageIds,
  messageKey = "status.workspaceLocalDraftsPending"
) {
  const inspection = inspectLocalPageDraftRecordsForPages(pageIds);
  assertBrowserRecoveryInspectionSafe(inspection);
  if (!inspection.records.length) return;
  throw new Error(t(messageKey, { count: formatNumber(inspection.records.length) }));
}

function getLocalBlockDraftRecordsFromRecords(records, blockIds, { excludeSourceId = null } = {}) {
  const targetBlockIds = new Set(blockIds ?? []);
  if (!targetBlockIds.size) return [];
  return records.filter((record) => {
    if (excludeSourceId && record.sourceId === excludeSourceId) return false;
    if (Object.keys(record.blocks ?? {}).some((blockId) => targetBlockIds.has(blockId))) return true;
    return (record.blockOrder?.orderedIds ?? []).some((blockId) => targetBlockIds.has(blockId));
  });
}

function getLocalBlockDraftRecords(pageId, blockIds, options = {}) {
  return getLocalBlockDraftRecordsFromRecords(getLocalPageDraftRecords(pageId), blockIds, options);
}

function assertNoPendingLocalBlockDrafts(pageId, blockIds, options = {}) {
  const inspection = inspectLocalPageDraftRecords(pageId);
  assertBrowserRecoveryInspectionSafe(inspection);
  const records = getLocalBlockDraftRecordsFromRecords(inspection.records, blockIds, options);
  if (!records.length) return;
  throw new Error(t("status.destructiveLocalDraftsPending", { count: formatNumber(records.length) }));
}

function inspectLocalCollaborationRecoveryRecordsForPages(pageIds) {
  const records = [];
  const unreadableKeys = [];
  let reliable = true;
  for (const pageId of [...new Set(pageIds ?? [])]) {
    if (!pageId) continue;
    // A collaborator can be logged into a different same-origin tab/account, so
    // inspect every locally represented account for every destructive target.
    const inspection = collaborationRecoveryStore.inspectPageRecords(pageId);
    records.push(...inspection.records);
    unreadableKeys.push(...inspection.unreadableKeys);
    reliable = inspection.reliable && reliable;
  }
  return { records, reliable, unreadableKeys: [...new Set(unreadableKeys)] };
}

function getLocalCollaborationRecoveryRecordsForPages(pageIds) {
  return inspectLocalCollaborationRecoveryRecordsForPages(pageIds).records;
}

function assertNoPendingLocalCollaborationRecovery(pageId) {
  const inspection = inspectLocalCollaborationRecoveryRecordsForPages([pageId]);
  assertBrowserRecoveryInspectionSafe(inspection);
  if (!inspection.records.length) return;
  throw new Error(
    t("sharing.localCollaborationRecoveryPending", { count: formatNumber(inspection.records.length) })
  );
}

function assertNoPendingLocalCollaborationRecoveryForPages(pageIds) {
  const inspection = inspectLocalCollaborationRecoveryRecordsForPages(pageIds);
  assertBrowserRecoveryInspectionSafe(inspection);
  if (!inspection.records.length) return;
  throw new Error(
    t("status.destructiveCollaborationRecoveryPending", { count: formatNumber(inspection.records.length) })
  );
}

function serializePageDraftRecord(record, reason) {
  return {
    reason,
    pageId: record.pageId,
    sourceId: record.sourceId,
    updatedAt: new Date(record.updatedAt).toISOString(),
    title: record.title,
    blocks: record.blocks,
    blockOrder: record.blockOrder
  };
}

function getCollaborativePageDrafts(pageId) {
  return getLocalPageDraftRecords(pageId).map((record) =>
    serializePageDraftRecord(record, "collaboration-enabled")
  );
}

function getOrphanedPageDrafts() {
  if (!state.user?.id) return [];
  const pageById = new Map(state.allPages.map((page) => [page.id, page]));
  return pageDraftStore
    .loadUserDrafts(state.user.id)
    .flatMap((record) => {
      const page = pageById.get(record.pageId);
      if (page && !isCollaborativePage(page)) return [];
      return [serializePageDraftRecord(record, page ? "collaboration-enabled" : "unavailable")];
    });
}

function appendPageDraftRecoveryPanel(container, drafts, { home = false, collaborative = false } = {}) {
  if (!drafts.length) return;
  const panel = document.createElement("section");
  panel.className = [
    "local-draft-recovery-panel",
    home ? "home-local-draft-recovery-panel" : "",
    collaborative ? "collaboration-local-draft-recovery-panel" : ""
  ].filter(Boolean).join(" ");
  panel.setAttribute("role", "alert");

  const heading = document.createElement("strong");
  heading.textContent = t("status.orphanedLocalDrafts");

  const details = document.createElement("pre");
  details.tabIndex = 0;
  details.textContent = JSON.stringify(drafts, null, 2);
  panel.append(heading, details);
  container.append(panel);
}

function appendOrphanedPageDraftRecovery() {
  appendPageDraftRecoveryPanel(elements.homeDocumentList, getOrphanedPageDrafts(), { home: true });
}

function getOrphanedCollaborationRecoveryGroups() {
  if (!state.user?.id) return [];
  const pageById = new Map(state.allPages.map((page) => [page.id, page]));
  const groups = new Map();
  for (const record of collaborationRecoveryStore.loadAccountRecords(state.user.id)) {
    const page = pageById.get(record.pageId);
    const documentEpoch = record.documentEpoch ?? null;
    const epochGroupKey = documentEpoch === null ? "legacy:" : `epoch:${documentEpoch}`;
    const groupKey = `${record.pageId}\u0000${epochGroupKey}`;
    const group = groups.get(groupKey) ?? {
      pageId: record.pageId,
      documentEpoch,
      reason: page
        ? (isCollaborativePage(page) ? "collaboration-active-or-stale" : "collaboration-disabled")
        : "unavailable",
      records: []
    };
    group.records.push(record);
    groups.set(groupKey, group);
  }
  return [...groups.values()].sort((left, right) => {
    const leftUpdatedAt = Math.max(...left.records.map((record) => record.updatedAt));
    const rightUpdatedAt = Math.max(...right.records.map((record) => record.updatedAt));
    return rightUpdatedAt - leftUpdatedAt || left.pageId.localeCompare(right.pageId);
  });
}

async function decodeOrphanedCollaborationRecoveryGroups(groups) {
  const recoveries = [];
  for (const group of groups) {
    const sources = group.records.map((record) => ({
      sourceId: record.sourceId,
      documentEpoch: record.documentEpoch,
      generation: record.generation,
      updatedAt: new Date(record.updatedAt).toISOString()
    }));
    const updatedAt = sources.map((source) => source.updatedAt).sort().at(-1) ?? new Date(0).toISOString();
    try {
      const snapshot = await decodeCollaborationRecoveryRecords(group.records);
      recoveries.push({
        reason: group.reason,
        pageId: group.pageId,
        documentEpoch: group.documentEpoch,
        updatedAt,
        sources,
        title: snapshot.title,
        blocks: snapshot.blocks,
        deletedAttachmentIds: snapshot.deletedAttachmentIds
      });
    } catch (error) {
      // Keep an exact encoded fallback even if a future/incompatible Yjs payload
      // cannot be decoded by the currently loaded client.
      recoveries.push({
        reason: group.reason,
        pageId: group.pageId,
        documentEpoch: group.documentEpoch,
        updatedAt,
        sources,
        decodeError: error?.message || String(error),
        encodedUpdates: group.records.map((record) => ({
          sourceId: record.sourceId,
          documentEpoch: record.documentEpoch,
          update: record.encodedUpdate
        }))
      });
    }
  }
  return recoveries;
}

function appendOrphanedCollaborationRecoveryPanel(recoveries) {
  if (!recoveries.length) return;
  const panel = document.createElement("section");
  panel.className = "local-draft-recovery-panel home-collaboration-recovery-panel";
  panel.setAttribute("role", "alert");

  const heading = document.createElement("strong");
  heading.textContent = t("status.orphanedCollaborationRecovery");

  const details = document.createElement("pre");
  details.tabIndex = 0;
  details.textContent = JSON.stringify(recoveries, null, 2);
  panel.append(heading, details);
  elements.homeDocumentList.prepend(panel);
}

async function refreshOrphanedCollaborationRecovery() {
  const generation = ++collaborationRecoveryPanelGeneration;
  elements.homeDocumentList.querySelector(".home-collaboration-recovery-panel")?.remove();
  if (state.workspaceView !== "home" || !state.user) return;
  const groups = getOrphanedCollaborationRecoveryGroups();
  if (!groups.length) return;
  const recoveries = await decodeOrphanedCollaborationRecoveryGroups(groups);
  if (
    generation !== collaborationRecoveryPanelGeneration
    || state.workspaceView !== "home"
    || !state.user
  ) return;
  appendOrphanedCollaborationRecoveryPanel(recoveries);
}

function refreshCollaborativePageDraftRecovery() {
  elements.blockList.querySelector(".collaboration-local-draft-recovery-panel")?.remove();
  const page = state.selectedPage;
  if (state.workspaceView !== "page" || !isCollaborativePage(page)) return;
  appendPageDraftRecoveryPanel(elements.blockList, getCollaborativePageDrafts(page.id), { collaborative: true });
}

function renderHome() {
  collaborationRecoveryPanelGeneration += 1;
  elements.homeDocumentCount.textContent = t("counts.documents", { count: formatNumber(state.allPages.length) });
  elements.homeDocumentList.replaceChildren();
  elements.homeCollectionList.replaceChildren();
  appendOrphanedPageDraftRecovery();

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
  if (state.workspaceView === "home") void refreshOrphanedCollaborationRecovery();
}


function renderPages() {
  renderDefaultCollection();
  renderDocumentTree();
  renderHome();
  renderCollectionView();
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

function buildCollaborationBlockTree(flatBlocks) {
  const nodes = new Map();
  for (const block of flatBlocks ?? []) {
    if (!block?.id || nodes.has(block.id)) continue;
    const previous = getBlockById(block.id);
    nodes.set(block.id, {
      ...(previous ?? {}),
      ...block,
      version: Number(previous?.version ?? block.version ?? 1),
      createdAt: previous?.createdAt ?? block.createdAt ?? null,
      updatedAt: previous?.updatedAt ?? block.updatedAt ?? null,
      children: []
    });
  }

  const wouldCreateCycleOrExcessiveDepth = (node) => {
    const visited = new Set([node.id]);
    let parentId = node.parentBlockId;
    let depth = 0;
    while (parentId) {
      if (visited.has(parentId) || depth >= 128) return true;
      visited.add(parentId);
      parentId = nodes.get(parentId)?.parentBlockId ?? null;
      depth += 1;
    }
    return false;
  };

  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentBlockId && !wouldCreateCycleOrExcessiveDepth(node)
      ? nodes.get(node.parentBlockId)
      : null;
    if (parent) parent.children.push(node);
    else {
      node.parentBlockId = null;
      roots.push(node);
    }
  }

  const sortChildren = (items) => {
    items.sort((left, right) =>
      Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0) || String(left.id).localeCompare(String(right.id))
    );
    items.forEach((item, index) => {
      item.sortOrder = index;
      sortChildren(item.children ?? []);
    });
  };
  sortChildren(roots);
  return roots;
}

function getCollaborationBlockSignature(blocks) {
  return JSON.stringify(
    flattenBlocks(blocks ?? []).map((block) => ({
      id: block.id,
      type: block.type,
      markdown: block.markdown ?? "",
      checked: Boolean(block.checked),
      parentBlockId: block.parentBlockId ?? null,
      sortOrder: Number(block.sortOrder ?? 0),
      metadata: block.metadata ?? null
    }))
  );
}

function captureCollaborationEditorFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active === elements.pageTitle) {
    return {
      kind: "title",
      start: elements.pageTitle.selectionStart,
      end: elements.pageTitle.selectionEnd
    };
  }
  const row = getBlockRow(active);
  if (!row?.dataset.blockId) return null;
  const controls = [...row.querySelectorAll("input, textarea, select, button, summary")];
  const index = controls.indexOf(active);
  return {
    kind: "block",
    blockId: row.dataset.blockId,
    controlIndex: index,
    start: "selectionStart" in active ? active.selectionStart : null,
    end: "selectionEnd" in active ? active.selectionEnd : null
  };
}

function restoreCollaborationEditorFocus(focus) {
  if (!focus) return;
  let control = null;
  if (focus.kind === "title") control = elements.pageTitle;
  else if (focus.kind === "block") {
    const row = findRenderedBlockRow(focus.blockId);
    control = [...(row?.querySelectorAll("input, textarea, select, button, summary") ?? [])][focus.controlIndex] ?? null;
  }
  if (!(control instanceof HTMLElement) || control.disabled) return;
  control.focus({ preventScroll: true });
  if (
    Number.isInteger(focus.start) &&
    Number.isInteger(focus.end) &&
    "setSelectionRange" in control &&
    typeof control.setSelectionRange === "function"
  ) {
    const length = typeof control.value === "string" ? control.value.length : 0;
    control.setSelectionRange(Math.min(focus.start, length), Math.min(focus.end, length));
  }
}

function updateInputValuePreservingSelection(input, value) {
  if (!input || input.value === value) return;
  const active = document.activeElement === input;
  const start = active ? input.selectionStart : null;
  const end = active ? input.selectionEnd : null;
  input.value = value;
  if (active && Number.isInteger(start) && Number.isInteger(end)) {
    input.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
  }
}

function updatePageCollaborationSummary(pageId, collaboration) {
  const apply = (page) => {
    if (page?.id === pageId) page.collaboration = { ...collaboration };
  };
  apply(state.selectedPage);
  for (const pages of [state.pages, state.allPages]) pages.forEach(apply);
}

function applyCollaborationSnapshot(snapshot, { source = "remote" } = {}) {
  if (!state.selectedPage || state.workspaceView !== "page" || !isCollaborativePage()) return;
  const previousTitle = state.selectedPage.title ?? "";
  const previousBlockSignature = getCollaborationBlockSignature(state.selectedPage.blocks);
  const nextBlocks = buildCollaborationBlockTree(snapshot.blocks ?? []);
  const nextBlockSignature = getCollaborationBlockSignature(nextBlocks);
  const nextTitle = requirePageTitleWithinLimit(snapshot.title);

  state.selectedPage.title = nextTitle;
  state.selectedPage.blocks = nextBlocks;
  for (const pages of [state.pages, state.allPages]) {
    const summary = pages.find((page) => page.id === state.selectedPage.id);
    if (summary) summary.title = nextTitle;
  }

  if (source === "local") {
    syncBeforeUnloadProtection();
    return;
  }

  const blocksChanged = previousBlockSignature !== nextBlockSignature;
  const titleChanged = previousTitle !== nextTitle;
  if (!blocksChanged) {
    if (titleChanged) {
      updateInputValuePreservingSelection(elements.pageTitle, nextTitle);
      renderPageHeader(state.selectedPage);
      renderDocumentTree();
      renderHome();
    }
    renderCollaborationPresence();
    return;
  }

  const focus = captureCollaborationEditorFocus();
  state.applyingCollaborationSnapshot = true;
  try {
    renderSelectedPage();
  } finally {
    state.applyingCollaborationSnapshot = false;
  }
  requestAnimationFrame(() => {
    restoreCollaborationEditorFocus(focus);
    renderCollaborationPresence();
  });
}

function applyCollaborationMaterialization(result) {
  if (!state.selectedPage || !result) return;
  state.selectedPage.version = Number(result.pageVersion ?? state.selectedPage.version ?? 1);
  state.selectedPage.contentVersion = Number(result.pageContentVersion ?? state.selectedPage.contentVersion ?? 1);
  if (result.pageUpdatedAt) state.selectedPage.updatedAt = result.pageUpdatedAt;

  const serverBlocks = new Map((result.blocks ?? []).map((block) => [block.id, block]));
  for (const block of flattenBlocks(state.selectedPage.blocks ?? [])) {
    const serverBlock = serverBlocks.get(block.id);
    if (!serverBlock) continue;
    block.version = Number(serverBlock.version ?? block.version ?? 1);
    block.updatedAt = serverBlock.updatedAt ?? block.updatedAt;
    block.createdAt = serverBlock.createdAt ?? block.createdAt;
    if (block.type === "ATTACHMENT") {
      block.markdown = serverBlock.markdown;
      block.metadata = serverBlock.metadata;
    }
  }

  for (const pages of [state.pages, state.allPages]) {
    const page = pages.find((item) => item.id === state.selectedPage.id);
    if (!page) continue;
    page.title = state.selectedPage.title;
    page.version = state.selectedPage.version;
    page.contentVersion = state.selectedPage.contentVersion;
    page.updatedAt = state.selectedPage.updatedAt;
  }
  syncBeforeUnloadProtection();
}

function getCollaborationStatusLabel(status = state.collaborationStatus) {
  return t(`sharing.status.${status}`);
}

function getPresenceDisplayName(client) {
  return client?.user?.name?.trim() || client?.user?.username || t("sharing.editor");
}

function getRemoteCollaborationPresence() {
  return state.collaborationPresence.filter((client) => client?.user?.id !== state.user?.id);
}

function setRemoteCaretColor(element, color) {
  element?.style?.setProperty("--remote-caret-color", color);
}

function clearRemoteCollaborationCarets() {
  document.querySelectorAll(".remote-collaboration-caret").forEach((caret) => caret.remove());
}

function getRemoteCollaborationCaretTarget(client) {
  const awareness = client?.state;
  if (!awareness?.selection) return null;
  if (awareness.control === "title" || awareness.field === "title") return elements.pageTitle;
  if (!awareness.blockId) return null;

  const row = findRenderedBlockRow(awareness.blockId);
  if (!row) return null;
  const exactControl = getTextSelectionControlByKey(row, awareness.control);
  if (exactControl) return exactControl;
  if (awareness.field === "markdown") return row.querySelector('textarea[name="markdown"]');
  if (awareness.field === "table") return row.querySelector(".table-cell-input");
  return getRowTextSelectionControls(row)[0] ?? null;
}

function renderRemoteCollaborationCarets() {
  collaborationCaretRenderFrame = null;
  clearRemoteCollaborationCarets();
  if (!state.selectedPage || state.workspaceView !== "page" || !isCollaborativePage()) return;

  const presence = getRemoteCollaborationPresence();
  const colors = assignRemoteCaretColors(presence);
  for (const client of presence) {
    const selection = client?.state?.selection;
    if (!Number.isSafeInteger(selection?.head)) continue;
    const control = getRemoteCollaborationCaretTarget(client);
    if (!control || !document.contains(control)) continue;
    const caretRect = getTextControlCaretRect(control, selection.head);
    if (!caretRect) continue;

    const color = colors.get(getRemoteCaretClientKey(client)) ?? "#2563eb";
    const caret = document.createElement("span");
    caret.className = "remote-collaboration-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.dataset.connectionId = String(client.connectionId ?? "");
    caret.style.left = `${caretRect.left}px`;
    caret.style.top = `${caretRect.top}px`;
    caret.style.height = `${caretRect.height}px`;
    setRemoteCaretColor(caret, color);
    if (caretRect.top < 38) caret.classList.add("is-label-below");

    const line = document.createElement("span");
    line.className = "remote-collaboration-caret-line";
    const label = document.createElement("span");
    label.className = "remote-collaboration-caret-label";
    label.textContent = getPresenceDisplayName(client);
    caret.append(line, label);
    document.body.append(caret);
  }
}

function scheduleRemoteCollaborationCaretRender() {
  if (collaborationCaretRenderFrame !== null) return;
  collaborationCaretRenderFrame = window.requestAnimationFrame(renderRemoteCollaborationCarets);
}

function renderCollaborationPresence() {
  elements.collaborationPresence.replaceChildren();
  const presence = getRemoteCollaborationPresence();
  const colors = assignRemoteCaretColors(presence);
  elements.collaborationPresence.setAttribute(
    "aria-label",
    t("sharing.activeEditors", { count: presence.length })
  );

  for (const client of presence.slice(0, 5)) {
    const avatar = document.createElement("span");
    avatar.className = "collaboration-presence-avatar";
    const name = getPresenceDisplayName(client);
    const color = colors.get(getRemoteCaretClientKey(client)) ?? "#2563eb";
    setRemoteCaretColor(avatar, color);
    avatar.title = name;
    avatar.setAttribute("aria-label", name);
    if (client.user?.avatarData) {
      const image = document.createElement("img");
      image.src = client.user.avatarData;
      image.alt = "";
      avatar.append(image);
    } else {
      avatar.textContent = getUserInitials(client.user ?? { username: "?" });
    }
    elements.collaborationPresence.append(avatar);
  }

  for (const row of elements.blockList.querySelectorAll(".editor-block-row")) {
    row.classList.remove("has-remote-editor");
    row.style.removeProperty("--remote-caret-color");
    row.querySelectorAll(".remote-editor-label").forEach((label) => label.remove());
  }
  const byBlock = new Map();
  for (const client of presence) {
    const blockId = client?.state?.blockId;
    if (!blockId) continue;
    const editors = byBlock.get(blockId) ?? [];
    editors.push(client);
    byBlock.set(blockId, editors);
  }
  for (const [blockId, editors] of byBlock) {
    const row = findRenderedBlockRow(blockId);
    if (!row) continue;
    row.classList.add("has-remote-editor");
    const primaryColor = colors.get(getRemoteCaretClientKey(editors[0])) ?? "#2563eb";
    setRemoteCaretColor(row, primaryColor);
    const topLine = row.querySelector(".block-row-topline");
    for (const editor of editors) {
      const label = document.createElement("span");
      label.className = "remote-editor-label";
      label.textContent = getPresenceDisplayName(editor);
      label.title = t("sharing.remoteEditing", { name: label.textContent });
      setRemoteCaretColor(label, colors.get(getRemoteCaretClientKey(editor)) ?? primaryColor);
      topLine?.append(label);
    }
  }
  scheduleRemoteCollaborationCaretRender();
}

function renderCollaborationChrome() {
  const visible = Boolean(state.selectedPage && state.workspaceView === "page" && isCollaborativePage());
  elements.collaborationIndicator.classList.toggle("hidden", !visible);
  if (!visible) {
    elements.collaborationPresence.replaceChildren();
    clearRemoteCollaborationCarets();
    return;
  }
  elements.collaborationIndicator.dataset.status = state.collaborationStatus;
  elements.collaborationStatusLabel.textContent = getCollaborationStatusLabel();
  renderCollaborationPresence();
}

async function destroyPageCollaboration({ flush = true } = {}) {
  const session = state.collaborationSession;
  state.collaborationGeneration += 1;
  state.collaborationSession = null;
  state.collaborationStatus = "offline";
  state.collaborationPresence = [];
  renderCollaborationChrome();
  if (session) await session.destroy({ flush });
}

async function handleCollaborationAccessChanged(generation, pageId) {
  if (generation !== state.collaborationGeneration || state.selectedPage?.id !== pageId) return;
  setStatus(t("sharing.accessChanged"), true);
  await destroyPageCollaboration({ flush: false });
  try {
    const data = await api(`/api/pages/${encodeURIComponent(pageId)}`);
    if (state.selectedPage?.id !== pageId) return;
    state.selectedPage = data.page;
    renderSelectedPage();
    if (isCollaborativePage(data.page)) await startPageCollaboration(data.page);
  } catch {
    await loadPages(elements.searchInput.value.trim(), state.activeTag).catch(() => undefined);
    await showHome({ skipFlush: true });
  }
}

async function startPageCollaboration(page = state.selectedPage) {
  if (!page || !isCollaborativePage(page) || state.selectedPage?.id !== page.id) return null;
  const generation = state.collaborationGeneration + 1;
  state.collaborationGeneration = generation;
  state.collaborationStatus = "connecting";
  state.collaborationPresence = [];
  syncPageModeUi();

  try {
    const session = await createPageCollaboration({
      page,
      accountId: state.user?.id,
      recoverySourceId: pageDraftSourceId,
      recoveryStore: collaborationRecoveryStore,
      api,
      onSnapshot: (snapshot, context) => {
        if (generation !== state.collaborationGeneration || state.selectedPage?.id !== page.id) return;
        applyCollaborationSnapshot(snapshot, context);
      },
      onPresence: (presence) => {
        if (generation !== state.collaborationGeneration || state.selectedPage?.id !== page.id) return;
        state.collaborationPresence = presence;
        renderCollaborationChrome();
      },
      onStatus: (status) => {
        if (generation !== state.collaborationGeneration || state.selectedPage?.id !== page.id) return;
        state.collaborationStatus = status;
        syncPageModeUi();
      },
      onError: (error) => {
        console.error("Page collaboration error", error);
        if (generation === state.collaborationGeneration && state.selectedPage?.id === page.id) {
          state.collaborationStatus = "error";
          renderCollaborationChrome();
          if (error?.code === "COLLABORATION_RECOVERY_WRITE_FAILED") {
            setStatus(t("status.localDraftStorageFailed"), true);
          }
        }
      },
      onAccessChanged: () => {
        void handleCollaborationAccessChanged(generation, page.id);
      },
      onMaterialized: (result) => {
        if (generation !== state.collaborationGeneration || state.selectedPage?.id !== page.id) return;
        applyCollaborationMaterialization(result);
      }
    });

    if (generation !== state.collaborationGeneration || state.selectedPage?.id !== page.id) {
      await session.destroy({ flush: false });
      return null;
    }
    state.collaborationSession = session;
    syncPageModeUi();
    return session;
  } catch (error) {
    if (generation === state.collaborationGeneration && state.selectedPage?.id === page.id) {
      state.collaborationStatus = "error";
      syncPageModeUi();
      setStatus(error.message, true);
    }
    return null;
  }
}

function getCollaborationField(target) {
  if (target === elements.pageTitle) return "title";
  if (target?.matches?.('textarea[name="markdown"]')) return "markdown";
  if (target?.matches?.('input[name="checked"]')) return "checked";
  if (target?.classList?.contains("table-cell-input")) return "table";
  if (target?.closest?.(".kanban-block-editor")) return "kanban";
  if (target?.closest?.(".database-block-editor")) return "database";
  if (target?.closest?.(".gantt-block-editor")) return "gantt";
  if (target?.closest?.(".bookmark-block-editor")) return "bookmark";
  if (target?.closest?.(".ai-chat-block-editor")) return "ai-chat";
  return "block";
}

function updateCollaborationAwareness(target = document.activeElement) {
  const session = state.collaborationSession;
  if (!session?.isReady) return;
  if (target === elements.pageTitle) {
    const selection = Number.isInteger(elements.pageTitle.selectionStart)
      && Number.isInteger(elements.pageTitle.selectionEnd)
      ? { anchor: elements.pageTitle.selectionStart, head: elements.pageTitle.selectionEnd }
      : null;
    session.setAwareness({
      blockId: null,
      field: "title",
      control: selection ? "title" : null,
      selection
    });
    return;
  }
  const row = getBlockRow(target);
  if (!row?.dataset.blockId) {
    session.setAwareness({ blockId: null, field: null, control: null, selection: null });
    return;
  }
  const selection = Number.isInteger(target?.selectionStart) && Number.isInteger(target?.selectionEnd)
    ? { anchor: target.selectionStart, head: target.selectionEnd }
    : null;
  session.setAwareness({
    blockId: row.dataset.blockId,
    field: getCollaborationField(target),
    control: selection ? getTextSelectionControlKey(target, row) : null,
    selection
  });
}

function setSharePageMessage(message = "", isError = false) {
  elements.sharePageMessage.textContent = message;
  elements.sharePageMessage.classList.toggle("is-error", isError);
}

function renderSharePageList() {
  elements.sharePageList.replaceChildren();
  elements.sharePageCount.textContent = t("sharing.count", { count: state.sharePageEntries.length });
  if (!state.sharePageEntries.length) {
    const empty = document.createElement("li");
    empty.className = "share-page-empty";
    empty.textContent = t("sharing.none");
    elements.sharePageList.append(empty);
    return;
  }

  for (const share of state.sharePageEntries) {
    const item = document.createElement("li");
    item.className = "share-page-list-item";
    const avatar = document.createElement("span");
    avatar.className = "share-page-user-avatar";
    if (share.user?.avatarData) {
      const image = document.createElement("img");
      image.src = share.user.avatarData;
      image.alt = "";
      avatar.append(image);
    } else {
      avatar.textContent = getUserInitials(share.user ?? { username: "?" });
    }
    const copy = document.createElement("span");
    copy.className = "share-page-user-copy";
    const name = document.createElement("strong");
    name.textContent = share.user?.name?.trim() || share.user?.username;
    const meta = document.createElement("span");
    meta.textContent = `@${share.user?.username} · ${t("sharing.editor")}`;
    copy.append(name, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "share-page-remove";
    remove.dataset.userId = share.user?.id;
    remove.dataset.username = share.user?.username;
    remove.textContent = t("sharing.remove");
    item.append(avatar, copy, remove);
    elements.sharePageList.append(item);
  }
}

function isCurrentSharePageRequest(requestGeneration, pageId) {
  return Boolean(
    requestGeneration === sharePageRequestGeneration
      && state.sharePageOpen
      && state.selectedPage?.id === pageId
      && isPageOwner()
  );
}

async function loadPageShares(pageId, requestGeneration) {
  if (!isCurrentSharePageRequest(requestGeneration, pageId)) return;
  setSharePageMessage(t("sharing.loading"));
  try {
    const data = await api(`/api/pages/${encodeURIComponent(pageId)}/shares`);
    if (!isCurrentSharePageRequest(requestGeneration, pageId)) return;
    state.sharePageEntries = data.shares ?? [];
    renderSharePageList();
    setSharePageMessage();
  } catch (error) {
    if (isCurrentSharePageRequest(requestGeneration, pageId)) {
      setSharePageMessage(error.message, true);
    }
  }
}

async function openSharePageDialog() {
  const pageId = state.selectedPage?.id;
  if (!pageId || !isPageOwner()) return;
  const requestGeneration = ++sharePageRequestGeneration;
  await flushPendingPageEdits();
  if (
    requestGeneration !== sharePageRequestGeneration
      || state.selectedPage?.id !== pageId
      || !isPageOwner()
  ) return;
  state.sharePageOpen = true;
  state.sharePageEntries = [];
  elements.sharePageLayer.classList.remove("hidden");
  elements.sharePageLayer.setAttribute("aria-hidden", "false");
  renderSharePageList();
  await loadPageShares(pageId, requestGeneration);
  if (isCurrentSharePageRequest(requestGeneration, pageId)) {
    requestAnimationFrame(() => {
      if (isCurrentSharePageRequest(requestGeneration, pageId)) elements.sharePageUsername.focus();
    });
  }
}

function closeSharePageDialog({ restoreFocus = true } = {}) {
  sharePageRequestGeneration += 1;
  if (!state.sharePageOpen) return;
  state.sharePageOpen = false;
  state.sharePageEntries = [];
  elements.sharePageLayer.classList.add("hidden");
  elements.sharePageLayer.setAttribute("aria-hidden", "true");
  elements.sharePageForm.reset();
  renderSharePageList();
  setSharePageMessage();
  if (restoreFocus && elements.sharePageButton.isConnected && !elements.sharePageButton.classList.contains("hidden")) {
    elements.sharePageButton.focus();
  }
}

async function setSelectedPageShareCount(count) {
  if (!state.selectedPage) return;
  const previousEnabled = isCollaborativePage();
  const collaboration = { enabled: count > 0, participantCount: count + 1 };
  updatePageCollaborationSummary(state.selectedPage.id, collaboration);
  renderSharePageList();

  if (!previousEnabled && collaboration.enabled) {
    renderSelectedPage();
    await startPageCollaboration(state.selectedPage);
  } else if (previousEnabled && !collaboration.enabled) {
    await destroyPageCollaboration({ flush: false });
    renderSelectedPage();
  } else {
    renderCollaborationChrome();
  }
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

function parseToggleMarkdown(value) {
  const normalized = String(value ?? "").replace(/\r\n?/g, "\n");
  const newlineIndex = normalized.indexOf("\n");
  if (newlineIndex < 0) return { title: normalized.slice(0, toggleTitleMaxLength), body: "" };
  return {
    title: normalized.slice(0, newlineIndex).slice(0, toggleTitleMaxLength),
    body: normalized.slice(newlineIndex + 1)
  };
}

function serializeToggleMarkdown(title, body) {
  const safeTitle = String(title ?? "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, toggleTitleMaxLength);
  const safeBody = String(body ?? "").replace(/\r\n?/g, "\n");
  return safeBody ? `${safeTitle}\n${safeBody}` : safeTitle;
}

function getBlockToggleOpen(block) {
  return block?.metadata?.toggleOpen !== false;
}

function getToggleMarkdownFromRow(row, fallback = "") {
  if (!row || row.dataset.blockType !== "TOGGLE") return fallback;
  const title = row.querySelector(".toggle-title-input")?.value ?? parseToggleMarkdown(fallback).title;
  const body = getBlockTextarea(row)?.value ?? parseToggleMarkdown(fallback).body;
  return serializeToggleMarkdown(title, body);
}

function isBlockMarkdownEmpty(row, textarea) {
  if (row?.dataset.blockType === "TOGGLE") {
    return !row.querySelector(".toggle-title-input")?.value.trim() && !textarea?.value.trim();
  }
  if (listBlockTypes.has(row?.dataset.blockType)) {
    const content = textarea?.value.replace(/^\s*(?:[-+*]|\d+[.)])\s*/gm, "") ?? "";
    return !content.trim();
  }
  return !textarea?.value.trim();
}

function setToggleBlockOpen(row, open, { persist = true } = {}) {
  if (!row || row.dataset.blockType !== "TOGGLE") return;
  const expanded = Boolean(open);
  row.dataset.toggleOpen = String(expanded);
  const button = row.querySelector('[data-action="toggle-block"]');
  const content = row.querySelector(".toggle-block-content");
  const indicator = row.querySelector(".toggle-block-indicator");
  button?.setAttribute("aria-expanded", String(expanded));
  if (button) button.title = t(expanded ? "toggle.collapse" : "toggle.expand");
  if (content) content.hidden = !expanded;
  if (indicator) indicator.textContent = expanded ? "⌄" : "›";
  row.querySelector(".toggle-block-surface")?.classList.toggle("is-open", expanded);
  if (persist) scheduleBlockSave(row);
}

function normalizeTextAlign(value) {
  return textAlignments.has(value) ? value : "left";
}

function getBlockTextAlign(block) {
  return normalizeTextAlign(block?.metadata?.textAlign);
}

function isTextAlignableBlockType(type) {
  return textAlignableBlockTypes.has(type);
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

function getBlockVersionSnapshot(blockId, { includeDescendants = true } = {}) {
  const block = getBlockById(blockId);
  if (!block) return [];

  const snapshot = [];
  const visit = (item) => {
    snapshot.push({ id: item.id, version: Number(item.version ?? 1) });
    if (includeDescendants) for (const child of item.children ?? []) visit(child);
  };
  visit(block);
  return snapshot;
}

function blockSnapshotHasUnresolvedDraftConflict(expectedVersions) {
  return expectedVersions.some(({ id }) => {
    const storedOrigin = blockDraftConflictOrigins.get(id);
    return (
      Boolean(storedOrigin && storedOrigin.resolved !== true) ||
      findRenderedBlockRow(id)?.dataset.draftConflict === "true"
    );
  });
}

function blockDeletionHasUnresolvedDraftConflict(blockId, options) {
  return blockSnapshotHasUnresolvedDraftConflict(getBlockVersionSnapshot(blockId, options));
}

async function withCollaborativeDestructiveTransition(pageId, kind, action) {
  return withPagePersistenceTransition(pageId, kind, async () => {
    // A different same-origin tab can hold a durable Yjs recovery snapshot that
    // has not reached the server yet. Flush the current tab, wait for the
    // transition storage event to flush peer tabs, then fail closed if any
    // unacknowledged collaboration state remains before deleting shared data.
    await flushPendingPageEdits({ allowLocked: true, collaborationCompact: false });
    assertNoPendingLocalCollaborationRecovery(pageId);

    const session = state.selectedPage?.id === pageId ? state.collaborationSession : null;
    if (!session?.isReady) throw new Error(t("sharing.syncRequired"));
    const result = await action(session);

    // Keep the cross-tab exclusion lease until the destructive update is both
    // acknowledged and materialized. Otherwise a peer can resume from a stale
    // block while the delete is still only browser-local.
    await session.flushMaterialization({ compact: false });
    return result;
  });
}

function getBlockDeleteTask(authenticationScope, pageId, blockId, payload) {
  const taskKey = [
    authenticationScope.generation,
    authenticationScope.targetKey,
    pageId,
    blockId,
    payload.preserveChildren ? "preserve" : "cascade"
  ].join("\u0000");
  const pendingTask = pendingBlockDeleteTasks.get(taskKey);
  if (pendingTask) return pendingTask;

  const task = {
    taskKey,
    targetKey: authenticationScope.targetKey,
    pageId,
    blockId,
    mutationId: createMutationId(),
    payload: Object.freeze({
      ...payload,
      expectedVersions: Object.freeze(payload.expectedVersions.map((item) => Object.freeze({ ...item })))
    }),
    attempted: false,
    inFlight: false
  };
  pendingBlockDeleteTasks.set(taskKey, task);
  return task;
}

async function submitBlockDeleteTask(task, authenticationScope) {
  if (task.inFlight) throw new Error(t("status.pageTransitionBusy"));
  task.inFlight = true;
  let attempt = 0;

  try {
    while (attempt < 2) {
      if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
      try {
        task.attempted = true;
        const data = await submitWithFreshMutationIdOnReuse(task, () => {
          if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
          return api(`/api/blocks/${encodeURIComponent(task.blockId)}`, {
            method: "DELETE",
            body: { ...task.payload, mutationId: task.mutationId }
          });
        });
        if (data === null && !isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
        if (pendingBlockDeleteTasks.get(task.taskKey) === task) {
          pendingBlockDeleteTasks.delete(task.taskKey);
        }
        return data;
      } catch (error) {
        if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
        attempt += 1;
        if (!isAmbiguousApiError(error) || attempt >= 2) {
          if (!isAmbiguousApiError(error) && pendingBlockDeleteTasks.get(task.taskKey) === task) {
            pendingBlockDeleteTasks.delete(task.taskKey);
          }
          throw error;
        }
      }
    }
    return null;
  } finally {
    task.inFlight = false;
  }
}

async function deleteBlockWithVersionCheck(blockId, options = {}) {
  const pageId = state.selectedPage.id;
  const preserveChildren = options.preserveChildren === true;
  if (isCollaborativePage()) {
    return withCollaborativeDestructiveTransition(pageId, "block-delete", async (session) => ({
      deletedIds: session.deleteBlock(blockId, {
        cascade: options.includeDescendants !== false,
        promoteChildren: preserveChildren
      })
    }));
  }
  const expectedVersions = getBlockVersionSnapshot(blockId, {
    includeDescendants: preserveChildren || options.includeDescendants !== false
  });
  if (blockSnapshotHasUnresolvedDraftConflict(expectedVersions)) {
    throw new Error(t("status.resolveRecoveredDraftConflict"));
  }
  const authenticationScope = captureAuthenticatedSessionScope();
  if (!isCurrentAuthenticatedSessionScope(authenticationScope)) {
    throw new Error(t("errors.UNAUTHENTICATED"));
  }
  const task = getBlockDeleteTask(authenticationScope, pageId, blockId, {
    expectedVersions,
    preserveChildren,
    ...(preserveChildren
      ? { expectedPageContentVersion: Number(state.selectedPage?.contentVersion ?? 1) }
      : {})
  });
  const deletedVersions = task.payload.preserveChildren
    ? task.payload.expectedVersions.filter(({ id }) => id === blockId)
    : task.payload.expectedVersions;
  const recoveredConflictOrigins = deletedVersions
    .map(({ id }) => ({ blockId: id, origin: blockDraftConflictOrigins.get(id) }))
    .filter(({ origin }) => Boolean(origin));
  const scope = getDraftScope();
  try {
    return await withPagePersistenceTransition(pageId, "block-delete", async () => {
      // The server version snapshot cannot observe a draft that only exists in a
      // different tab. Keep that draft attached to its live block instead of
      // deleting the block and relegating the edit to manual orphan recovery.
      assertNoPendingLocalBlockDrafts(
        pageId,
        task.payload.expectedVersions.map(({ id }) => id),
        { excludeSourceId: pageDraftSourceId }
      );
      const data = await submitBlockDeleteTask(task, authenticationScope);
      if (data === null && !isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
      for (const { id } of deletedVersions) blockDraftRenderSources.delete(id);
      if (scope) {
        checkDraftStoreWrite(
          pageDraftStore.removeBlocks(
            scope.userId,
            scope.pageId,
            deletedVersions.map(({ id }) => id),
            pageDraftSourceId
          )
        );
        for (const { blockId: deletedBlockId, origin } of recoveredConflictOrigins) {
          const removed = checkDraftStoreWrite(
            pageDraftStore.removeBlockIfUnchanged({
              userId: scope.userId,
              pageId: scope.pageId,
              blockId: deletedBlockId,
              ...origin
            })
          );
          if (removed && blockDraftConflictOrigins.get(deletedBlockId) === origin) {
            blockDraftConflictOrigins.delete(deletedBlockId);
          }
        }
      }
      return data;
    });
  } catch (error) {
    if (!task.attempted && pendingBlockDeleteTasks.get(task.taskKey) === task) {
      pendingBlockDeleteTasks.delete(task.taskKey);
    }
    throw error;
  }
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

function getBlockDatabaseData(block) {
  return normalizeDatabaseData(block?.metadata?.database);
}

function getBlockAccordionData(block) {
  return normalizeAccordionData(block?.metadata?.accordion);
}

function getBlockTimetableData(block) {
  return normalizeTimetableData(block?.metadata?.timetable);
}

function getBlockGanttData(block) {
  return normalizeGanttData(block?.metadata?.gantt);
}

function getBlockBookmarkData(block) {
  return normalizeBookmarkData(block?.metadata?.bookmark);
}

function getBlockAiChatData(block) {
  return normalizeAiChatData(block?.metadata?.aiChat, { fallbackAnsweredAt: block?.updatedAt });
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

function sizeKanbanColumnTitle(input) {
  const value = input.value || input.placeholder || "";
  input.size = Math.max(4, Math.min(22, [...value].length + 1));
}

function renderKanbanTagPreview(preview, tags) {
  preview.replaceChildren();
  tags.forEach((tag, index) => {
    const chip = document.createElement("span");
    chip.className = `kanban-card-tag kanban-card-tag--${index % 6}`;
    chip.textContent = tag;
    preview.append(chip);
  });
}

function syncKanbanTagField(input) {
  const field = input.closest(".kanban-card-tags-field");
  const preview = field?.querySelector(".kanban-card-tags-preview");
  if (!field || !preview) return;
  const tags = normalizeKanbanTags(input.value);
  field.classList.toggle("is-empty", tags.length === 0);
  renderKanbanTagPreview(preview, tags);
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
  preview.textContent = card.icon || "▦";
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

  const titleRow = document.createElement("div");
  titleRow.className = "kanban-title-row";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "kanban-title-input";
  titleInput.value = boardData.title;
  titleInput.maxLength = kanbanLimits.boardTitleLength;
  titleInput.placeholder = t("kanban.boardTitlePlaceholder");
  titleInput.setAttribute("aria-label", t("kanban.boardTitleAria"));
  titleRow.append(titleInput);

  const viewbar = document.createElement("div");
  viewbar.className = "kanban-viewbar";
  viewbar.setAttribute("role", "toolbar");
  viewbar.setAttribute("aria-label", t("kanban.boardAria"));

  const viewTab = document.createElement("span");
  viewTab.className = "kanban-view-tab is-active";
  viewTab.setAttribute("aria-current", "true");

  const viewIcon = document.createElement("span");
  viewIcon.className = "kanban-view-tab-icon";
  viewIcon.textContent = "▦";
  viewIcon.setAttribute("aria-hidden", "true");

  const viewLabel = document.createElement("span");
  viewLabel.textContent = t("blocks.types.KANBAN");
  viewTab.append(viewIcon, viewLabel);

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

  viewbar.append(viewTab, summary, addColumn);
  toolbar.append(titleRow, viewbar);

  const scroller = document.createElement("div");
  scroller.className = "kanban-board-scroll";
  scroller.tabIndex = 0;

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

    const columnLabel = document.createElement("div");
    columnLabel.className = "kanban-column-label";

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
    sizeKanbanColumnTitle(columnTitle);

    columnLabel.append(colorButton, columnTitle);

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
    deleteColumn.setAttribute("aria-grabbed", "false");
    deleteColumn.disabled = boardData.columns.length <= 1;

    columnHeader.append(columnLabel, count, deleteColumn);

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

      const tagsField = document.createElement("div");
      tagsField.className = "kanban-card-tags-field";

      const tagsPreview = document.createElement("div");
      tagsPreview.className = "kanban-card-tags-preview";
      tagsPreview.tabIndex = 0;
      tagsPreview.setAttribute("role", "button");
      tagsPreview.setAttribute("aria-label", t("kanban.tagsAria"));

      const tagsInput = document.createElement("input");
      tagsInput.type = "text";
      tagsInput.className = "kanban-card-tags";
      tagsInput.value = card.tags.join(", ");
      tagsInput.placeholder = t("kanban.tagsPlaceholder");
      tagsInput.dataset.cardId = card.id;
      tagsInput.setAttribute("aria-label", t("kanban.tagsAria"));
      tagsInput.autocomplete = "off";

      const focusTagsInput = () => {
        tagsInput.focus();
        tagsInput.select();
      };
      tagsPreview.addEventListener("click", focusTagsInput);
      tagsPreview.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        focusTagsInput();
      });

      tagsField.append(tagsPreview, tagsInput);
      syncKanbanTagField(tagsInput);

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
      cardElement.append(cardTop, description, tagsField, cardFooter);
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
  if (!promoteBlockDraftConflict(row)) return;
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

function getKanbanColumnInsertionIndex(clientX, candidates) {
  for (let index = 0; index < candidates.length; index += 1) {
    const rect = candidates[index].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return index;
  }
  return candidates.length;
}

function placeKanbanColumnDropIndicator(drag) {
  if (!drag?.indicator || !drag.board) return;
  const candidate = drag.candidates[drag.targetIndex];
  if (candidate) {
    drag.board.insertBefore(drag.indicator, candidate);
    return;
  }
  const last = drag.candidates.at(-1);
  if (last) last.after(drag.indicator);
  else drag.board.insertBefore(drag.indicator, drag.column);
}

function autoScrollForKanbanColumnDrag(clientX, drag) {
  const scroller = drag?.scroller;
  if (!scroller) return;
  const rect = scroller.getBoundingClientRect();
  const edge = Math.min(72, Math.max(40, rect.width * 0.12));
  if (clientX < rect.left + edge) {
    scroller.scrollBy(-Math.max(6, (rect.left + edge - clientX) * 0.2), 0);
  } else if (clientX > rect.right - edge) {
    scroller.scrollBy(Math.max(6, (clientX - (rect.right - edge)) * 0.2), 0);
  }
}

function activateKanbanColumnDrag(event) {
  const drag = activeKanbanColumnDrag;
  if (!drag || drag.active) return false;

  const columns = getKanbanColumns(drag.row);
  if (columns.length < 2 || !columns.includes(drag.column)) return false;

  closeKanbanCardStyleMenus();
  drag.active = true;
  drag.columns = columns;
  drag.candidates = columns.filter((column) => column !== drag.column);
  drag.initialIndex = columns.indexOf(drag.column);
  drag.targetIndex = drag.initialIndex;
  drag.indicator = document.createElement("div");
  drag.indicator.className = "kanban-column-drop-indicator";
  drag.indicator.setAttribute("aria-hidden", "true");

  drag.column.classList.add("is-column-dragging");
  drag.handle.classList.add("is-pressed");
  drag.handle.setAttribute("aria-grabbed", "true");
  document.body.classList.add("is-kanban-column-dragging");
  placeKanbanColumnDropIndicator(drag);
  event.preventDefault();
  return true;
}

function updateKanbanColumnDrag(event) {
  const drag = activeKanbanColumnDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;

  if (!drag.active) {
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    const threshold = event.pointerType === "touch" ? 7 : 4;
    if (distance < threshold) return;
    if (!activateKanbanColumnDrag(event)) return;
  }

  event.preventDefault();
  drag.targetIndex = getKanbanColumnInsertionIndex(event.clientX, drag.candidates);
  placeKanbanColumnDropIndicator(drag);
  autoScrollForKanbanColumnDrag(event.clientX, drag);
}

function clearKanbanColumnDragVisuals(drag) {
  if (!drag) return;
  drag.column?.classList.remove("is-column-dragging");
  drag.indicator?.remove();
  drag.handle?.classList.remove("is-pressed");
  drag.handle?.setAttribute("aria-grabbed", "false");
  document.body.classList.remove("is-kanban-column-dragging");
}

function finishKanbanColumnDrag(event, { cancelled = false } = {}) {
  const drag = activeKanbanColumnDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  activeKanbanColumnDrag = null;

  if (drag.handle.hasPointerCapture?.(drag.pointerId)) {
    drag.handle.releasePointerCapture(drag.pointerId);
  }

  if (!drag.active) {
    drag.handle.classList.remove("is-pressed");
    return;
  }

  event.preventDefault();
  suppressKanbanColumnMenuClickUntil = Date.now() + 500;
  clearKanbanColumnDragVisuals(drag);
  if (cancelled || drag.targetIndex === drag.initialIndex || !drag.row.isConnected) return;

  const data = extractKanbanData(drag.row);
  const sourceIndex = data.columns.findIndex((column) => column.id === drag.column.dataset.columnId);
  if (sourceIndex < 0) return;
  const [column] = data.columns.splice(sourceIndex, 1);
  data.columns.splice(Math.min(drag.targetIndex, data.columns.length), 0, column);
  replaceKanbanData(drag.row, data);
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

function renderLatexInto(element, latex, displayMode = false) {
  if (!element) return;
  const source = String(latex ?? "").trim();
  element.dataset.latex = source;
  element.dataset.mathDisplay = String(displayMode);
  element.classList.toggle("is-empty", !source);

  if (!source) {
    element.textContent = t("math.emptyPreview");
    return;
  }

  const katex = globalThis.katex;
  if (!katex?.render) {
    element.textContent = source;
    return;
  }

  try {
    katex.render(source, element, {
      displayMode,
      throwOnError: false,
      strict: "warn",
      trust: false,
      output: "htmlAndMathml"
    });
  } catch (error) {
    console.warn("KaTeX rendering failed", error);
    element.textContent = source;
  }
}

function hydrateMathExpressions(root = document) {
  for (const expression of root.querySelectorAll(".math-expression[data-latex]")) {
    renderLatexInto(expression, expression.dataset.latex ?? expression.textContent ?? "", expression.dataset.mathDisplay === "true");
  }
}

function updateMathBlockPreview(row, latex) {
  const preview = row?.querySelector(".math-block-preview");
  if (preview) renderLatexInto(preview, latex, true);
}

function updateCodeBlockPreview(row, value, language = row?.dataset?.codeLanguage) {
  const preview = row?.querySelector(".block-rendered-preview");
  if (!preview) return;
  renderCodePreview(preview, value, language);
}

function updateRenderedBlockPreview(row, block) {
  const preview = row?.querySelector(".block-rendered-preview");
  if (!preview || !block) return;
  if (block.type === "MATH") {
    renderLatexInto(preview, block.markdown, true);
    return;
  }
  if (block.type === "CODE") {
    renderCodePreview(preview, block.markdown, getBlockCodeLanguage(block));
    return;
  }
  preview.innerHTML = block.htmlCache ?? "";
  if (!block.htmlCache) preview.textContent = block.markdown ?? "";
  hydrateMathExpressions(preview);
  hydrateHighlightedCodeBlocks(preview);
  hydrateAccordionIcons(preview);
}

function createTextBlockEditor(block) {
  const editor = document.createElement("div");
  editor.className = "text-block-editor";
  if (block.type === "MATH") editor.classList.add("math-block-editor");
  if (block.type === "CODE") editor.classList.add("code-block-editor");

  const textarea = document.createElement("textarea");
  textarea.name = "markdown";
  textarea.className = "block-row-input";
  textarea.rows = block.type === "MATH" ? 2 : block.type === "CODE" ? 5 : 1;
  textarea.maxLength = BLOCK_MARKDOWN_MAX_LENGTH;
  textarea.spellcheck = !["MATH", "CODE"].includes(block.type);
  if (block.type === "CODE") {
    textarea.wrap = "off";
    textarea.autocapitalize = "off";
    textarea.autocomplete = "off";
  }
  textarea.placeholder = block.type === "DIVIDER"
    ? t("block.dividerPlaceholder")
    : block.type === "MATH"
      ? t("math.blockPlaceholder")
      : t("block.contentPlaceholder");
  textarea.value = block.markdown ?? "";
  textarea.style.textAlign = getBlockTextAlign(block);
  textarea.setAttribute(
    "aria-label",
    block.type === "MATH" ? t("math.blockAria") : t("block.contentAria", { type: getBlockTypeLabel(block.type) })
  );

  const preview = document.createElement("div");
  preview.className = "block-rendered-preview";
  if (block.type === "MATH") {
    preview.classList.add("math-block-preview", "math-expression", "math-expression--display");
    preview.setAttribute("aria-label", t("math.previewAria"));
  }
  if (block.type === "CODE") {
    preview.classList.add("code-block-preview");
    preview.setAttribute("aria-label", t("block.contentAria", { type: getBlockTypeLabel(block.type) }));
  }

  if (block.type === "CODE") {
    const toolbar = document.createElement("div");
    toolbar.className = "code-block-toolbar";
    const label = document.createElement("label");
    label.className = "code-language-label";
    const labelText = document.createElement("span");
    labelText.textContent = t("language.label");
    const select = document.createElement("select");
    select.className = "code-language-select";
    select.name = "codeLanguage";
    select.setAttribute("aria-label", t("language.label"));
    const selectedLanguage = getBlockCodeLanguage(block);
    for (const language of codeLanguageOptions) {
      const option = document.createElement("option");
      option.value = language.id;
      option.textContent = language.label;
      option.selected = language.id === selectedLanguage;
      select.append(option);
    }
    label.append(labelText, select);
    toolbar.append(label);
    editor.append(toolbar);
  }

  editor.append(textarea, preview);
  updateRenderedBlockPreview(editor, block);
  requestAnimationFrame(() => autoGrowTextarea(textarea));
  return editor;
}

function createToggleBlockEditor(row, block) {
  const { title, body } = parseToggleMarkdown(block.markdown);
  const editor = document.createElement("div");
  editor.className = "toggle-block-editor";

  const surface = document.createElement("div");
  surface.className = "toggle-block-surface";

  const header = document.createElement("div");
  header.className = "toggle-block-header";

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "toggle-block-button";
  toggleButton.dataset.action = "toggle-block";
  toggleButton.setAttribute("aria-controls", `toggle-content-${block.id}`);

  const indicator = document.createElement("span");
  indicator.className = "toggle-block-indicator";
  indicator.setAttribute("aria-hidden", "true");
  toggleButton.append(indicator);

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "toggle-title-input";
  titleInput.maxLength = toggleTitleMaxLength;
  titleInput.value = title;
  titleInput.placeholder = t("toggle.titlePlaceholder");
  titleInput.setAttribute("aria-label", t("toggle.titleAria"));

  const content = document.createElement("div");
  content.id = `toggle-content-${block.id}`;
  content.className = "toggle-block-content";

  const textarea = document.createElement("textarea");
  textarea.name = "markdown";
  textarea.className = "block-row-input toggle-body-input";
  textarea.rows = 3;
  textarea.maxLength = toggleBodyMaxLength;
  textarea.value = body;
  textarea.placeholder = t("toggle.bodyPlaceholder");
  textarea.setAttribute("aria-label", t("toggle.bodyAria"));
  content.append(textarea);

  header.append(toggleButton, titleInput);
  surface.append(header, content);

  const preview = document.createElement("div");
  preview.className = "block-rendered-preview toggle-block-preview";
  preview.innerHTML = block.htmlCache ?? "";
  if (!block.htmlCache) {
    const details = document.createElement("details");
    details.className = "rendered-toggle";
    details.open = getBlockToggleOpen(block);
    const summary = document.createElement("summary");
    summary.className = "rendered-toggle-summary";
    summary.textContent = title || t("toggle.defaultTitle");
    const fallbackContent = document.createElement("div");
    fallbackContent.className = "rendered-toggle-content";
    fallbackContent.textContent = body;
    details.append(summary, fallbackContent);
    preview.append(details);
  }

  const expanded = getBlockToggleOpen(block);
  toggleButton.setAttribute("aria-expanded", String(expanded));
  toggleButton.title = t(expanded ? "toggle.collapse" : "toggle.expand");
  content.hidden = !expanded;
  indicator.textContent = expanded ? "⌄" : "›";
  surface.classList.toggle("is-open", expanded);

  editor.append(surface, preview);
  requestAnimationFrame(() => autoGrowTextarea(textarea));
  return editor;
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

function createBookmarkFavicon(item, className = "bookmark-favicon") {
  const image = document.createElement("img");
  image.className = className;
  image.src = item.faviconUrl;
  image.alt = "";
  image.width = 20;
  image.height = 20;
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => image.remove(), { once: true });
  return image;
}

function makeBookmarkActionButton(action, label, title, itemId = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "bookmark-action-button";
  button.dataset.action = action;
  if (itemId) button.dataset.bookmarkId = itemId;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function createBookmarkItem(item, view) {
  const wrapper = document.createElement(view === "list" ? "div" : "article");
  wrapper.className = view === "list" ? "bookmark-list-item" : "bookmark-gallery-card";
  wrapper.dataset.bookmarkId = item.id;

  const link = document.createElement("a");
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  link.className = "bookmark-item-link";

  if (view === "list") {
    link.append(createBookmarkFavicon(item));
    const title = document.createElement("strong");
    title.textContent = item.title;
    link.append(title);
  } else {
    const media = document.createElement("div");
    media.className = "bookmark-card-media";
    const fallback = document.createElement("span");
    fallback.className = "bookmark-card-media-fallback";
    fallback.setAttribute("aria-hidden", "true");
    fallback.textContent = "🔖";
    media.append(fallback);
    if (item.imageUrl) {
      const image = document.createElement("img");
      image.className = "bookmark-card-image";
      image.src = item.imageUrl;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true });
      media.append(image);
    }

    const content = document.createElement("div");
    content.className = "bookmark-card-content";
    const title = document.createElement("strong");
    title.className = "bookmark-card-title";
    title.textContent = item.title;
    const description = document.createElement("p");
    description.className = "bookmark-card-description";
    description.textContent = item.description || t("bookmark.noDescription");
    const site = document.createElement("span");
    site.className = "bookmark-card-site";
    site.append(createBookmarkFavicon(item), document.createTextNode(item.siteName));
    content.append(title, description, site);
    link.append(media, content);
  }

  const actions = document.createElement("div");
  actions.className = "bookmark-item-actions";
  actions.append(
    makeBookmarkActionButton("bookmark-refresh", "↻", t("bookmark.refresh"), item.id),
    makeBookmarkActionButton("bookmark-remove", "×", t("bookmark.remove"), item.id)
  );
  wrapper.append(link, actions);
  return wrapper;
}

function createBookmarkEditor(row, value) {
  const data = normalizeBookmarkData(value);
  row.bookmarkData = data;

  const editor = document.createElement("div");
  editor.className = "bookmark-block-editor";

  const titleRow = document.createElement("div");
  titleRow.className = "bookmark-title-row";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "bookmark-title-input";
  titleInput.value = data.title;
  titleInput.maxLength = bookmarkLimits.blockTitleLength;
  titleInput.placeholder = t("bookmark.titlePlaceholder");
  titleInput.setAttribute("aria-label", t("bookmark.titleAria"));
  titleRow.append(titleInput);

  const toolbar = document.createElement("div");
  toolbar.className = "bookmark-toolbar";

  const viewToggle = document.createElement("div");
  viewToggle.className = "bookmark-view-toggle";
  viewToggle.setAttribute("role", "group");
  viewToggle.setAttribute("aria-label", t("bookmark.viewAria"));
  for (const view of ["list", "gallery"]) {
    const button = makeBookmarkActionButton(
      "bookmark-set-view",
      t(`bookmark.${view}View`),
      t(`bookmark.${view}ViewTitle`)
    );
    button.classList.add("bookmark-view-button");
    button.dataset.bookmarkView = view;
    button.setAttribute("aria-pressed", String(data.view === view));
    toolbar.classList.toggle(`is-${view}`, data.view === view);
    viewToggle.append(button);
  }

  const listColumnsControl = document.createElement("label");
  listColumnsControl.className = "bookmark-list-columns-control";
  listColumnsControl.hidden = data.view !== "list";

  const listColumnsLabel = document.createElement("span");
  listColumnsLabel.className = "bookmark-list-columns-label";
  listColumnsLabel.textContent = t("bookmark.listColumnsLabel");

  const listColumnsSelect = document.createElement("select");
  listColumnsSelect.className = "bookmark-list-columns-select";
  listColumnsSelect.setAttribute("aria-label", t("bookmark.listColumnsAria"));
  for (let columnCount = 1; columnCount <= bookmarkLimits.maxListColumns; columnCount += 1) {
    const option = document.createElement("option");
    option.value = String(columnCount);
    option.textContent = t("bookmark.columnCount", { count: formatNumber(columnCount) });
    listColumnsSelect.append(option);
  }
  listColumnsSelect.value = String(data.listColumns);
  listColumnsControl.append(listColumnsLabel, listColumnsSelect);
  viewToggle.append(listColumnsControl);

  const count = document.createElement("span");
  count.className = "bookmark-count";
  count.textContent = t("bookmark.count", { count: formatNumber(data.items.length) });
  toolbar.append(viewToggle, count);

  const addRow = document.createElement("div");
  addRow.className = "bookmark-add-row";
  const input = document.createElement("input");
  input.type = "url";
  input.className = "bookmark-url-input";
  input.placeholder = t("bookmark.urlPlaceholder");
  input.setAttribute("aria-label", t("bookmark.urlAria"));
  input.maxLength = bookmarkLimits.urlLength;
  input.autocomplete = "url";
  input.inputMode = "url";
  const addButton = makeBookmarkActionButton("bookmark-add", t("bookmark.add"), t("bookmark.addTitle"));
  addButton.classList.add("bookmark-add-button");
  addButton.disabled = data.items.length >= bookmarkLimits.items;
  addRow.append(input, addButton);

  const items = document.createElement("div");
  items.className = `bookmark-items bookmark-items--${data.view}`;
  if (data.view === "list") items.classList.add(`bookmark-items--list-columns-${data.listColumns}`);
  if (data.items.length) {
    data.items.forEach((item) => items.append(createBookmarkItem(item, data.view)));
  } else {
    const empty = document.createElement("div");
    empty.className = "bookmark-empty";
    empty.textContent = t("bookmark.empty");
    items.append(empty);
  }

  editor.append(titleRow, toolbar, addRow, items);
  return editor;
}

function extractBookmarkData(row) {
  const data = normalizeBookmarkData(row?.bookmarkData);
  const titleInput = row?.querySelector(".bookmark-title-input");
  return normalizeBookmarkData({
    ...data,
    title: titleInput ? titleInput.value : data.title
  });
}

function createBookmarkRequestContext(row) {
  const pageId = state.selectedPage?.id;
  const blockId = row?.dataset.blockId;
  if (!pageId || !blockId || row.dataset.blockType !== "BOOKMARK") return null;
  return { pageId, blockId };
}

function findCurrentBookmarkRow(context) {
  if (!context || state.workspaceView !== "page" || state.selectedPage?.id !== context.pageId) return null;
  const currentRow = findRenderedBlockRow(context.blockId);
  if (!currentRow || currentRow.dataset.blockType !== "BOOKMARK" || currentRow.dataset.deleting === "true") {
    return null;
  }
  return currentRow;
}

function resolveCurrentBookmarkRow(context) {
  return canEditSelectedPage() ? findCurrentBookmarkRow(context) : null;
}

function replaceBookmarkEditor(row, value, { focusInput = false } = {}) {
  const host = row?.querySelector(".block-editor-host");
  if (!host) return;
  host.replaceChildren(createBookmarkEditor(row, value));
  if (focusInput) requestAnimationFrame(() => row.querySelector(".bookmark-url-input")?.focus());
}

async function addBookmarkToRow(row) {
  const context = createBookmarkRequestContext(row);
  if (!context) return;
  const input = row.querySelector(".bookmark-url-input");
  const addButton = row.querySelector('[data-action="bookmark-add"]');
  const url = normalizeBookmarkInputUrl(input?.value ?? "");
  if (!url) throw new Error(t("errors.BOOKMARK_URL_INVALID"));
  if (!promoteBlockDraftConflict(row)) return;

  row.classList.add("is-bookmark-loading");
  if (addButton) addButton.disabled = true;
  setStatus(t("status.bookmarkFetching"));
  try {
    const response = await api("/api/bookmarks/preview", { method: "POST", body: { url } });
    // The row may have been rerendered or edited while OpenGraph lookup was in flight.
    // Merge into the live block instead of replaying a stale pre-request snapshot.
    const currentRow = resolveCurrentBookmarkRow(context);
    if (!currentRow) return;
    const data = extractBookmarkData(currentRow);
    const preview = response.preview;
    const existingIndex = data.items.findIndex((item) => item.url === preview.url || item.url === url);
    const item = {
      id: existingIndex >= 0 ? data.items[existingIndex].id : createClientId("bookmark"),
      ...preview
    };
    if (existingIndex >= 0) data.items.splice(existingIndex, 1, item);
    else data.items.push(item);
    replaceBookmarkEditor(currentRow, data, { focusInput: true });
    await saveBlockRow(currentRow, { quiet: true });
    setStatus(t(response.warning ? "status.bookmarkAddedFallback" : "status.bookmarkAdded", { title: item.title }));
  } finally {
    row.classList.remove("is-bookmark-loading");
    const currentRow = findCurrentBookmarkRow(context);
    currentRow?.classList.remove("is-bookmark-loading");
    if (addButton?.isConnected) addButton.disabled = false;
  }
}

async function setBookmarkListColumns(row, value) {
  const data = extractBookmarkData(row);
  const nextColumns = normalizeBookmarkListColumns(Number(value));
  if (data.listColumns === nextColumns) return;
  if (!promoteBlockDraftConflict(row)) return;

  data.listColumns = nextColumns;
  replaceBookmarkEditor(row, data);
  await saveBlockRow(row, { quiet: true });
  setStatus(t("status.bookmarkColumnsChanged", { count: formatNumber(nextColumns) }));
}

async function handleBookmarkAction(row, button) {
  const action = button.dataset.action;
  const data = extractBookmarkData(row);

  if (action === "bookmark-set-view") {
    if (!promoteBlockDraftConflict(row)) return;
    data.view = button.dataset.bookmarkView === "list" ? "list" : "gallery";
    replaceBookmarkEditor(row, data);
    await saveBlockRow(row, { quiet: true });
    setStatus(t("status.bookmarkViewChanged"));
    return;
  }

  if (action === "bookmark-add") {
    await addBookmarkToRow(row);
    return;
  }

  const itemIndex = data.items.findIndex((item) => item.id === button.dataset.bookmarkId);
  if (itemIndex < 0) return;
  if (!promoteBlockDraftConflict(row)) return;

  if (action === "bookmark-remove") {
    const [removed] = data.items.splice(itemIndex, 1);
    replaceBookmarkEditor(row, data);
    await saveBlockRow(row, { quiet: true });
    setStatus(t("status.bookmarkRemoved", { title: removed.title }));
    return;
  }

  if (action === "bookmark-refresh") {
    const context = createBookmarkRequestContext(row);
    if (!context) return;
    const current = { ...data.items[itemIndex] };
    row.classList.add("is-bookmark-loading");
    button.disabled = true;
    setStatus(t("status.bookmarkRefreshing", { title: current.title }));
    try {
      const response = await api("/api/bookmarks/preview", { method: "POST", body: { url: current.url } });
      const currentRow = resolveCurrentBookmarkRow(context);
      if (!currentRow) return;
      const latestData = extractBookmarkData(currentRow);
      const latestIndex = latestData.items.findIndex((item) => item.id === current.id);
      // A removed or independently refreshed item must never be resurrected by this older response.
      if (latestIndex < 0 || !jsonValuesMatch(latestData.items[latestIndex], current)) {
        setStatus(t("errors.BLOCK_EDIT_CONFLICT"), true);
        return;
      }
      const refreshedItem = { id: current.id, ...response.preview };
      latestData.items[latestIndex] = refreshedItem;
      replaceBookmarkEditor(currentRow, latestData);
      await saveBlockRow(currentRow, { quiet: true });
      setStatus(t(response.warning ? "status.bookmarkRefreshedFallback" : "status.bookmarkRefreshed", {
        title: refreshedItem.title
      }));
    } finally {
      row.classList.remove("is-bookmark-loading");
      const currentRow = findCurrentBookmarkRow(context);
      currentRow?.classList.remove("is-bookmark-loading");
      if (button.isConnected) button.disabled = false;
    }
  }
}

function mountBlockEditor(row, block) {
  const host = row.querySelector(".block-editor-host");
  if (!host) return;
  host.replaceChildren(
    block.type === "TABLE"
      ? createTableEditor(row, getBlockTableData(block))
      : block.type === "KANBAN"
        ? createKanbanEditor(row, getBlockKanbanData(block))
        : block.type === "DATABASE"
          ? createDatabaseEditor(row, getBlockDatabaseData(block), { onDirty: () => scheduleBlockSave(row) })
          : block.type === "ACCORDION"
            ? createAccordionEditor(row, getBlockAccordionData(block), {
                onDirty: () => scheduleBlockSave(row),
                renderIcon: renderIconValue,
                onPickIcon: ({ itemId, trigger }) => openAccordionItemIconPicker(row, itemId, trigger),
                previewHtml: block.htmlCache ?? ""
              })
          : block.type === "TIMETABLE"
            ? createTimetableEditor(row, getBlockTimetableData(block), { onDirty: () => scheduleBlockSave(row) })
            : block.type === "GANTT"
              ? createGanttEditor(row, getBlockGanttData(block), { onDirty: () => scheduleBlockSave(row) })
              : block.type === "BOOKMARK"
                ? createBookmarkEditor(row, getBlockBookmarkData(block))
                : block.type === "AI_CHAT"
                  ? createAiChatEditor(row, getBlockAiChatData(block), {
                      onDirty: () => scheduleBlockSave(row),
                      htmlCache: block.htmlCache ?? ""
                    })
                  : block.type === "VIDEO"
                    ? createYouTubeVideoEditor(block)
                    : block.type === "TOGGLE"
                      ? createToggleBlockEditor(row, block)
                      : block.type === "ATTACHMENT"
                        ? createAttachmentEditor(block)
                        : createTextBlockEditor(block)
  );
}

function getBlockRenderDraft(pageId, blockId) {
  const conflictOrigin = blockDraftConflictOrigins.get(blockId);
  const hasUnresolvedConflict = Boolean(conflictOrigin && conflictOrigin.resolved !== true);
  const sourceId = blockDraftRenderSources.get(blockId) ?? (conflictOrigin ? pageDraftSourceId : null);
  if (!state.user?.id || !sourceId) return null;

  const storedDraft = pageDraftStore.loadPage(state.user.id, pageId, sourceId)?.blocks?.[blockId];
  const draft = storedDraft ?? conflictOrigin;
  if (!draft) return null;
  return { ...draft, sourceId, conflict: hasUnresolvedConflict };
}

function renderBlock(block, renderedDraft = null) {
  const draftPayload = normalizeRecoveredBlockPayload(renderedDraft?.payload, block);
  const renderedBlock = draftPayload ? { ...block, ...draftPayload, htmlCache: null } : block;
  const row = document.createElement("article");
  row.className = "editor-block-row";
  row.dataset.blockId = block.id;
  row.dataset.blockType = renderedBlock.type;
  if (renderedDraft) {
    row.dataset.editRevision = String(renderedDraft.revision);
    row.dataset.draftExpectedVersion = String(renderedDraft.expectedVersion);
    row.dataset.draftSourceId = renderedDraft.sourceId;
    row.classList.add("is-dirty");
    if (renderedDraft.conflict) {
      row.dataset.draftConflict = "true";
      row.classList.add("save-error");
    }
  }
  row.dataset.calloutType = getBlockCalloutType(renderedBlock);
  row.dataset.toggleOpen = String(getBlockToggleOpen(renderedBlock));
  row.dataset.textAlign = getBlockTextAlign(renderedBlock);
  row.dataset.codeLanguage = getBlockCodeLanguage(renderedBlock);
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
  typeButton.textContent = getBlockTypeLabel(renderedBlock.type);
  typeButton.disabled = renderedBlock.type === "ATTACHMENT";
  if (typeButton.disabled) typeButton.title = t("attachment.typeLocked");

  const meta = document.createElement("span");
  meta.className = "block-row-meta";
  meta.textContent = t("block.meta", { date: formatDate(block.updatedAt) });
  meta.dataset.savingLabel = t("block.saving");
  meta.dataset.savedLabel = t("block.saved");
  topLine.append(typeButton, meta);

  const todoLabel = document.createElement("label");
  todoLabel.className = "inline-todo";
  todoLabel.classList.toggle("hidden", renderedBlock.type !== "TODO");
  const checked = document.createElement("input");
  checked.type = "checkbox";
  checked.name = "checked";
  checked.checked = Boolean(renderedBlock.checked);
  todoLabel.append(checked, document.createTextNode(t("block.completed")));

  const editorHost = document.createElement("div");
  editorHost.className = "block-editor-host";
  body.append(topLine, todoLabel, editorHost);
  row.append(handle, body);
  mountBlockEditor(row, renderedBlock);
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
    markdown: type === "TOGGLE"
      ? getToggleMarkdownFromRow(row, block?.markdown ?? "")
      : textarea?.value ?? "",
    checked: checked ? checked.checked : false
  };
  const metadata = getBlockMetadata(block);
  if (type === "TOGGLE") metadata.toggleOpen = row.dataset.toggleOpen !== "false";
  else if (metadata.toggleOpen !== undefined) delete metadata.toggleOpen;
  if (isTextAlignableBlockType(type)) {
    const textAlign = normalizeTextAlign(row.dataset.textAlign);
    if (textAlign === "left") delete metadata.textAlign;
    else metadata.textAlign = textAlign;
  }
  if (type === "CALLOUT") metadata.calloutType = normalizeCalloutType(row.dataset.calloutType);
  if (type === "CODE") {
    const languageSelect = row.querySelector(".code-language-select");
    const codeLanguage = normalizeCodeLanguage(languageSelect?.value ?? row.dataset.codeLanguage);
    row.dataset.codeLanguage = codeLanguage;
    metadata.codeLanguage = codeLanguage;
  } else if (metadata.codeLanguage) {
    delete metadata.codeLanguage;
  }

  if (type === "TABLE") {
    const table = extractTableData(row);
    metadata.table = table;
    delete metadata.kanban;
    delete metadata.database;
    delete metadata.timetable;
    delete metadata.gantt;
    delete metadata.bookmark;
    delete metadata.aiChat;
    delete metadata.accordion;
    payload.markdown = table.rows.map((cells) => cells.join("\t")).join("\n").slice(0, 20_000);
    payload.metadata = metadata;
  } else if (type === "KANBAN") {
    const kanban = extractKanbanData(row);
    metadata.kanban = kanban;
    delete metadata.table;
    delete metadata.database;
    delete metadata.timetable;
    delete metadata.gantt;
    delete metadata.bookmark;
    delete metadata.aiChat;
    delete metadata.accordion;
    payload.markdown = summarizeKanbanData(kanban);
    payload.metadata = metadata;
  } else if (type === "DATABASE") {
    const database = extractDatabaseData(row);
    metadata.database = database;
    delete metadata.table;
    delete metadata.kanban;
    delete metadata.timetable;
    delete metadata.gantt;
    delete metadata.bookmark;
    delete metadata.aiChat;
    delete metadata.accordion;
    payload.markdown = summarizeDatabaseData(database);
    payload.metadata = metadata;
  } else if (type === "ACCORDION") {
    const accordion = extractAccordionData(row);
    metadata.accordion = accordion;
    delete metadata.table;
    delete metadata.kanban;
    delete metadata.database;
    delete metadata.timetable;
    delete metadata.gantt;
    delete metadata.bookmark;
    delete metadata.aiChat;
    payload.markdown = summarizeAccordionData(accordion);
    payload.metadata = metadata;
  } else if (type === "TIMETABLE") {
    const timetable = extractTimetableData(row);
    metadata.timetable = timetable;
    delete metadata.table;
    delete metadata.kanban;
    delete metadata.database;
    delete metadata.gantt;
    delete metadata.bookmark;
    delete metadata.aiChat;
    delete metadata.accordion;
    payload.markdown = summarizeTimetableData(timetable);
    payload.metadata = metadata;
  } else if (type === "GANTT") {
    const gantt = extractGanttData(row);
    metadata.gantt = gantt;
    delete metadata.table;
    delete metadata.kanban;
    delete metadata.database;
    delete metadata.timetable;
    delete metadata.bookmark;
    delete metadata.aiChat;
    delete metadata.accordion;
    payload.markdown = summarizeGanttData(gantt);
    payload.metadata = metadata;
  } else if (type === "BOOKMARK") {
    const bookmark = extractBookmarkData(row);
    metadata.bookmark = bookmark;
    delete metadata.table;
    delete metadata.kanban;
    delete metadata.database;
    delete metadata.timetable;
    delete metadata.gantt;
    delete metadata.aiChat;
    delete metadata.accordion;
    payload.markdown = summarizeBookmarkData(bookmark);
    payload.metadata = metadata;
  } else if (type === "AI_CHAT") {
    const aiChat = extractAiChatData(row);
    metadata.aiChat = aiChat;
    delete metadata.table;
    delete metadata.kanban;
    delete metadata.database;
    delete metadata.timetable;
    delete metadata.gantt;
    delete metadata.bookmark;
    delete metadata.accordion;
    payload.markdown = summarizeAiChatData(aiChat);
    payload.metadata = metadata;
  } else {
    if (metadata.table) delete metadata.table;
    if (metadata.kanban) delete metadata.kanban;
    if (metadata.database) delete metadata.database;
    if (metadata.timetable) delete metadata.timetable;
    if (metadata.gantt) delete metadata.gantt;
    if (metadata.bookmark) delete metadata.bookmark;
    if (metadata.aiChat) delete metadata.aiChat;
    if (metadata.accordion) delete metadata.accordion;
    payload.metadata = Object.keys(metadata).length ? metadata : null;
  }

  return payload;
}

function normalizeParentBlockId(value) {
  return value || null;
}

function getPageBlockSiblings(page, parentBlockId) {
  if (!page) return [];
  if (!parentBlockId) return page.blocks ?? [];
  return getBlockById(parentBlockId, page.blocks ?? [])?.children ?? [];
}

function getBlockSiblings(parentBlockId) {
  return getPageBlockSiblings(state.selectedPage, parentBlockId);
}

function syncVisibleBlocksToState({ dirtyOnly = false } = {}) {
  for (const row of elements.blockList.querySelectorAll(".editor-block-row")) {
    if (dirtyOnly && !row.classList.contains("is-dirty")) continue;
    const block = getBlockById(row.dataset.blockId);
    if (!block) continue;
    Object.assign(block, buildBlockPayload(row));
  }
}

function reorderPageBlockSiblings(page, parentBlockId, orderedIds) {
  const siblings = getPageBlockSiblings(page, parentBlockId);
  if (orderedIds.length !== siblings.length || new Set(orderedIds).size !== orderedIds.length) return false;
  const byId = new Map(siblings.map((block) => [block.id, block]));
  const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  if (reordered.length !== siblings.length) return false;

  reordered.forEach((block, index) => {
    block.sortOrder = index;
  });
  siblings.splice(0, siblings.length, ...reordered);
  return true;
}

function reorderBlockSiblingsInState(parentBlockId, orderedIds) {
  return reorderPageBlockSiblings(state.selectedPage, parentBlockId, orderedIds);
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
  return [...elements.blockContextMenu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')].filter(
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

function syncAccordionOptionsMenu(row) {
  const isAccordion = row?.dataset.blockType === "ACCORDION";
  elements.accordionOptionsGroup?.classList.toggle("hidden", !isAccordion);
  if (!isAccordion) return;
  const showOrder = extractAccordionData(row).showOrder;
  const button = elements.accordionOptionsGroup.querySelector('[data-action="toggle-accordion-order"]');
  button?.setAttribute("aria-checked", String(showOrder));
  button?.classList.toggle("is-selected", showOrder);
}

async function changeAccordionOrderVisibility(row) {
  if (!requireWritablePage() || !row?.dataset.blockId || row.dataset.blockType !== "ACCORDION") return;
  if (!promoteBlockDraftConflict(row)) return;
  const current = extractAccordionData(row).showOrder;
  if (!setAccordionShowOrder(row, !current)) return;
  if (!markBlockDirty(row)) return;
  syncAccordionOptionsMenu(row);
  try {
    await saveBlockRow(row, { quiet: true });
    closeBlockContextMenu({ restoreFocus: true });
    setStatus(t(!current ? "accordion.orderEnabled" : "accordion.orderDisabled"));
  } catch (error) {
    syncAccordionOptionsMenu(row);
    setStatus(error.message, true);
  }
}

function setRowCalloutType(row, type) {
  if (!row) return;
  row.dataset.calloutType = normalizeCalloutType(type);
}

async function changeCalloutType(row, type) {
  if (!requireWritablePage() || !row?.dataset.blockId || row.dataset.blockType !== "CALLOUT") return;

  const previousType = normalizeCalloutType(row.dataset.calloutType);
  const nextType = normalizeCalloutType(type);
  if (previousType === nextType) {
    closeBlockContextMenu({ restoreFocus: true });
    return;
  }
  if (!promoteBlockDraftConflict(row)) return;

  setRowCalloutType(row, nextType);
  syncCalloutTypeMenu(row);
  if (!markBlockDirty(row)) return;

  try {
    await saveBlockRow(row, { quiet: true });
    closeBlockContextMenu({ restoreFocus: true });
    setStatus(t("status.calloutChanged", { type: getCalloutTypeLabel(nextType) }));
  } catch (error) {
    // Keep the optimistic value: the durable draft and retry queue already contain it.
    // Rolling the row back here would let a later save overwrite the intended change.
    syncCalloutTypeMenu(row);
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
  if (!requireWritablePage()) return;
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
  syncAccordionOptionsMenu(row);
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
  if (!requireWritablePage({ announce: false })) return;
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

  return withPageEditLock(async () => {
    const previousIds = getBlockSiblings(drag.parentBlockId).map((block) => block.id);
    const orderedIds = drag.candidates.map((row) => row.dataset.blockId);
    orderedIds.splice(drag.targetIndex, 0, drag.row.dataset.blockId);
    if (isCollaborativePage()) {
      if (!reorderBlockSiblingsInState(drag.parentBlockId, orderedIds)) {
        throw new Error(t("errors.currentBlockOrder"));
      }
      try {
        await persistBlockOrder(drag.parentBlockId, orderedIds, {}, { allowLocked: true });
      } catch (error) {
        reorderBlockSiblingsInState(drag.parentBlockId, previousIds);
        renderSelectedPage();
        throw error;
      }
      renderSelectedPage();
      setStatus(t("status.blockOrderChanged"));
      return;
    }
    const task = createBlockOrderTask(drag.parentBlockId, orderedIds, {}, { previousIds });
    persistBlockOrderDraft(task);

    if (!reorderBlockSiblingsInState(drag.parentBlockId, orderedIds)) {
      acknowledgeBlockOrderDraft(task);
      throw new Error(t("errors.currentBlockOrder"));
    }

    pendingBlockOrderTask = task;
    blockOrderSaving = true;
    renderSelectedPage();
    syncPageModeUi();
    syncBeforeUnloadProtection();
    setStatus(t("status.savingBlockOrder"));

    try {
      await submitBlockOrderTaskWithReplay(task);
      acknowledgeBlockOrderDraft(task);
      pendingBlockOrderTask = null;
      setStatus(t("status.blockOrderChanged"));
    } catch (error) {
      if (isDefinitiveApiError(error)) {
        pendingBlockOrderTask = null;
        reorderBlockSiblingsInState(drag.parentBlockId, previousIds);
        renderSelectedPage();
      }
      setStatus(error.message, true);
    } finally {
      blockOrderSaving = Boolean(pendingBlockOrderTask);
      syncPageModeUi();
      syncBeforeUnloadProtection();
    }
  });
}

function setRowType(row, type, { markdown } = {}) {
  const existing = getBlockById(row.dataset.blockId) ?? {};
  const previousType = row.dataset.blockType ?? existing.type ?? "MARKDOWN";
  const previousTextarea = getBlockTextarea(row);
  const previousMarkdown = previousType === "TOGGLE"
    ? getToggleMarkdownFromRow(row, existing.markdown ?? "")
    : previousTextarea?.value ?? existing.markdown ?? "";
  const metadata = getBlockMetadata(existing);

  if (previousType === "TABLE") metadata.table = extractTableData(row);
  if (previousType === "KANBAN") metadata.kanban = extractKanbanData(row);
  if (previousType === "DATABASE") metadata.database = extractDatabaseData(row);
  if (previousType === "ACCORDION") metadata.accordion = extractAccordionData(row);
  if (previousType === "TIMETABLE") metadata.timetable = extractTimetableData(row);
  if (previousType === "GANTT") metadata.gantt = extractGanttData(row);
  if (previousType === "BOOKMARK") metadata.bookmark = extractBookmarkData(row);
  if (previousType === "AI_CHAT") metadata.aiChat = extractAiChatData(row);
  if (previousType === "CODE") {
    metadata.codeLanguage = normalizeCodeLanguage(
      row.querySelector(".code-language-select")?.value ?? row.dataset.codeLanguage ?? metadata.codeLanguage
    );
  }
  if (type === "TABLE" && !metadata.table) metadata.table = createDefaultTableData();
  if (type === "KANBAN" && !metadata.kanban) metadata.kanban = createDefaultKanbanData();
  if (type === "DATABASE" && !metadata.database) metadata.database = createDefaultDatabaseData();
  if (type === "ACCORDION" && !metadata.accordion) metadata.accordion = createDefaultAccordionData();
  if (type === "TIMETABLE" && !metadata.timetable) metadata.timetable = createDefaultTimetableData();
  if (type === "GANTT" && !metadata.gantt) metadata.gantt = createDefaultGanttData();
  if (type === "BOOKMARK" && !metadata.bookmark) metadata.bookmark = createDefaultBookmarkData();
  if (type === "AI_CHAT" && !metadata.aiChat) {
    metadata.aiChat = createDefaultAiChatData({
      question: markdown ?? previousMarkdown
    });
  }
  if (type === "TOGGLE" && metadata.toggleOpen === undefined) metadata.toggleOpen = true;

  row.dataset.blockType = type;
  row.dataset.toggleOpen = String(type === "TOGGLE" ? metadata.toggleOpen !== false : true);
  row.dataset.codeLanguage = type === "CODE"
    ? normalizeCodeLanguage(metadata.codeLanguage)
    : "plaintext";
  if (type === "CODE") metadata.codeLanguage = row.dataset.codeLanguage;
  if (type === "CALLOUT") setRowCalloutType(row, row.dataset.calloutType);
  const typeButton = row.querySelector(".block-type-pill");
  if (typeButton) typeButton.textContent = getBlockTypeLabel(type);

  const todoLabel = row.querySelector(".inline-todo");
  todoLabel?.classList.toggle("hidden", type !== "TODO");

  mountBlockEditor(row, {
    ...existing,
    type,
    markdown: type === "TABLE" || type === "KANBAN" || type === "DATABASE" || type === "ACCORDION" || type === "TIMETABLE" || type === "GANTT" || type === "BOOKMARK" || type === "AI_CHAT" ? "" : markdown ?? previousMarkdown,
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
  if (!promoteBlockDraftConflict(row)) return;
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

function getRejectedLocalMutationMessage(error) {
  if (error?.code === "COLLABORATION_RECOVERY_WRITE_FAILED") return t("status.localDraftStorageFailed");
  return error?.message || t("status.localDraftStorageFailed");
}

function cancelScheduledBlockSave(blockId) {
  if (!blockId) return;
  window.clearTimeout(blockSaveTimers.get(blockId));
  blockSaveTimers.delete(blockId);
  blockSaveRows.delete(blockId);
}

function restoreBlockRowFromDurableState(row) {
  const blockId = row?.dataset.blockId;
  cancelScheduledBlockSave(blockId);
  const block = blockId ? getBlockById(blockId) : null;
  if (!block || !row?.isConnected || state.workspaceView !== "page") {
    renderSelectedPage();
    return null;
  }
  const focus = captureCollaborationEditorFocus();
  const renderedDraft = isCollaborativePage()
    ? null
    : getBlockRenderDraft(state.selectedPage.id, blockId);
  const replacement = renderBlock(block, renderedDraft);
  row.replaceWith(replacement);
  syncBlockReadOnlyState(replacement);
  requestAnimationFrame(() => {
    restoreCollaborationEditorFocus(focus);
    hydrateMathExpressions(replacement);
    if (isCollaborativePage()) renderCollaborationPresence();
  });
  return replacement;
}

function rejectLocalBlockMutation(row, error) {
  console.error("Rejected non-durable block mutation", error);
  restoreBlockRowFromDurableState(row);
  setStatus(getRejectedLocalMutationMessage(error), true);
  syncBeforeUnloadProtection();
}

function markBlockDirty(row, { allowConflictPrompt = true } = {}) {
  if (!row?.dataset.blockId) return false;
  if (isCollaborativePage()) {
    const session = state.collaborationSession;
    if (!session?.isReady) return false;
    const current = getBlockById(row.dataset.blockId);
    if (!current) return false;
    try {
      session.upsertBlock({
        ...current,
        ...buildBlockPayload(row),
        parentBlockId: normalizeParentBlockId(row.dataset.parentBlockId),
        sortOrder: Number(current.sortOrder ?? 0)
      });
    } catch (error) {
      rejectLocalBlockMutation(row, error);
      return false;
    }
    row.classList.remove("is-dirty", "is-saving", "save-error");
    row.classList.add("is-saved");
    window.setTimeout(() => row.classList.remove("is-saved"), 450);
    updateCollaborationAwareness(document.activeElement);
    syncBeforeUnloadProtection();
    return true;
  }
  const editRevision = (Number.parseInt(row.dataset.editRevision ?? "0", 10) || 0) + 1;
  row.dataset.editRevision = String(editRevision);
  row.classList.add("is-dirty");
  row.classList.remove("is-saved");
  if (!persistBlockDraft(row)) {
    restoreBlockRowFromDurableState(row);
    syncBeforeUnloadProtection();
    return false;
  }

  if (row.dataset.draftConflict === "true") {
    row.classList.add("save-error");
    if (!allowConflictPrompt || !promoteBlockDraftConflict(row)) {
      syncBeforeUnloadProtection();
      return false;
    }
  }

  row.classList.remove("save-error");
  syncBeforeUnloadProtection();
  return true;
}

function getBlockSaveQueue(blockId) {
  let queue = blockSaveQueues.get(blockId);
  if (queue) return queue;

  queue = createLatestWriteQueue(async (task) => {
    const storedExpectedVersion = task.userId
      ? pageDraftStore.loadPage(task.userId, task.pageId, task.draftSourceId)?.blocks?.[blockId]?.expectedVersion
      : null;
    const currentVersion = getLatestKnownVersion(
      storedExpectedVersion,
      task.row?.dataset.draftExpectedVersion,
      task.expectedVersion,
      getBlockById(blockId)?.version
    );
    const data = await submitWithFreshMutationIdOnReuse(task, () =>
      api(`/api/blocks/${blockId}`, {
        method: "PATCH",
        keepalive: task.keepalive === true,
        body: { ...task.payload, expectedVersion: currentVersion, mutationId: task.mutationId }
      })
    );
    if (task.userId) {
      checkDraftStoreWrite(
        pageDraftStore.acknowledgeBlock({
          userId: task.userId,
          pageId: task.pageId,
          sourceId: task.draftSourceId,
          blockId,
          revision: task.editRevision,
          nextExpectedVersion: data.block.version
        })
      );
      if (task.recoveredConflictOrigin) {
        const removed = checkDraftStoreWrite(
          pageDraftStore.removeBlockIfUnchanged({
            userId: task.userId,
            pageId: task.pageId,
            blockId,
            ...task.recoveredConflictOrigin
          })
        );
        if (removed && blockDraftConflictOrigins.get(blockId) === task.recoveredConflictOrigin) {
          blockDraftConflictOrigins.delete(blockId);
        }
      }
    }
    applyPageContentVersion(task.pageId, data.pageContentVersion);

    // A locale change or drag reorder can rebuild the editor while this request is in flight.
    // Always rebase the currently rendered row, not the detached row that started the request.
    const currentRow = findRenderedBlockRow(blockId) ?? task.row;
    const latestTaskId = blockSaveTaskIds.get(blockId);
    const currentEditRevision = Number.parseInt(currentRow?.dataset.editRevision ?? "0", 10) || 0;
    const latestStoredDraft = task.userId
      ? pageDraftStore.loadPage(task.userId, task.pageId, task.draftSourceId)?.blocks?.[blockId]
      : null;
    const hasNewerLocalContent =
      Number(latestStoredDraft?.revision ?? 0) > task.editRevision ||
      currentEditRevision > task.editRevision ||
      Number(latestTaskId) > task.taskId;
    const latestStoredPayload = Number(latestStoredDraft?.revision ?? 0) > task.editRevision
      ? latestStoredDraft.payload
      : null;
    const currentRowPayload = hasNewerLocalContent && currentRow?.dataset.blockId === blockId
      ? buildBlockPayload(currentRow)
      : null;
    const latestLocalPayload = normalizeRecoveredBlockPayload(
      latestStoredPayload ?? currentRowPayload,
      data.block
    );
    const committedBlock = rebaseCommittedBlockContent(data.block, latestLocalPayload);
    updateBlockInState(committedBlock);
    if (currentRow?.dataset.blockId === blockId) updateRenderedBlockPreview(currentRow, committedBlock);

    if (currentRow && latestTaskId === task.taskId && currentEditRevision === task.editRevision) {
      currentRow.classList.remove("is-dirty", "save-error");
      currentRow.classList.add("is-saved");
      delete currentRow.dataset.draftExpectedVersion;
      delete currentRow.dataset.draftSourceId;
      if (!latestStoredDraft) blockDraftRenderSources.delete(blockId);
      window.setTimeout(() => currentRow.classList.remove("is-saved"), 900);
    } else if (currentRow?.dataset.blockId === blockId && hasNewerLocalContent) {
      currentRow.dataset.draftExpectedVersion = String(data.block.version);
      if (latestStoredDraft) blockDraftRenderSources.set(blockId, task.draftSourceId);
    }
    return { ...data, block: committedBlock };
  }, {
    shouldRetry: isAmbiguousApiError,
    canSupersede: canSupersedeBlockSaveError
  });
  blockSaveQueues.set(blockId, queue);
  return queue;
}

async function saveBlockRow(
  row,
  { quiet = false, keepalive = false, allowLocked = false, resolveConflict = false } = {}
) {
  const writable = allowLocked ? canPersistSelectedPage() : requireWritablePage({ announce: !quiet });
  if (!writable || !row?.dataset.blockId || row.dataset.deleting === "true") return null;

  const blockId = row.dataset.blockId;
  const payload = buildBlockPayload(row);
  if (isCollaborativePage()) {
    const session = state.collaborationSession;
    if (!session?.isReady) throw new Error(t("sharing.syncRequired"));
    const current = getBlockById(blockId);
    if (!current) return null;
    let block;
    try {
      block = session.upsertBlock({
        ...current,
        ...payload,
        parentBlockId: normalizeParentBlockId(row.dataset.parentBlockId),
        sortOrder: Number(current.sortOrder ?? 0)
      });
    } catch (error) {
      rejectLocalBlockMutation(row, error);
      throw error;
    }
    row.classList.remove("is-dirty", "is-saving", "save-error");
    row.classList.add("is-saved");
    updateRenderedBlockPreview(row, { ...current, ...block });
    if (!quiet) setStatus(t("status.blockSaved"));
    window.setTimeout(() => row.classList.remove("is-saved"), 450);
    syncBeforeUnloadProtection();
    return { block: { ...current, ...block } };
  }
  const scope = getDraftScope();
  if (row.dataset.draftConflict === "true" && (!resolveConflict || !promoteBlockDraftConflict(row))) {
    const conflictSourceId = row.dataset.draftSourceId || pageDraftSourceId;
    const conflictDraft = scope
      ? pageDraftStore.loadPage(scope.userId, scope.pageId, conflictSourceId)?.blocks?.[blockId]
      : null;
    let conflictRevision = Math.max(
      Number.parseInt(row.dataset.editRevision ?? "0", 10) || 0,
      Number.parseInt(String(conflictDraft?.revision ?? 0), 10) || 0
    );
    if (!conflictDraft || !jsonValuesMatch(conflictDraft.payload, payload)) conflictRevision += 1;
    row.dataset.editRevision = String(Math.max(1, conflictRevision));
    row.classList.add("is-dirty", "save-error");
    if (!persistBlockDraft(row, payload)) {
      restoreBlockRowFromDurableState(row);
      syncBeforeUnloadProtection();
      throw new Error(t("status.localDraftStorageFailed"));
    }
    syncBeforeUnloadProtection();
    return null;
  }

  const draftSourceId = row.dataset.draftSourceId || pageDraftSourceId;
  const storedDraft = scope
    ? pageDraftStore.loadPage(scope.userId, scope.pageId, draftSourceId)?.blocks?.[blockId]
    : null;
  let editRevision = Math.max(
    Number.parseInt(row.dataset.editRevision ?? "0", 10) || 0,
    Number.parseInt(String(storedDraft?.revision ?? 0), 10) || 0
  );
  if (!storedDraft || !jsonValuesMatch(storedDraft.payload, payload)) editRevision += 1;
  editRevision = Math.max(1, editRevision);
  row.dataset.editRevision = String(editRevision);
  row.classList.add("is-dirty");
  if (!persistBlockDraft(row, payload)) {
    restoreBlockRowFromDurableState(row);
    syncBeforeUnloadProtection();
    throw new Error(t("status.localDraftStorageFailed"));
  }
  window.clearTimeout(blockSaveTimers.get(blockId));
  blockSaveTimers.delete(blockId);
  blockSaveRows.delete(blockId);

  const taskId = (blockSaveTaskIds.get(blockId) ?? 0) + 1;
  blockSaveTaskIds.set(blockId, taskId);
  const task = {
    taskId,
    userId: state.user?.id,
    draftSourceId,
    pageId: state.selectedPage.id,
    editRevision,
    expectedVersion: getLatestKnownVersion(
      row.dataset.draftExpectedVersion,
      storedDraft?.expectedVersion,
      getBlockById(blockId)?.version
    ),
    recoveredConflictOrigin: blockDraftConflictOrigins.get(blockId) ?? null,
    payload,
    row,
    keepalive,
    mutationId: createMutationId()
  };
  const queue = getBlockSaveQueue(blockId);
  row.classList.add("is-saving");
  row.classList.remove("save-error");
  syncBeforeUnloadProtection();

  try {
    const data = await queue.enqueue(task);
    if (!queue.busy) row.classList.remove("is-saving");
    if (!quiet) setStatus(t("status.blockSaved"));
    return data;
  } catch (error) {
    const currentRow = findRenderedBlockRow(blockId) ?? row;
    currentRow.classList.remove("is-saving");
    currentRow.classList.add("is-dirty", "save-error");
    throw error;
  } finally {
    syncBeforeUnloadProtection();
  }
}

function scheduleBlockSave(row, { allowConflictPrompt = true } = {}) {
  if (!requireWritablePage({ announce: false }) || !row?.dataset.blockId) return false;
  if (isCollaborativePage()) {
    return markBlockDirty(row, { allowConflictPrompt });
  }
  const blockId = row.dataset.blockId;
  if (!markBlockDirty(row, { allowConflictPrompt })) {
    cancelScheduledBlockSave(blockId);
    syncBeforeUnloadProtection();
    return false;
  }
  window.clearTimeout(blockSaveTimers.get(blockId));
  blockSaveRows.set(blockId, row);
  blockSaveTimers.set(
    blockId,
    window.setTimeout(() => {
      blockSaveTimers.delete(blockId);
      saveBlockRow(row, { quiet: true }).catch((error) => setStatus(error.message, true));
    }, 700)
  );
  syncBeforeUnloadProtection();
  return true;
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
  elements.inlineToolbar.style.left = "12px";
  elements.inlineToolbar.style.top = "12px";
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

function updateInlineAlignmentButtons(row) {
  const alignment = normalizeTextAlign(row?.dataset.textAlign);
  for (const button of elements.inlineToolbar.querySelectorAll("button[data-align]")) {
    button.setAttribute("aria-pressed", String(button.dataset.align === alignment));
  }
}

function updateInlineToolbarForTextarea(textarea) {
  if (!requireWritablePage({ announce: false })) return closeInlineToolbar();
  const row = getBlockRow(textarea);
  const selection = getTextareaSelection(textarea);
  if (!row || ["MATH", "VIDEO"].includes(row.dataset.blockType) || !selection) return closeInlineToolbar();

  closeSlashMenu();
  state.activeInlineBlockId = row.dataset.blockId;
  state.activeInlineSelection = selection;
  updateInlineAlignmentButtons(row);
  positionInlineToolbar(textarea, selection);
}

function getActiveInlineTextarea() {
  if (!state.activeInlineBlockId) return null;
  const row = elements.blockList.querySelector(`[data-block-id="${CSS.escape(state.activeInlineBlockId)}"]`);
  return getBlockTextarea(row);
}

function applyInlineFormat(format, value = "") {
  if (!requireWritablePage()) return;
  const textarea = getActiveInlineTextarea() ?? document.activeElement;
  if (!(textarea instanceof HTMLTextAreaElement)) return;

  const row = getBlockRow(textarea);
  const currentSelection = getTextareaSelection(textarea);
  const selection = state.activeInlineSelection ?? currentSelection;
  if (format !== "align" && !selection) return;
  if (row && !promoteBlockDraftConflict(row)) return;

  if (format === "align") {
    if (!row || !isTextAlignableBlockType(row.dataset.blockType)) return;
    const textAlign = normalizeTextAlign(value);
    row.dataset.textAlign = textAlign;
    textarea.style.textAlign = textAlign;
    textarea.focus();
    if (selection) textarea.setSelectionRange(selection.start, selection.end);
    if (!scheduleBlockSave(row)) {
      closeInlineToolbar();
      return;
    }
    closeInlineToolbar();
    setStatus(t("status.formatApplied"));
    return;
  }

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
  } else if (format === "math-inline") {
    replacement = `\\(${selected}\\)`;
    selectStart = selection.start + 2;
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

  if (row && !scheduleBlockSave(row)) {
    closeInlineToolbar();
    return;
  }
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
  if (!requireWritablePage()) return closeSlashMenu();
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

function getAttachmentCreateTask(
  authenticationScope,
  { pageId, sourceBlockId, parentBlockId, sortOrder, file }
) {
  const requestKey = JSON.stringify({
    pageId,
    sourceBlockId,
    parentBlockId,
    sortOrder,
    file: {
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified
    }
  });
  const taskKey = `${authenticationScope.targetKey}\n${requestKey}`;
  const pendingTask = pendingAttachmentCreateTasks.get(taskKey);
  if (pendingTask && !pendingTask.inFlight) {
    // A newly selected File with the same browser fingerprint may still contain
    // different bytes. Send it with the retained mutation id; the server hash
    // will reject a collision and submitWithFreshMutationIdOnReuse will rotate.
    pendingTask.file = file;
    return pendingTask;
  }

  return {
    taskKey,
    targetKey: authenticationScope.targetKey,
    requestKey,
    mutationId: createMutationId(),
    pageId,
    parentBlockId,
    sortOrder,
    file,
    inFlight: false
  };
}

async function submitAttachmentCreateTask(task, authenticationScope) {
  task.inFlight = true;
  let attempt = 0;

  try {
    while (attempt < 2) {
      if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;

      try {
        const data = await submitWithFreshMutationIdOnReuse(task, () => {
          if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
          const formData = new FormData();
          formData.set("file", task.file, task.file.name);
          if (task.parentBlockId) formData.set("parentBlockId", task.parentBlockId);
          formData.set("sortOrder", String(task.sortOrder));
          formData.set("mutationId", task.mutationId);
          return api(`/api/pages/${task.pageId}/attachments`, {
            method: "POST",
            body: formData
          });
        });
        if (data === null || !isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
        if (pendingAttachmentCreateTasks.get(task.taskKey) === task) {
          pendingAttachmentCreateTasks.delete(task.taskKey);
        }
        return data;
      } catch (error) {
        if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
        attempt += 1;
        if (!isAmbiguousApiError(error) || attempt >= 2) {
          if (!isAmbiguousApiError(error) && pendingAttachmentCreateTasks.get(task.taskKey) === task) {
            pendingAttachmentCreateTasks.delete(task.taskKey);
          }
          throw error;
        }
      }
    }

    return null;
  } catch (error) {
    if (isAmbiguousApiError(error) && isCurrentAuthenticatedSessionScope(authenticationScope)) {
      pendingAttachmentCreateTasks.set(task.taskKey, task);
    }
    throw error;
  } finally {
    task.inFlight = false;
  }
}

async function uploadAttachmentFromRow(row, file, slashContext = null) {
  if (!requireWritablePage() || !row?.dataset.blockId || !file) return;
  if (!promoteBlockDraftConflict(row)) return;

  const pageId = state.selectedPage.id;
  const authenticationScope = captureAuthenticatedSessionScope();
  if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return;
  const collaborationSessionAtStart = isCollaborativePage() ? state.collaborationSession : null;
  const blockId = row.dataset.blockId;
  const sourceEditRevision = Number.parseInt(row.dataset.editRevision ?? "0", 10) || 0;
  row.classList.add("is-uploading");
  row.setAttribute("aria-busy", "true");
  syncBlockReadOnlyState(row, true);
  setStatus(t("status.attachmentUploading", { name: file.name }));

  try {
    window.clearTimeout(blockSaveTimers.get(blockId));
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

    const sourceType = row.dataset.blockType ?? block?.type ?? "MARKDOWN";
    const replaceCurrentBlock =
      !isStructuredBlockType(sourceType) && !remainingMarkdown.trim() && !(block?.children?.length);
    if (replaceCurrentBlock && !isCollaborativePage()) {
      assertNoPendingLocalBlockDrafts(pageId, [blockId], { excludeSourceId: pageDraftSourceId });
    }
    let sourceNeedsSave = row.classList.contains("is-dirty");
    if (!replaceCurrentBlock && textarea && textarea.value !== remainingMarkdown) {
      textarea.value = remainingMarkdown;
      autoGrowTextarea(textarea);
      sourceNeedsSave = true;
    }
    if (!replaceCurrentBlock && sourceNeedsSave) await saveBlockRow(row, { quiet: true });
    if (!replaceCurrentBlock && blockSaveQueues.get(blockId)?.busy) {
      await blockSaveQueues.get(blockId).flush();
    }

    const insertionIndex = replaceCurrentBlock ? referenceIndex : referenceIndex + 1;
    const task = getAttachmentCreateTask(authenticationScope, {
      pageId,
      sourceBlockId: blockId,
      parentBlockId,
      sortOrder: insertionIndex,
      file
    });
    const data = await submitAttachmentCreateTask(task, authenticationScope);
    if (!data || !isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
    applyPageContentVersion(pageId, data.pageContentVersion);

    const sourceStillCurrent =
      state.selectedPage?.id === pageId && row.isConnected && row.dataset.blockId === blockId;
    if (!sourceStillCurrent) {
      collaborationSessionAtStart?.adoptAttachment({
        ...data.block,
        parentBlockId,
        sortOrder: referenceIndex + 1
      });
      setStatus(t("status.attachmentUploaded", { name: file.name }));
      return data;
    }

    const currentEditRevision = Number.parseInt(row.dataset.editRevision ?? "0", 10) || 0;
    if (isCollaborativePage()) {
      const session = state.collaborationSession ?? collaborationSessionAtStart;
      if (!session || session.isDestroyed) throw new Error(t("sharing.syncRequired"));
      const shouldReplaceCurrentBlock = replaceCurrentBlock && currentEditRevision === sourceEditRevision;
      const effectiveInsertionIndex = shouldReplaceCurrentBlock ? referenceIndex : referenceIndex + 1;
      const orderedIds = [...siblingIds];
      if (shouldReplaceCurrentBlock) {
        orderedIds.splice(referenceIndex, 1, data.block.id);
        await deleteBlockWithVersionCheck(blockId, { includeDescendants: false });
        row.dataset.deleting = "true";
      } else {
        orderedIds.splice(effectiveInsertionIndex, 0, data.block.id);
      }
      session.upsertBlock({
        ...data.block,
        parentBlockId,
        sortOrder: effectiveInsertionIndex
      }, { allowDisconnected: true });
      const snapshotById = new Map(session.getSnapshot().blocks.map((block) => [block.id, block]));
      const orderUpdates = orderedIds.map((id, sortOrder) => {
        const current = snapshotById.get(id);
        if (!current) throw new Error(t("errors.currentBlockOrder"));
        return { ...current, parentBlockId: parentBlockId ?? null, sortOrder };
      });
      session.upsertBlocks(orderUpdates, { allowDisconnected: true });
      state.pendingFocusBlockId = data.block.id;
      renderSelectedPage();
      setStatus(t("status.attachmentUploaded", { name: file.name }));
      return data;
    }
    const shouldReplaceCurrentBlock = replaceCurrentBlock && currentEditRevision === sourceEditRevision;
    const effectiveInsertionIndex = shouldReplaceCurrentBlock ? referenceIndex : referenceIndex + 1;
    const orderedIds = [...siblingIds];
    if (shouldReplaceCurrentBlock) {
      orderedIds.splice(referenceIndex, 1, data.block.id);
      discardBlockSave(blockId);
      await deleteBlockWithVersionCheck(blockId, { includeDescendants: false });
      row.dataset.deleting = "true";
    } else {
      orderedIds.splice(effectiveInsertionIndex, 0, data.block.id);
    }
    await persistBlockOrder(parentBlockId, orderedIds, { [data.block.id]: data.block.version });

    if (state.selectedPage?.id === pageId) {
      state.pendingFocusBlockId = data.block.id;
      await openPage(pageId);
    }
    setStatus(t("status.attachmentUploaded", { name: file.name }));
    return data;
  } finally {
    row.classList.remove("is-uploading");
    row.removeAttribute("aria-busy");
    if (row.isConnected && row.dataset.deleting !== "true") syncBlockReadOnlyState(row);
  }
}

function requestAttachmentUpload(row, slashContext = null) {
  if (!requireWritablePage()) return;
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

function createInitialBlockMetadata(type) {
  if (type === "TOGGLE") return { toggleOpen: true };
  if (type === "TABLE") return { table: createDefaultTableData() };
  if (type === "KANBAN") return { kanban: createDefaultKanbanData() };
  if (type === "DATABASE") return { database: createDefaultDatabaseData() };
  if (type === "TIMETABLE") return { timetable: createDefaultTimetableData() };
  if (type === "GANTT") return { gantt: createDefaultGanttData() };
  if (type === "BOOKMARK") return { bookmark: createDefaultBookmarkData() };
  if (type === "AI_CHAT") return { aiChat: createDefaultAiChatData() };
  return undefined;
}

async function applySlashCommand(row, type) {
  if (!requireWritablePage()) return;
  const previousType = row.dataset.blockType ?? getBlockById(row.dataset.blockId)?.type ?? "MARKDOWN";
  const previousTextarea = getBlockTextarea(row);
  const context = previousTextarea ? getSlashContext(previousTextarea) : null;
  let markdown = previousType === "TOGGLE"
    ? getToggleMarkdownFromRow(row, getBlockById(row.dataset.blockId)?.markdown ?? "")
    : previousTextarea?.value ?? "";

  if (type === "ATTACHMENT") {
    closeSlashMenu();
    requestAttachmentUpload(row, context);
    return;
  }
  if (!promoteBlockDraftConflict(row)) return;

  if (context) {
    const editedBody = `${previousTextarea.value.slice(0, context.start)}${previousTextarea.value.slice(context.end)}`;
    if (previousType === "TOGGLE") {
      previousTextarea.value = editedBody;
      autoGrowTextarea(previousTextarea);
      markdown = serializeToggleMarkdown(row.querySelector(".toggle-title-input")?.value ?? "", editedBody);
    } else {
      markdown = editedBody;
    }
  }

  if (!context && previousType === type) {
    closeSlashMenu();
    return;
  }

  if (isStructuredBlockType(previousType) && previousType !== type) {
    // Never reinterpret metadata-backed content as another block type in place. Persist the
    // source first, then create the requested type as a sibling so the original stays intact.
    closeSlashMenu();
    await saveBlockRow(row, { quiet: true });
    await insertBlockRelative(row, "after", {
      type,
      metadata: createInitialBlockMetadata(type)
    });
    return;
  }

  const canReuseMarkdown = type === "VIDEO" && Boolean(parseYouTubeVideoUrl(markdown));

  if (slashInsertAfterTypes.has(type) && markdown.trim() && !canReuseMarkdown) {
    // Structured blocks store their content in metadata, so converting this block would
    // discard any note text that remains before or after the slash-command line.
    if (previousType !== "TOGGLE" && previousTextarea && previousTextarea.value !== markdown) {
      previousTextarea.value = markdown;
      autoGrowTextarea(previousTextarea);
    }
    closeSlashMenu();
    await saveBlockRow(row, { quiet: true });
    await insertBlockRelative(row, "after", {
      type,
      metadata: createInitialBlockMetadata(type)
    });
    return;
  }

  if (slashInsertAfterTypes.has(type) && !canReuseMarkdown) markdown = "";

  setRowType(row, type, { markdown });
  closeSlashMenu();
  await saveBlockRow(row);

  const nextTextarea = getBlockTextarea(row);
  if (type === "TOGGLE") {
    const titleInput = row.querySelector(".toggle-title-input");
    titleInput?.focus();
    titleInput?.select();
  } else if (nextTextarea) {
    autoGrowTextarea(nextTextarea);
    nextTextarea.focus();
    const cursor = context ? Math.min(context.start, nextTextarea.value.length) : nextTextarea.value.length;
    nextTextarea.selectionStart = nextTextarea.selectionEnd = cursor;
  } else if (type === "KANBAN") {
    row.querySelector(".kanban-title-input")?.focus();
  } else if (type === "DATABASE") {
    row.querySelector(".database-title-input")?.focus();
  } else if (type === "ACCORDION") {
    row.querySelector(".accordion-title-input")?.focus();
  } else if (type === "TIMETABLE") {
    row.querySelector(".timetable-title-input")?.focus();
  } else if (type === "GANTT") {
    row.querySelector(".gantt-title-input")?.focus();
  } else if (type === "BOOKMARK") {
    const titleInput = row.querySelector(".bookmark-title-input");
    titleInput?.focus();
    titleInput?.select();
  } else if (type === "AI_CHAT") {
    row.querySelector(".ai-chat-question-input")?.focus();
  } else {
    focusTableCell(row, 0, 0);
  }
}

function createBlockOrderTask(
  parentBlockId,
  orderedIds,
  versionOverrides = {},
  {
    pageId = state.selectedPage?.id,
    userId = state.user?.id,
    sourceId = pageDraftSourceId,
    mutationId = createMutationId(),
    previousIds = null,
    recovered = false,
    recoveredOrigin = null
  } = {}
) {
  if (!pageId || !userId || !sourceId || !orderedIds.length) throw new Error(t("errors.currentBlockOrder"));
  const items = orderedIds.map((id, index) => {
    const expectedVersion = Number(versionOverrides[id] ?? getBlockById(id)?.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error(t("errors.BLOCK_EDIT_CONFLICT"));
    }
    return { id, sortOrder: index, parentBlockId, expectedVersion };
  });
  return {
    userId,
    pageId,
    sourceId,
    parentBlockId,
    orderedIds: [...orderedIds],
    previousIds: previousIds ? [...previousIds] : null,
    mutationId,
    items,
    recovered,
    recoveredOrigin
  };
}

function persistBlockOrderDraft(task) {
  const succeeded = checkDraftStoreWrite(
    pageDraftStore.saveBlockOrder({
      userId: task.userId,
      pageId: task.pageId,
      sourceId: task.sourceId,
      parentBlockId: task.parentBlockId,
      orderedIds: task.orderedIds,
      previousIds: task.previousIds,
      mutationId: task.mutationId,
      items: task.items
    })
  );
  if (!succeeded) throw new Error(t("status.localDraftStorageFailed"));
  return true;
}

function acknowledgeBlockOrderDraft(task) {
  const currentAcknowledged = checkDraftStoreWrite(
    pageDraftStore.acknowledgeBlockOrder({
      userId: task.userId,
      pageId: task.pageId,
      sourceId: task.sourceId,
      mutationId: task.mutationId
    })
  );
  if (!currentAcknowledged || !task.recoveredOrigin) return currentAcknowledged;
  return checkDraftStoreWrite(
    pageDraftStore.acknowledgeBlockOrder({
      userId: task.userId,
      pageId: task.pageId,
      sourceId: task.recoveredOrigin.sourceId,
      mutationId: task.recoveredOrigin.mutationId
    })
  );
}

async function submitBlockOrderTask(task, { keepalive = false } = {}) {
  const data = await api(`/api/pages/${task.pageId}/blocks/reorder`, {
    method: "POST",
    keepalive,
    body: { mutationId: task.mutationId, items: task.items }
  });
  applyPageContentVersion(task.pageId, data.pageContentVersion);
  if (state.selectedPage?.id === task.pageId) {
    for (const block of data.blocks ?? []) updateBlockInState(block);
    const returnedIds = (data.blocks ?? [])
      .filter((block) => normalizeParentBlockId(block.parentBlockId) === task.parentBlockId)
      .sort((left, right) => Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0) || left.id.localeCompare(right.id))
      .map((block) => block.id);
    if (returnedIds.length === getBlockSiblings(task.parentBlockId).length) {
      reorderBlockSiblingsInState(task.parentBlockId, returnedIds);
    }
  }
  return data;
}

async function submitBlockOrderTaskWithReplay(task, options = {}) {
  return submitWithFreshMutationIdOnReuse(
    task,
    async () => {
      try {
        return await submitBlockOrderTask(task, options);
      } catch (error) {
        if (!isAmbiguousApiError(error)) throw error;
        return submitBlockOrderTask(task, options);
      }
    },
    () => persistBlockOrderDraft(task)
  );
}

async function retryPendingBlockOrder({ keepalive = false } = {}) {
  const task = pendingBlockOrderTask;
  if (!task) return null;

  blockOrderSaving = true;
  syncPageModeUi();
  syncBeforeUnloadProtection();
  try {
    const data = await submitBlockOrderTaskWithReplay(task, { keepalive });
    acknowledgeBlockOrderDraft(task);
    if (pendingBlockOrderTask === task) pendingBlockOrderTask = null;
    if (state.selectedPage?.id === task.pageId) renderSelectedPage();
    setStatus(t("status.blockOrderChanged"));
    return data;
  } catch (error) {
    if (isDefinitiveApiError(error) && pendingBlockOrderTask === task) {
      pendingBlockOrderTask = null;
      if (state.selectedPage?.id === task.pageId && task.previousIds) {
        reorderBlockSiblingsInState(task.parentBlockId, task.previousIds);
        renderSelectedPage();
      }
    }
    throw error;
  } finally {
    blockOrderSaving = Boolean(pendingBlockOrderTask);
    syncPageModeUi();
    syncBeforeUnloadProtection();
  }
}

async function persistBlockOrder(parentBlockId, orderedIds, versionOverrides = {}, { allowLocked = false } = {}) {
  const writable = allowLocked ? canPersistSelectedPage() : requireWritablePage();
  if (!writable || !orderedIds.length) return;

  if (isCollaborativePage()) {
    const session = state.collaborationSession;
    if (!session?.isReady) throw new Error(t("sharing.syncRequired"));
    const updates = orderedIds.map((id, sortOrder) => {
      const block = getBlockById(id);
      if (!block) throw new Error(t("errors.currentBlockOrder"));
      return { ...block, parentBlockId: parentBlockId ?? null, sortOrder };
    });
    session.upsertBlocks(updates);
    return { blocks: updates };
  }

  const task = createBlockOrderTask(parentBlockId, orderedIds, versionOverrides);
  persistBlockOrderDraft(task);
  pendingBlockOrderTask = task;
  blockOrderSaving = true;
  syncPageModeUi();
  syncBeforeUnloadProtection();

  try {
    const data = await submitBlockOrderTaskWithReplay(task);
    acknowledgeBlockOrderDraft(task);
    if (pendingBlockOrderTask === task) pendingBlockOrderTask = null;
    return data;
  } catch (error) {
    if (isDefinitiveApiError(error) && pendingBlockOrderTask === task) {
      pendingBlockOrderTask = null;
    }
    throw error;
  } finally {
    blockOrderSaving = Boolean(pendingBlockOrderTask);
    syncPageModeUi();
    syncBeforeUnloadProtection();
  }
}

function getBlockCreateTask(authenticationScope, pageId, payload) {
  const requestKey = JSON.stringify({ pageId, payload });
  const taskKey = `${authenticationScope.targetKey}\n${requestKey}`;
  const pendingTask = pendingBlockCreateTasks.get(taskKey);
  if (pendingTask && !pendingTask.inFlight) return pendingTask;

  return {
    taskKey,
    targetKey: authenticationScope.targetKey,
    pageId,
    requestKey,
    mutationId: createMutationId(),
    payload: Object.freeze({ ...payload }),
    inFlight: false
  };
}

async function submitBlockCreateTask(task, authenticationScope) {
  task.inFlight = true;
  let attempt = 0;

  try {
    while (attempt < 2) {
      if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;

      try {
        const data = await submitWithFreshMutationIdOnReuse(task, () => {
          if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
          return api(`/api/pages/${task.pageId}/blocks`, {
            method: "POST",
            body: { ...task.payload, mutationId: task.mutationId }
          });
        });
        if (data === null || !isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
        if (pendingBlockCreateTasks.get(task.taskKey) === task) {
          pendingBlockCreateTasks.delete(task.taskKey);
        }
        return data;
      } catch (error) {
        if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
        attempt += 1;
        if (!isAmbiguousApiError(error) || attempt >= 2) {
          if (!isAmbiguousApiError(error) && pendingBlockCreateTasks.get(task.taskKey) === task) {
            pendingBlockCreateTasks.delete(task.taskKey);
          }
          throw error;
        }
      }
    }

    return null;
  } catch (error) {
    if (isAmbiguousApiError(error) && isCurrentAuthenticatedSessionScope(authenticationScope)) {
      pendingBlockCreateTasks.set(task.taskKey, task);
    }
    throw error;
  } finally {
    task.inFlight = false;
  }
}

async function createEmptyBlock(
  pageId,
  { parentBlockId = null, sortOrder, allowLocked = false, type = "MARKDOWN", markdown = "", metadata } = {}
) {
  const writable = allowLocked ? canPersistSelectedPage() : requireWritablePage();
  if (!writable) throw new Error(t("errors.readOnlyPage"));
  if (isCollaborativePage()) {
    const session = state.collaborationSession;
    if (!session?.isReady) throw new Error(t("sharing.syncRequired"));
    const block = {
      id: createClientId("blk"),
      type,
      markdown,
      checked: false,
      parentBlockId: parentBlockId ?? null,
      sortOrder: sortOrder ?? getBlockSiblings(parentBlockId ?? null).length,
      metadata: metadata ?? null,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      children: []
    };
    session.upsertBlock(block);
    return { block, pageContentVersion: state.selectedPage?.contentVersion ?? 1 };
  }
  const authenticationScope = captureAuthenticatedSessionScope();
  if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
  const payload = {
    type,
    markdown,
    parentBlockId,
    ...(metadata === undefined ? {} : { metadata }),
    ...(sortOrder === undefined ? {} : { sortOrder })
  };
  const task = getBlockCreateTask(authenticationScope, pageId, payload);
  const data = await submitBlockCreateTask(task, authenticationScope);
  if (!data || !isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
  applyPageContentVersion(pageId, data.pageContentVersion);
  return data;
}

async function insertBlockRelative(
  referenceRow,
  placement = "after",
  { type = "MARKDOWN", markdown = "", metadata } = {}
) {
  if (!requireWritablePage() || !referenceRow?.dataset.blockId) return;

  const parentBlockId = normalizeParentBlockId(referenceRow.dataset.parentBlockId);
  const siblingIds = getBlockSiblings(parentBlockId).map((block) => block.id);
  const referenceIndex = siblingIds.indexOf(referenceRow.dataset.blockId);
  if (referenceIndex < 0) throw new Error(t("errors.currentBlockOrder"));

  const insertionIndex = placement === "before" ? referenceIndex : referenceIndex + 1;
  const data = await createEmptyBlock(state.selectedPage.id, {
    parentBlockId,
    sortOrder: insertionIndex,
    type,
    markdown,
    metadata
  });
  if (!data) return null;
  const orderedIds = [...siblingIds];
  orderedIds.splice(insertionIndex, 0, data.block.id);
  await persistBlockOrder(parentBlockId, orderedIds, { [data.block.id]: data.block.version });

  state.pendingFocusBlockId = data.block.id;
  if (isCollaborativePage()) renderSelectedPage();
  else await openPage(state.selectedPage.id);
  setStatus(
    t("status.blockInserted", {
      position: t(placement === "before" ? "position.top" : "position.bottom")
    })
  );
  return data;
}

async function appendBlock(afterRow = null) {
  if (!requireWritablePage()) return;
  if (afterRow) return insertBlockRelative(afterRow, "after");

  const siblingIds = getBlockSiblings(null).map((block) => block.id);
  const data = await createEmptyBlock(state.selectedPage.id, { sortOrder: siblingIds.length });
  if (!data) return;
  await persistBlockOrder(null, [...siblingIds, data.block.id], { [data.block.id]: data.block.version });

  state.pendingFocusBlockId = data.block.id;
  if (isCollaborativePage()) renderSelectedPage();
  else await openPage(state.selectedPage.id);
  setStatus(t("status.blockAppended"));
}

async function refreshSelectedPageAfterBlockDeletion(pageId, { focusBlockId = null } = {}) {
  state.pendingFocusBlockId = focusBlockId;
  if (isCollaborativePage()) renderSelectedPage();
  else await openPage(pageId, { skipFlush: true });

  const needsStarterBlock = Boolean(
    state.selectedPage?.id === pageId
    && state.workspaceView === "page"
    && !isPageReadOnly()
    && flattenBlocks(state.selectedPage.blocks).length === 0
  );
  if (!needsStarterBlock) return;

  const starter = await createEmptyBlock(pageId, { allowLocked: true });
  if (!starter) return;
  state.pendingFocusBlockId = starter.block.id;
  if (isCollaborativePage()) renderSelectedPage();
  else await openPage(pageId, { skipFlush: true });
}

async function deleteEmptyBlock(row) {
  if (!requireWritablePage() || !row?.dataset.blockId || row.dataset.deleting === "true") return;
  if (row.dataset.draftConflict === "true") {
    reportUnresolvedDraftConflict();
    return;
  }

  return withPageEditLock(async () => {
    const blockId = row.dataset.blockId;
    if (!isCollaborativePage()) {
      assertNoPendingLocalBlockDrafts(state.selectedPage.id, [blockId], {
        excludeSourceId: pageDraftSourceId
      });
    }
    const block = getBlockById(blockId);
    const childIds = (block?.children ?? []).map((child) => child.id);
    const rows = [...elements.blockList.querySelectorAll(".editor-block-row")];
    const rowIndex = rows.indexOf(row);
    const groupRows = getBlockGroupRows(row);
    const previousBlockId = rows[rowIndex - 1]?.dataset.blockId ?? null;
    const nextBlockId = rows[rowIndex + groupRows.length]?.dataset.blockId ?? null;
    const focusBlockId = previousBlockId ?? childIds[0] ?? nextBlockId;

    row.dataset.deleting = "true";
    discardBlockSave(blockId);
    closeSlashMenu();
    closeInlineToolbar();
    closeBlockContextMenu();

    await deleteBlockWithVersionCheck(blockId, {
      includeDescendants: false,
      preserveChildren: true
    });

    await refreshSelectedPageAfterBlockDeletion(state.selectedPage.id, { focusBlockId });
    setStatus(t("status.emptyBlockDeleted"));
  });
}

function focusPendingBlock() {
  if (isPageReadOnly() || !state.pendingFocusBlockId) return;
  const row = elements.blockList.querySelector(`[data-block-id="${CSS.escape(state.pendingFocusBlockId)}"]`);
  const toggleTitle = row?.dataset.blockType === "TOGGLE" ? row.querySelector(".toggle-title-input") : null;
  const textarea = getBlockTextarea(row);
  if (toggleTitle) {
    toggleTitle.focus();
    toggleTitle.select();
  } else if (textarea) {
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  } else {
    row?.querySelector(
      ".table-cell-input, .kanban-title-input, .database-title-input, .gantt-title-input, .bookmark-title-input, .bookmark-url-input, .attachment-download-button"
    )?.focus();
  }
  state.pendingFocusBlockId = null;
}

const pdfExportPage = Object.freeze({
  widthMm: 297,
  horizontalMarginMm: 10,
  cssPixelsPerInch: 96,
  millimetersPerInch: 25.4
});

function waitForAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function sanitizePdfDocumentTitle(value) {
  return (value || t("newDocumentTitle"))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "BrainVault";
}

function getPdfExportContentWidth(pageRect) {
  let contentWidth = Math.max(1, pageRect.width);
  const ignoredSelectors = [
    ".block-row-topline",
    ".kanban-card-style-panel",
    ".database-toolbar-popover",
    ".bookmark-item-actions"
  ];

  for (const element of elements.pageView.querySelectorAll("*")) {
    if (ignoredSelectors.some((selector) => element.matches(selector) || element.closest(selector))) continue;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") continue;

    const rect = element.getBoundingClientRect();
    if (!rect.width && !element.scrollWidth) continue;
    const offsetLeft = rect.left - pageRect.left;
    const width = Math.max(rect.width, element.scrollWidth || 0);
    contentWidth = Math.max(contentWidth, offsetLeft + width);
  }

  return Math.ceil(contentWidth);
}

function freezePdfExportComputedStyles() {
  const snapshots = [];
  const remember = (element) => {
    snapshots.push([element, element.getAttribute("style")]);
    return window.getComputedStyle(element);
  };

  elements.pageView.querySelectorAll(
    ".page-title-input, " +
    '.editor-block-row[data-block-type="HEADING_1"] .block-row-input, ' +
    '.editor-block-row[data-block-type="HEADING_2"] .block-row-input, ' +
    '.editor-block-row[data-block-type="HEADING_3"] .block-row-input, ' +
    ".kanban-title-input, .database-title-input, .gantt-title-input, .bookmark-title-input"
  ).forEach((element) => {
    const computed = remember(element);
    element.style.fontSize = computed.fontSize;
    element.style.lineHeight = computed.lineHeight;
  });

  elements.pageView.querySelectorAll(".kanban-column, .database-board-column").forEach((element) => {
    const computed = remember(element);
    const width = `${element.getBoundingClientRect().width}px`;
    element.style.width = width;
    element.style.flexBasis = width;
    element.style.minWidth = computed.minWidth;
    element.style.maxWidth = computed.maxWidth;
  });

  elements.pageView.querySelectorAll(".gantt-stage, .rendered-gantt-stage").forEach((element) => {
    remember(element);
    element.style.width = `${element.scrollWidth}px`;
  });

  return () => {
    for (const [element, style] of snapshots) {
      if (style === null) element.removeAttribute("style");
      else element.setAttribute("style", style);
    }
  };
}

function configurePdfExportLayout() {
  const pageRect = elements.pageView.getBoundingClientRect();
  const pageWidth = Math.max(1, Math.ceil(pageRect.width));
  const contentWidth = getPdfExportContentWidth(pageRect);
  const printableWidth =
    ((pdfExportPage.widthMm - pdfExportPage.horizontalMarginMm * 2) / pdfExportPage.millimetersPerInch) *
    pdfExportPage.cssPixelsPerInch;
  const scale = Math.min(1, printableWidth / Math.max(pageWidth, contentWidth));

  document.documentElement.style.setProperty("--pdf-export-page-width", `${pageWidth}px`);
  document.documentElement.style.setProperty("--pdf-export-scale", scale.toFixed(4));
}

function clearPdfExportLayout() {
  document.body.classList.remove("pdf-export-mode");
  document.documentElement.style.removeProperty("--pdf-export-page-width");
  document.documentElement.style.removeProperty("--pdf-export-scale");
}

function expandToggleDetailsForPdf() {
  const snapshots = [...elements.pageView.querySelectorAll("details.rendered-toggle, details.rendered-accordion-item")].map((details) => [
    details,
    details.hasAttribute("open")
  ]);
  for (const [details] of snapshots) details.setAttribute("open", "");
  return () => {
    for (const [details, wasOpen] of snapshots) {
      if (wasOpen) details.setAttribute("open", "");
      else details.removeAttribute("open");
    }
  };
}

async function waitForPdfExportAssets() {
  const imagePromises = [...elements.pageView.querySelectorAll("img")].map((image) => {
    if (image.complete) return image.decode?.().catch(() => {}) ?? Promise.resolve();
    return new Promise((resolve) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", resolve, { once: true });
    });
  });
  const assetsReady = Promise.allSettled([
    document.fonts?.ready ?? Promise.resolve(),
    ...imagePromises
  ]);
  const timeout = new Promise((resolve) => window.setTimeout(resolve, 2500));
  await Promise.race([assetsReady, timeout]);
}

async function exportCurrentPageToPdf() {
  if (!state.selectedPage || elements.exportPdfButton.disabled) return;

  const originalDocumentTitle = document.title;
  let restoreComputedStyles = () => {};
  let restoreToggleDetails = () => {};
  elements.exportPdfButton.disabled = true;
  setStatus(t("status.preparingPdf"));

  try {
    closeSlashMenu();
    closeInlineToolbar();
    closeBlockContextMenu();
    closePageActionsMenu();
    closeKanbanCardStyleMenus();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    elements.blockList.querySelectorAll("textarea").forEach(autoGrowTextarea);
    hydrateMathExpressions(elements.pageView);
    hydrateAccordionIcons(elements.pageView);
    restoreToggleDetails = expandToggleDetailsForPdf();
    restoreComputedStyles = freezePdfExportComputedStyles();

    await waitForPdfExportAssets();
    document.body.classList.add("pdf-export-mode");
    await waitForAnimationFrame();
    configurePdfExportLayout();
    document.title = `${sanitizePdfDocumentTitle(elements.pageTitle.value)} - BrainVault`;
    await waitForAnimationFrame();

    setStatus(t("status.pdfSaveInstructions"));
    window.print();
    setStatus(t("status.pdfDialogClosed"));
  } catch (error) {
    console.error("PDF export failed", error);
    setStatus(t("errors.pdfExportFailed"), true);
  } finally {
    document.title = originalDocumentTitle;
    clearPdfExportLayout();
    restoreComputedStyles();
    restoreToggleDetails();
    elements.exportPdfButton.disabled = false;
  }
}


function clampPageCoverPosition(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 50;
}

function setPageCoverPreviewPosition(x, y) {
  const positionX = clampPageCoverPosition(x);
  const positionY = clampPageCoverPosition(y);
  elements.pageCoverImage.style.objectPosition = `${positionX}% ${positionY}%`;
  elements.pageCoverPositionX.value = String(positionX);
  elements.pageCoverPositionY.value = String(positionY);
  elements.pageCoverPositionXOutput.value = `${positionX}%`;
  elements.pageCoverPositionYOutput.value = `${positionY}%`;
  if (isPageCoverPositionDraftForPage(pageCoverPositionDraft, state.selectedPage?.id)) {
    pageCoverPositionDraft.x = positionX;
    pageCoverPositionDraft.y = positionY;
  }
}

function closePageCoverPositionEditor({ restore = false } = {}) {
  if (restore && pageCoverPositionDraft && state.selectedPage?.id === pageCoverPositionDraft.pageId) {
    setPageCoverPreviewPosition(
      state.selectedPage.coverPositionX ?? 50,
      state.selectedPage.coverPositionY ?? 50
    );
  }
  pageCoverPositionDraft = null;
  pageCoverDragPointerId = null;
  elements.pageCover.classList.remove("is-repositioning");
  elements.pageCoverPositionPanel.classList.add("hidden");
  elements.pageCoverPositionButton.setAttribute("aria-expanded", "false");
}

function syncPageCoverControls() {
  const page = state.workspaceView === "page" ? state.selectedPage : null;
  const hasCurrentPositionDraft = isPageCoverPositionDraftForPage(pageCoverPositionDraft, page?.id);
  const hasCover = Boolean(page?.coverUrl);
  const canEditCover = Boolean(
    page && hasCover && !isPageReadOnly() && isPageOwner(page) && !isPageInteractionLocked() && !pageCoverSaving
  );
  const canAddCover = Boolean(
    page && !hasCover && !isPageReadOnly() && isPageOwner(page) && !isPageInteractionLocked() && !pageCoverSaving
  );

  elements.pageCoverControls.classList.toggle("hidden", !canEditCover);
  elements.pageCoverEmptyActions.classList.toggle("hidden", !canAddCover);
  for (const button of [
    elements.pageCoverAddButton,
    elements.pageCoverChangeButton,
    elements.pageCoverPositionButton,
    elements.pageCoverRemoveButton,
    elements.pageCoverPositionCancel,
    elements.pageCoverPositionSave
  ]) {
    button.disabled = pageCoverSaving || (!canEditCover && button !== elements.pageCoverAddButton);
  }
  elements.pageCoverAddButton.disabled = pageCoverSaving || !canAddCover;
  elements.pageCoverPositionX.disabled = !canEditCover;
  elements.pageCoverPositionY.disabled = !canEditCover;

  if (pageCoverPositionDraft && (!canEditCover || !hasCurrentPositionDraft)) {
    closePageCoverPositionEditor({ restore: true });
  }
}

function renderPageCover(page) {
  if (pageCoverPositionDraft && !isPageCoverPositionDraftForPage(pageCoverPositionDraft, page?.id)) {
    closePageCoverPositionEditor();
  }
  const hasCover = Boolean(page?.coverUrl);
  elements.pageViewHeader.classList.toggle("has-page-cover", hasCover);
  elements.pageView.classList.toggle("has-page-cover", hasCover);
  elements.pageCover.classList.toggle("hidden", !hasCover);
  if (!hasCover) {
    elements.pageCoverImage.removeAttribute("src");
    elements.pageCoverImage.alt = "";
    closePageCoverPositionEditor();
    syncPageCoverControls();
    return;
  }

  if (elements.pageCoverImage.getAttribute("src") !== page.coverUrl) {
    elements.pageCoverImage.setAttribute("src", page.coverUrl);
  }
  elements.pageCoverImage.alt = t("cover.alt", { title: page.title || t("newDocumentTitle") });
  const draft = pageCoverPositionDraft?.pageId === page.id ? pageCoverPositionDraft : null;
  setPageCoverPreviewPosition(
    draft?.x ?? page.coverPositionX ?? 50,
    draft?.y ?? page.coverPositionY ?? 50
  );
  syncPageCoverControls();
}

function hydratePageCoverPreviews() {
  for (const image of elements.pageCoverDialog.querySelectorAll("img[data-cover-preview-src]")) {
    if (image.getAttribute("src")) continue;
    image.loading = "lazy";
    image.decoding = "async";
    image.setAttribute("src", image.dataset.coverPreviewSrc);
  }
}

function openPageCoverDialog() {
  if (!requireWritablePage() || !isPageOwner()) return;
  closePageCoverPositionEditor({ restore: true });
  hydratePageCoverPreviews();
  if (!elements.pageCoverDialog.open) elements.pageCoverDialog.showModal();
}

function closePageCoverDialog() {
  if (!pageCoverSaving) pageCoverOperationGuard.invalidate();
  if (elements.pageCoverDialog.open) elements.pageCoverDialog.close();
}

async function persistPageCover(updates, successKey, { operation = null } = {}) {
  if (!requireWritablePage() || !isPageOwner() || pageCoverSaving) return null;
  const pageId = state.selectedPage.id;
  const activeOperation = operation ?? pageCoverOperationGuard.begin(pageId);
  if (!pageCoverOperationGuard.isCurrent(activeOperation, pageId)) return null;
  pageCoverSaving = true;
  syncPageCoverControls();
  try {
    let updatedPage = null;
    await withPageEditLock(async () => {
      if (
        state.selectedPage?.id !== pageId
        || !pageCoverOperationGuard.isCurrent(activeOperation, pageId)
      ) return;
      const expectedVersion = state.selectedPage.version;
      const task = { mutationId: createMutationId() };
      const data = await submitWithFreshMutationIdOnReuse(task, () =>
        api(`/api/pages/${pageId}`, {
          method: "PATCH",
          body: {
            ...updates,
            expectedVersion,
            mutationId: task.mutationId
          }
        })
      );
      updatedPage = data.page;
      applyPageSummaryUpdate(pageId, {
        coverUrl: data.page.coverUrl,
        coverPositionX: data.page.coverPositionX,
        coverPositionY: data.page.coverPositionY,
        version: data.page.version,
        updatedAt: data.page.updatedAt
      });
      if (
        state.selectedPage?.id === pageId
        && pageCoverOperationGuard.isCurrent(activeOperation, pageId)
      ) {
        state.selectedPage = data.page;
        renderSelectedPage();
      }
    });
    if (updatedPage && successKey) setStatus(t(successKey));
    return updatedPage;
  } catch (error) {
    if (state.selectedPage?.id === pageId) renderPageCover(state.selectedPage);
    throw error;
  } finally {
    pageCoverSaving = false;
    syncPageCoverControls();
  }
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")), { once: true });
    reader.addEventListener("error", () => reject(new Error(t("cover.readError"))), { once: true });
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function loadCustomCoverImage(file) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw(context, width, height) { context.drawImage(bitmap, 0, 0, width, height); },
      close() { bitmap.close(); }
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error(t("cover.invalidFile")));
      candidate.src = objectUrl;
    });
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw(context, width, height) { context.drawImage(image, 0, 0, width, height); },
      close() { URL.revokeObjectURL(objectUrl); }
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function prepareCustomCoverDataUrl(file) {
  if (!file || !customCoverMimeTypes.includes(file.type)) throw new Error(t("cover.invalidFile"));
  if (file.size > customCoverSourceMaxBytes) throw new Error(t("cover.sourceTooLarge"));

  const image = await loadCustomCoverImage(file);
  try {
    if (!image.width || !image.height) throw new Error(t("cover.invalidFile"));
    let scale = Math.min(1, customCoverMaxWidth / image.width, customCoverMaxHeight / image.height);
    let quality = 0.9;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error(t("cover.readError"));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      image.draw(context, width, height);

      const blob = await canvasToBlob(canvas, "image/webp", quality)
        ?? await canvasToBlob(canvas, "image/jpeg", quality);
      canvas.width = 1;
      canvas.height = 1;
      if (!blob) throw new Error(t("cover.readError"));
      if (blob.size <= customCoverMaxBytes) return readBlobAsDataUrl(blob);

      if (quality > 0.6) quality -= 0.08;
      else scale *= 0.82;
    }
    throw new Error(t("cover.optimizedTooLarge"));
  } finally {
    image.close();
  }
}

function updatePageCoverPositionFromPointer(event) {
  if (!pageCoverPositionDraft || event.pointerId !== pageCoverDragPointerId) return;
  const rect = elements.pageCoverImage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = ((event.clientX - rect.left) / rect.width) * 100;
  const y = ((event.clientY - rect.top) / rect.height) * 100;
  setPageCoverPreviewPosition(x, y);
}

function renderSelectedPage() {
  closeBlockContextMenu();
  closePageActionsMenu();
  syncWorkspaceLocation();
  const page = state.selectedPage;
  const isHome = state.workspaceView === "home";
  const isCollection = state.workspaceView === "collection";
  const hasPage = state.workspaceView === "page" && Boolean(page);
  const renderedPageId = elements.blockList.dataset.pageId;

  if (
    hasPage &&
    renderedPageId === page.id &&
    !state.applyingCollaborationSnapshot &&
    !isCollaborativePage(page)
  ) {
    if (pageTitleDraftConflict || pageTitleEditRevision > pageTitleSavedRevision) {
      page.title = normalizePageTitle(elements.pageTitle.value);
    }
    syncVisibleBlocksToState({ dirtyOnly: true });
  }

  elements.sidebarHomeShortcut.classList.toggle("active", isHome);
  if (isHome) elements.sidebarHomeShortcut.setAttribute("aria-current", "page");
  else elements.sidebarHomeShortcut.removeAttribute("aria-current");

  elements.welcomeView.classList.toggle("hidden", !isHome);
  elements.collectionView.classList.toggle("hidden", !isCollection);
  elements.pageViewHeader.classList.toggle("hidden", !hasPage);
  elements.pageView.classList.toggle("hidden", !hasPage);
  renderSubpageIndex(hasPage ? page : null);

  if (isCollection) {
    delete elements.blockList.dataset.pageId;
    renderCollaborationChrome();
    renderPages();
    return;
  }
  if (!hasPage) {
    delete elements.blockList.dataset.pageId;
    renderCollaborationChrome();
    renderPages();
    return;
  }

  elements.blockList.dataset.pageId = page.id;
  const flatBlocks = flattenBlocks(page.blocks);
  renderPageHeader(page);
  renderPageCover(page);
  elements.pageKicker.textContent = formatDate(page.updatedAt);
  renderIconValue(elements.pageIconButton, page.icon, "📄");
  elements.pageTitle.value = page.title;
  elements.blockCount.textContent = t("counts.blocks", { count: formatNumber(flatBlocks.length) });

  elements.blockList.replaceChildren();
  if (!flatBlocks.length) {
    const empty = makeEmptyMessage(t(isPageReadOnly() ? "empty.readOnlyPage" : "empty.noBlocksWrite"));
    empty.classList.add("block-empty-message");
    elements.blockList.append(empty);
  } else {
    for (const block of flatBlocks) {
      elements.blockList.append(
        renderBlock(block, isCollaborativePage(page) ? null : getBlockRenderDraft(page.id, block.id))
      );
    }
  }
  if (isCollaborativePage(page)) refreshCollaborativePageDraftRecovery();

  syncPageModeUi();
  renderPages();
  requestAnimationFrame(() => {
    hydrateMathExpressions(elements.pageView);
    hydrateAccordionIcons(elements.pageView);
    focusPendingBlock();
  });
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

function applyPageContentVersion(pageId, contentVersion) {
  const version = Number(contentVersion);
  if (!Number.isSafeInteger(version) || version < 1) return;
  const applyVersion = (page) => {
    if (page?.id !== pageId) return;
    page.contentVersion = Math.max(Number(page.contentVersion ?? 1), version);
  };
  applyVersion(state.selectedPage);
  for (const pages of [state.pages, state.allPages]) {
    for (const page of pages) applyVersion(page);
  }
}

async function savePageTitleNow({ quiet = true, keepalive = false, allowLocked = false } = {}) {
  const writable = allowLocked ? canPersistSelectedPage() : requireWritablePage({ announce: !quiet });
  if (!writable || pageTitleDraftConflict) return null;
  const pageId = state.selectedPage.id;
  const title = normalizePageTitle(elements.pageTitle.value);
  if (isCollaborativePage()) {
    const session = state.collaborationSession;
    if (!session?.isReady) throw new Error(t("sharing.syncRequired"));
    const previousTitle = state.selectedPage.title ?? "";
    elements.pageTitle.value = title;
    try {
      session.setTitle(title);
    } catch (error) {
      elements.pageTitle.value = previousTitle;
      setStatus(getRejectedLocalMutationMessage(error), true);
      throw error;
    }
    state.selectedPage.title = title;
    for (const pages of [state.pages, state.allPages]) {
      const page = pages.find((item) => item.id === pageId);
      if (page) page.title = title;
    }
    renderPageHeader(state.selectedPage);
    updateCollaborationAwareness(elements.pageTitle);
    if (!quiet) setStatus(t("status.pageTitleSaved"));
    return { page: state.selectedPage };
  }
  window.clearTimeout(pageTitleSaveTimer);
  pageTitleSaveTimer = null;
  if (pageTitleEditRevision > 0 && !persistPageTitleDraft()) {
    throw new Error(t("status.localDraftStorageFailed"));
  }
  const task = {
    userId: state.user?.id,
    draftSourceId: pageTitleDraftSourceId || pageDraftSourceId,
    pageId,
    title,
    editRevision: pageTitleEditRevision,
    expectedVersion: getPositiveVersion(pageTitleDraftExpectedVersion),
    recoveredConflictOrigin: pageTitleConflictOrigin,
    taskId: ++pageTitleTaskId,
    keepalive,
    mutationId: createMutationId()
  };
  syncBeforeUnloadProtection();

  try {
    const data = await pageTitleSaveQueue.enqueue(task);
    if (!quiet) setStatus(t("status.pageTitleSaved"));
    return data;
  } finally {
    syncBeforeUnloadProtection();
  }
}

function schedulePageTitleSave({ allowConflictPrompt = true } = {}) {
  if (!requireWritablePage({ announce: false })) return;
  if (isCollaborativePage()) {
    const session = state.collaborationSession;
    if (!session?.isReady) return;
    const title = elements.pageTitle.value;
    // Keep an empty in-progress field local. The materialized document requires
    // a non-blank title, and the blur handler restores the localized default.
    if (!title.trim()) {
      updateCollaborationAwareness(elements.pageTitle);
      syncBeforeUnloadProtection();
      return;
    }
    try {
      session.setTitle(title);
    } catch (error) {
      updateInputValuePreservingSelection(elements.pageTitle, state.selectedPage.title ?? "");
      setStatus(getRejectedLocalMutationMessage(error), true);
      syncBeforeUnloadProtection();
      return;
    }
    state.selectedPage.title = title;
    for (const pages of [state.pages, state.allPages]) {
      const page = pages.find((item) => item.id === state.selectedPage.id);
      if (page) page.title = title;
    }
    renderPageHeader(state.selectedPage);
    updateCollaborationAwareness(elements.pageTitle);
    syncBeforeUnloadProtection();
    return;
  }
  const previousRevision = pageTitleEditRevision;
  pageTitleEditRevision += 1;
  const title = normalizePageTitle(elements.pageTitle.value);
  if (!persistPageTitleDraft()) {
    pageTitleEditRevision = previousRevision;
    updateInputValuePreservingSelection(elements.pageTitle, state.selectedPage.title ?? "");
    syncBeforeUnloadProtection();
    return;
  }

  if (pageTitleDraftConflict) {
    if (!allowConflictPrompt || !promotePageTitleDraftConflict()) {
      window.clearTimeout(pageTitleSaveTimer);
      pageTitleSaveTimer = null;
      syncBeforeUnloadProtection();
      return;
    }
  }

  applyPageSummaryUpdate(state.selectedPage.id, { title });
  renderPageHeader(state.selectedPage);
  window.clearTimeout(pageTitleSaveTimer);
  pageTitleSaveTimer = window.setTimeout(() => {
    pageTitleSaveTimer = null;
    savePageTitleNow().catch((error) => setStatus(error.message, true));
  }, 650);
  syncBeforeUnloadProtection();
}

function normalizeRecoveredBlockPayload(payload, currentBlock) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const type = typeof payload.type === "string" && Object.hasOwn(blockTypeLabels, payload.type)
    ? payload.type
    : currentBlock?.type;
  if (!type || type === "ATTACHMENT") return null;
  const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
    ? payload.metadata
    : null;
  return {
    type,
    markdown: typeof payload.markdown === "string" ? payload.markdown : "",
    checked: Boolean(payload.checked),
    metadata
  };
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
}

function jsonValuesMatch(left, right) {
  return JSON.stringify(sortJsonValue(left)) === JSON.stringify(sortJsonValue(right));
}

function normalizeComparableMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) return null;
  return value;
}

function blockPayloadsMatch(block, payload) {
  const current = {
    type: block.type,
    markdown: block.markdown ?? "",
    checked: Boolean(block.checked),
    metadata: normalizeComparableMetadata(block.metadata)
  };
  const candidate = {
    ...payload,
    metadata: normalizeComparableMetadata(payload.metadata)
  };
  return jsonValuesMatch(current, candidate);
}

function applyPersistedPageDraft(page) {
  const scope = getDraftScope(page?.id);
  const records = scope ? pageDraftStore.loadPageDrafts(scope.userId, scope.pageId) : [];
  const recovery = {
    scope,
    title: null,
    blocks: [],
    blockOrder: null,
    orderConflicts: [],
    missing: [],
    alternates: [],
    conflictCount: 0
  };
  if (!scope || records.length === 0 || !page) return recovery;

  const titleCandidates = [];
  for (const record of records) {
    if (!record.title) continue;
    if (page.title === record.title.value) {
      checkDraftStoreWrite(
        pageDraftStore.acknowledgeTitle({
          ...scope,
          sourceId: record.sourceId,
          revision: record.title.revision,
          nextExpectedVersion: page.version
        })
      );
    } else {
      titleCandidates.push({ sourceId: record.sourceId, draft: record.title });
    }
  }

  titleCandidates.sort((left, right) => right.draft.updatedAt - left.draft.updatedAt);
  if (titleCandidates.length > 0) {
    const selected = titleCandidates[0];
    const serverVersion = getPositiveVersion(page.version);
    const conflict = serverVersion !== selected.draft.expectedVersion;
    recovery.title = { ...selected.draft, sourceId: selected.sourceId, serverVersion, conflict };
    recovery.conflictCount += conflict ? 1 : 0;
    page.title = selected.draft.value;

    for (const candidate of titleCandidates.slice(1)) {
      if (candidate.draft.value === selected.draft.value) continue;
      recovery.alternates.push({
        kind: "title",
        sourceId: candidate.sourceId,
        value: candidate.draft.value,
        expectedVersion: candidate.draft.expectedVersion,
        updatedAt: candidate.draft.updatedAt
      });
      recovery.conflictCount += 1;
    }
  }

  const blockCandidates = new Map();
  for (const record of records) {
    for (const [blockId, draft] of Object.entries(record.blocks)) {
      const candidates = blockCandidates.get(blockId) ?? [];
      candidates.push({ sourceId: record.sourceId, draft });
      blockCandidates.set(blockId, candidates);
    }
  }

  for (const [blockId, candidates] of blockCandidates) {
    const block = getBlockById(blockId, page.blocks ?? []);
    if (!block) {
      for (const candidate of candidates) recovery.missing.push({ blockId, ...candidate });
      recovery.conflictCount += candidates.length;
      continue;
    }

    const pending = [];
    for (const candidate of candidates) {
      const payload = normalizeRecoveredBlockPayload(candidate.draft.payload, block);
      if (!payload) {
        recovery.missing.push({ blockId, ...candidate });
        recovery.conflictCount += 1;
        continue;
      }
      if (blockPayloadsMatch(block, payload)) {
        checkDraftStoreWrite(
          pageDraftStore.acknowledgeBlock({
            ...scope,
            sourceId: candidate.sourceId,
            blockId,
            revision: candidate.draft.revision,
            nextExpectedVersion: block.version
          })
        );
      } else {
        pending.push({ ...candidate, payload });
      }
    }

    pending.sort((left, right) => right.draft.updatedAt - left.draft.updatedAt);
    if (pending.length === 0) continue;
    const selected = pending[0];
    const serverVersion = getPositiveVersion(block.version);
    const conflict = serverVersion !== selected.draft.expectedVersion;
    recovery.blocks.push({
      blockId,
      draft: selected.draft,
      sourceId: selected.sourceId,
      serverVersion,
      conflict
    });
    recovery.conflictCount += conflict ? 1 : 0;
    Object.assign(block, selected.payload);

    for (const candidate of pending.slice(1)) {
      if (jsonValuesMatch(candidate.payload, selected.payload)) continue;
      recovery.alternates.push({
        kind: "block",
        blockId,
        sourceId: candidate.sourceId,
        payload: candidate.draft.payload,
        expectedVersion: candidate.draft.expectedVersion,
        updatedAt: candidate.draft.updatedAt
      });
      recovery.conflictCount += 1;
    }
  }

  const orderCandidates = records
    .filter((record) => record.blockOrder)
    .map((record) => ({ sourceId: record.sourceId, draft: record.blockOrder }))
    .sort((left, right) => right.draft.updatedAt - left.draft.updatedAt);
  const pendingOrderCandidates = [];

  for (const candidate of orderCandidates) {
    const siblings = getPageBlockSiblings(page, candidate.draft.parentBlockId);
    const currentIds = siblings.map((block) => block.id);
    if (jsonValuesMatch(currentIds, candidate.draft.orderedIds)) {
      checkDraftStoreWrite(
        pageDraftStore.acknowledgeBlockOrder({
          ...scope,
          sourceId: candidate.sourceId,
          mutationId: candidate.draft.mutationId
        })
      );
      continue;
    }
    pendingOrderCandidates.push(candidate);
  }

  if (pendingOrderCandidates.length > 0) {
    const selected = pendingOrderCandidates[0];
    const itemBlocks = selected.draft.items.map((item) => getBlockById(item.id, page.blocks ?? []));
    const siblings = getPageBlockSiblings(page, selected.draft.parentBlockId);
    const siblingIds = siblings.map((block) => block.id);
    const replayable =
      siblingIds.length === selected.draft.orderedIds.length &&
      siblingIds.every((id) => selected.draft.orderedIds.includes(id)) &&
      itemBlocks.every(
        (block, index) =>
          block &&
          Number(block.version ?? 1) === selected.draft.items[index].expectedVersion
      );

    if (replayable && reorderPageBlockSiblings(page, selected.draft.parentBlockId, selected.draft.orderedIds)) {
      recovery.blockOrder = { sourceId: selected.sourceId, draft: selected.draft, serverIds: siblingIds };
    } else {
      recovery.orderConflicts.push({ sourceId: selected.sourceId, draft: selected.draft });
      recovery.conflictCount += 1;
    }

    for (const candidate of pendingOrderCandidates.slice(1)) {
      if (jsonValuesMatch(candidate.draft.orderedIds, selected.draft.orderedIds)) continue;
      recovery.orderConflicts.push({ sourceId: candidate.sourceId, draft: candidate.draft });
      recovery.conflictCount += 1;
    }
  }

  return recovery;
}

function findRenderedBlockRow(blockId) {
  return [...elements.blockList.querySelectorAll(".editor-block-row[data-block-id]")].find(
    (row) => row.dataset.blockId === blockId
  );
}

function appendDraftRecoveryPanel(recovery) {
  const recoveryItems = [
    ...recovery.missing.map(({ blockId, sourceId, draft }) => ({
      kind: "missing-block",
      blockId,
      sourceId,
      payload: draft.payload,
      expectedVersion: draft.expectedVersion,
      updatedAt: draft.updatedAt
    })),
    ...recovery.orderConflicts.map(({ sourceId, draft }) => ({
      kind: "block-order",
      sourceId,
      parentBlockId: draft.parentBlockId,
      orderedIds: draft.orderedIds,
      expectedVersions: draft.items.map(({ id, expectedVersion }) => ({ id, expectedVersion })),
      updatedAt: draft.updatedAt
    })),
    ...recovery.alternates
  ];
  if (recoveryItems.length === 0) return;
  const panel = document.createElement("section");
  panel.className = "local-draft-recovery-panel";
  panel.setAttribute("role", "alert");
  const heading = document.createElement("strong");
  heading.textContent = t("status.localDraftConflict");
  const details = document.createElement("pre");
  details.tabIndex = 0;
  details.textContent = JSON.stringify(recoveryItems, null, 2);
  panel.append(heading, details);
  elements.blockList.append(panel);
}

function activatePersistedPageDraft(recovery) {
  const recoveredCount = (recovery.title ? 1 : 0) + recovery.blocks.length + (recovery.blockOrder ? 1 : 0);
  if (
    recoveredCount === 0 &&
    recovery.missing.length === 0 &&
    recovery.orderConflicts.length === 0 &&
    recovery.alternates.length === 0
  ) {
    return false;
  }

  if (recovery.title) {
    pageTitleEditRevision = Math.max(1, recovery.title.revision);
    pageTitleSavedRevision = Math.max(0, pageTitleEditRevision - 1);
    pageTitleDraftExpectedVersion = recovery.title.expectedVersion;
    pageTitleDraftConflict = recovery.title.conflict;
    pageTitleConflictOrigin = {
      sourceId: recovery.title.sourceId,
      value: recovery.title.value,
      expectedVersion: recovery.title.expectedVersion,
      revision: recovery.title.revision
    };
    // Never edit through another tab's durable recovery key. Clone the selected
    // recovery into this tab's source and retain the origin only for exact-match
    // cleanup after a confirmed server save.
    pageTitleDraftSourceId = pageDraftSourceId;
    persistPageTitleDraft();
    elements.pageTitle.classList.add("local-draft-recovered");
    if (recovery.title.conflict) {
      elements.pageTitle.classList.add("save-error");
    } else {
      pageTitleSaveTimer = window.setTimeout(() => {
        pageTitleSaveTimer = null;
        savePageTitleNow().catch((error) => setStatus(error.message, true));
      }, 150);
    }
  }

  for (const recovered of recovery.blocks) {
    const row = findRenderedBlockRow(recovered.blockId);
    if (!row) continue;
    row.dataset.editRevision = String(Math.max(1, recovered.draft.revision));
    row.dataset.draftExpectedVersion = String(recovered.draft.expectedVersion);
    row.dataset.draftSourceId = pageDraftSourceId;
    blockDraftConflictOrigins.set(recovered.blockId, {
      sourceId: recovered.sourceId,
      payload: recovered.draft.payload,
      expectedVersion: recovered.draft.expectedVersion,
      revision: recovered.draft.revision,
      resolved: !recovered.conflict
    });
    if (recovered.conflict) {
      row.dataset.draftConflict = "true";
    }
    blockDraftRenderSources.set(recovered.blockId, row.dataset.draftSourceId);
    persistBlockDraft(row);
    row.classList.add("is-dirty", "local-draft-recovered");
    if (recovered.conflict) {
      row.classList.add("save-error");
      continue;
    }
    blockSaveRows.set(recovered.blockId, row);
    blockSaveTimers.set(
      recovered.blockId,
      window.setTimeout(() => {
        blockSaveTimers.delete(recovered.blockId);
        saveBlockRow(row, { quiet: true }).catch((error) => setStatus(error.message, true));
      }, 200)
    );
  }

  if (recovery.blockOrder) {
    const { sourceId, draft } = recovery.blockOrder;
    const recoveredOrderTask = createBlockOrderTask(draft.parentBlockId, draft.orderedIds, {}, {
      pageId: recovery.scope.pageId,
      userId: recovery.scope.userId,
      sourceId: pageDraftSourceId,
      mutationId: draft.mutationId,
      previousIds: draft.previousIds ?? recovery.blockOrder.serverIds,
      recovered: true,
      recoveredOrigin: { sourceId, mutationId: draft.mutationId }
    });
    recoveredOrderTask.items = draft.items.map((item) => ({ ...item }));
    persistBlockOrderDraft(recoveredOrderTask);
    pendingBlockOrderTask = recoveredOrderTask;
    blockOrderSaving = true;
    window.setTimeout(() => {
      if (pendingBlockOrderTask?.mutationId !== draft.mutationId) return;
      retryPendingBlockOrder().catch((error) => setStatus(error.message, true));
    }, 0);
  }

  appendDraftRecoveryPanel(recovery);
  syncBeforeUnloadProtection();
  const hasConflict =
    recovery.conflictCount > 0 ||
    recovery.missing.length > 0 ||
    recovery.orderConflicts.length > 0 ||
    recovery.alternates.length > 0;
  setStatus(t(hasConflict ? "status.localDraftConflict" : "status.localDraftRecovered"), hasConflict);
  return true;
}

function getWorkspaceCreateRequestKey(payload) {
  return JSON.stringify(payload);
}

function getWorkspaceCreateTask(authenticationScope, payload) {
  const requestKey = getWorkspaceCreateRequestKey(payload);
  const taskKey = `${authenticationScope.targetKey}\n${requestKey}`;
  const pendingTask = pendingWorkspaceCreateTasks.get(taskKey);
  if (pendingTask) return pendingTask;

  return {
    taskKey,
    targetKey: authenticationScope.targetKey,
    requestKey,
    mutationId: createMutationId(),
    payload: Object.freeze({ ...payload })
  };
}

async function submitWorkspacePageCreate(task, authenticationScope) {
  pendingWorkspaceCreateTasks.set(task.taskKey, task);
  let attempt = 0;
  while (attempt < 2) {
    if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
    try {
      const data = await submitWithFreshMutationIdOnReuse(task, () => {
        if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
        return api("/api/pages", {
          method: "POST",
          body: { ...task.payload, mutationId: task.mutationId }
        });
      });
      if (data === null || !isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
      return data;
    } catch (error) {
      if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;
      attempt += 1;
      if (!isAmbiguousApiError(error) || attempt >= 2) {
        if (!isAmbiguousApiError(error) && pendingWorkspaceCreateTasks.get(task.taskKey) === task) {
          pendingWorkspaceCreateTasks.delete(task.taskKey);
        }
        throw error;
      }
    }
  }
  return null;
}

async function createWorkspacePage(payload, { creatingKey, createdKey, createdArgs = {} }) {
  if (state.workspaceCreateBusy) return { applied: false };
  const authenticationScope = captureAuthenticatedSessionScope();
  if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };
  const task = getWorkspaceCreateTask(authenticationScope, payload);

  setWorkspaceCreateBusy(true);
  try {
    await assertWorkspacePersistenceUnlocked();
    if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };
    await flushPendingPageEdits();
    if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };
    await assertWorkspacePersistenceUnlocked();
    if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };

    setStatus(t(creatingKey));
    const data = await submitWorkspacePageCreate(task, authenticationScope);
    if (!data || !isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };
    if (!data.page?.id || data.page.ownerId !== state.user?.id) {
      throw new Error(t("errors.invalidResponse"));
    }

    const pages = await fetchAllPageSummaries();
    if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };
    resetSearchDialogState();
    state.searchQuery = "";
    state.activeTag = "";
    state.pages = pages;
    state.allPages = pages;
    renderPages();

    if (payload.isCollection) await showCollection(data.page.id, { skipFlush: true });
    else await openPage(data.page.id, { skipFlush: true });
    if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return { applied: false };
    if (pendingWorkspaceCreateTasks.get(task.taskKey) === task) {
      pendingWorkspaceCreateTasks.delete(task.taskKey);
    }
    setStatus(t(createdKey, createdArgs));
    return { applied: true, page: data.page };
  } finally {
    if (isCurrentAuthenticatedSessionScope(authenticationScope)) setWorkspaceCreateBusy(false);
  }
}

async function createCollection() {
  if (state.workspaceCreateBusy) return { applied: false };
  const requestedName = window.prompt(t("collection.createPrompt"), t("collection.defaultName"));
  if (requestedName === null) return { applied: false };

  const name = requestedName.trim().slice(0, 160);
  if (!name) {
    setStatus(t("status.collectionNameRequired"), true);
    return { applied: false };
  }

  return createWorkspacePage(
    { title: name, icon: "📁", isCollection: true },
    {
      creatingKey: "status.creatingCollection",
      createdKey: "status.collectionCreated",
      createdArgs: { name }
    }
  );
}

async function createUntitledPage() {
  return createWorkspacePage(
    { title: t("newDocumentTitle"), icon: "📄" },
    { creatingKey: "status.creatingDocument", createdKey: "status.documentCreated" }
  );
}


function getCurrentWorkspaceLocation() {
  if (state.workspaceView === "page" && state.selectedPage?.id) {
    return { view: "page", pageId: state.selectedPage.id, pageMode: state.pageMode };
  }
  if (state.workspaceView === "collection" && state.activeCollectionId) {
    return { view: "collection", collectionId: state.activeCollectionId };
  }
  return { view: "home" };
}

function syncWorkspaceLocation() {
  if (!state.authenticated || !state.user) return;
  const hash = serializeWorkspaceLocation(getCurrentWorkspaceLocation());
  const target = `${window.location.pathname}${window.location.search}${hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current !== target) window.history.replaceState(null, "", target);
}

async function restoreWorkspaceLocationFromHash({ fallbackToHome = false } = {}) {
  if (!state.authenticated || !state.user) return false;
  const destination = parseWorkspaceLocation(window.location.hash);

  if (!destination || destination.view === "home") {
    if (fallbackToHome || destination?.view === "home") {
      await showHome({ skipFlush: true });
      return true;
    }
    syncWorkspaceLocation();
    return false;
  }

  try {
    if (destination.view === "collection") {
      const validCollection = destination.collectionId === defaultCollectionKey
        || state.allPages.some((page) => page.id === destination.collectionId && isCollectionPage(page));
      if (!validCollection) throw new Error(t("errors.invalidResponse"));
      await showCollection(destination.collectionId, { skipFlush: true });
      return true;
    }

    if (destination.view === "page") {
      await openPage(destination.pageId, {
        skipFlush: true,
        requestedPageMode: destination.pageMode
      });
      return true;
    }
  } catch (error) {
    if (!fallbackToHome) throw error;
    await showHome({ skipFlush: true });
    setStatus(error?.message ?? t("errors.unknown"), true);
    return false;
  }

  if (fallbackToHome) await showHome({ skipFlush: true });
  return false;
}


async function loadMe() {
  const data = await api("/api/auth/me", { skipAuthReset: true });
  return data.user;
}

async function fetchAllPageSummaries({ query = "", tag = "", archived = false } = {}) {
  const pages = [];
  const seenPageIds = new Set();
  const seenCursors = new Set();
  let cursor = null;

  do {
    const params = new URLSearchParams({ limit: "100" });
    if (query) params.set("q", query);
    if (tag) params.set("tag", tag);
    if (archived) params.set("archived", "true");
    if (cursor) params.set("cursor", cursor);

    const data = await api(`/api/pages?${params.toString()}`);
    if (!Array.isArray(data?.pages)) throw new Error(t("errors.invalidResponse"));
    for (const page of data.pages) {
      if (!page?.id || seenPageIds.has(page.id)) continue;
      seenPageIds.add(page.id);
      pages.push(page);
    }

    const nextCursor = typeof data.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
    if (nextCursor && seenCursors.has(nextCursor)) throw new Error(t("errors.invalidResponse"));
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  // The API scans with immutable creation keys so edits cannot cross the
  // pagination frontier. Restore the existing recent-first UI after the full scan.
  return sortByRecent(pages);
}

async function fetchOwnedWorkspacePageIds() {
  const [activePages, archivedPages] = await Promise.all([
    fetchAllPageSummaries(),
    fetchAllPageSummaries({ archived: true })
  ]);
  return [...new Set([...activePages, ...archivedPages]
    .filter((page) => isPageOwner(page))
    .map((page) => page.id))].sort();
}

async function loadAllPages() {
  state.allPages = await fetchAllPageSummaries();
}

async function loadPages(query = state.searchQuery, tag = state.activeTag) {
  state.searchQuery = query;
  state.activeTag = tag;
  state.pages = await fetchAllPageSummaries({ query, tag });

  if (!query && !tag) {
    state.allPages = state.pages;
  } else {
    await loadAllPages();
  }

  renderPages();
}

function isCurrentWorkspaceNavigation(generation) {
  return generation === workspaceNavigationGeneration;
}

async function showHome({ skipFlush = false, navigationGeneration = ++workspaceNavigationGeneration } = {}) {
  const shouldFlush = !skipFlush || state.pageEditLockDepth === 0;
  return withPageEditLock(
    async () => {
      if (!isCurrentWorkspaceNavigation(navigationGeneration)) return;
      await destroyPageCollaboration({ flush: false });
      if (!isCurrentWorkspaceNavigation(navigationGeneration)) return;
      closeSharePageDialog({ restoreFocus: false });
      resetPageEditTracking();
      state.selectedPage = null;
      state.pageMode = pageModes.READ;
      state.workspaceView = "home";
      state.activeCollectionId = null;
      renderSelectedPage();
    },
    { flush: shouldFlush }
  );
}

async function showCollection(
  collectionId,
  { skipFlush = false, navigationGeneration = ++workspaceNavigationGeneration } = {}
) {
  const shouldFlush = !skipFlush || state.pageEditLockDepth === 0;
  return withPageEditLock(
    async () => {
      if (!isCurrentWorkspaceNavigation(navigationGeneration)) return;
      await destroyPageCollaboration({ flush: false });
      if (!isCurrentWorkspaceNavigation(navigationGeneration)) return;
      closeSharePageDialog({ restoreFocus: false });
      resetPageEditTracking();
      state.selectedPage = null;
      state.pageMode = pageModes.READ;
      state.workspaceView = "collection";
      state.activeCollectionId = collectionId;
      renderSelectedPage();
    },
    { flush: shouldFlush }
  );
}

async function openPage(pageId, { skipFlush = false, requestedPageMode = null } = {}) {
  const navigationGeneration = ++workspaceNavigationGeneration;
  const shouldFlush = !skipFlush || state.pageEditLockDepth === 0;
  return withPageEditLock(
    async () => {
      if (!isCurrentWorkspaceNavigation(navigationGeneration)) return;
      const preserveMode = state.workspaceView === "page" && state.selectedPage?.id === pageId;
      const summary = state.allPages.find((page) => page.id === pageId);
      if (isCollectionPage(summary)) {
        await showCollection(pageId, { skipFlush: true, navigationGeneration });
        if (isCurrentWorkspaceNavigation(navigationGeneration)) setStatus(t("status.collectionOpened"));
        return;
      }

      setStatus(t("status.loadingDocument"));
      let data;
      try {
        data = await api(`/api/pages/${pageId}`);
      } catch (error) {
        if (!isCurrentWorkspaceNavigation(navigationGeneration)) return;
        throw error;
      }
      if (!isCurrentWorkspaceNavigation(navigationGeneration)) return;

      if (isCollectionPage(data.page)) {
        await showCollection(pageId, { skipFlush: true, navigationGeneration });
        if (isCurrentWorkspaceNavigation(navigationGeneration)) setStatus(t("status.collectionOpened"));
        return;
      }

      await destroyPageCollaboration({ flush: false });
      if (!isCurrentWorkspaceNavigation(navigationGeneration)) return;
      closeSharePageDialog({ restoreFocus: false });
      const normalizedRequestedPageMode = requestedPageMode === pageModes.WRITE
        ? pageModes.WRITE
        : requestedPageMode === pageModes.READ
          ? pageModes.READ
          : null;
      if (!preserveMode) {
        state.pageMode = normalizedRequestedPageMode ?? pageModes.READ;
        state.pendingFocusBlockId = null;
      } else if (normalizedRequestedPageMode) {
        state.pageMode = normalizedRequestedPageMode;
      }

      resetPageEditTracking();
      const recovery = isCollaborativePage(data.page)
        ? { title: null, blocks: [], blockOrder: null }
        : applyPersistedPageDraft(data.page);
      if (!preserveMode && (recovery.title || recovery.blocks.length > 0 || recovery.blockOrder)) {
        state.pageMode = pageModes.WRITE;
      }
      state.selectedPage = data.page;
      state.workspaceView = "page";
      state.activeCollectionId = null;
      if (recovery.title) applyPageSummaryUpdate(data.page.id, { title: data.page.title });
      renderSelectedPage();
      if (isCollaborativePage(data.page)) {
        await startPageCollaboration(data.page);
        if (isCurrentWorkspaceNavigation(navigationGeneration)) setStatus(t("status.documentOpened"));
      } else if (
        isCurrentWorkspaceNavigation(navigationGeneration)
          && !activatePersistedPageDraft(recovery)
      ) {
        setStatus(t("status.documentOpened"));
      }
    },
    { flush: shouldFlush }
  );
}

async function boot() {
  applyDocumentTranslations();
  populateLanguageSelect(elements.languageSelect);
  populateLoginHistoryMonths();
  populateBlockHistoryMonths();
  populateCountryLoginCountryOptions();
  renderLoginHistory();
  renderBlockHistory();
  renderCountryLoginPolicy();
  setAuthMode(state.authMode, false);

  const operation = beginAuthFlowOperation();
  const isCurrent = () => isCurrentAuthFlowOperation(operation);
  const result = await restoreSessionAtBoot(state, {
    loadUser: loadMe,
    isCurrent,
    initializeAuthenticatedUi: async () => {
      if (!isCurrent()) return;
      applyUserTheme();
      await applyUserPreferredLanguage();
    },
    loadWorkspace: async () => {
      const [pages] = await Promise.all([fetchAllPageSummaries(), loadNavigationPreferences()]);
      if (!isCurrent()) return;
      state.searchQuery = "";
      state.activeTag = "";
      state.pages = pages;
      state.allPages = pages;
    }
  });

  if (!isCurrent() || result.outcome === "superseded") {
    renderShell();
    return;
  }

  if (result.outcome === "ready") {
    renderPages();
    await restoreWorkspaceLocationFromHash({ fallbackToHome: true });
    if (!isCurrent()) return;
    renderShell();
    setStatus(t("status.ready"));
    return;
  }

  if (result.outcome === "workspace-unavailable") {
    renderShell();
    setStatus(result.error?.message ?? t("errors.unknown"), true);
    return;
  }

  resetAuthenticationSessionState();
  if (result.outcome === "unauthenticated") {
    setStatus(result.error?.message ?? t("status.loginRequired"), Boolean(result.error));
    return;
  }
  setStatus(result.error?.message ?? t("errors.unknown"), true);
}

async function openHomeFromBrand() {
  if (!state.user) return;
  closeMobileSidebar({ restoreFocus: false });
  resetSearchDialogState();
  try {
    await flushPendingPageEdits();
    await loadPages("", "");
    await showHome({ skipFlush: true });
    setStatus(t("status.ready"));
  } catch (error) {
    setStatus(error.message, true);
  }
}

elements.homeBrandButton.addEventListener("click", openHomeFromBrand);
elements.sidebarHomeShortcut.addEventListener("click", openHomeFromBrand);
elements.sidebarSearchShortcut.addEventListener("click", openSearchDialog);
elements.sidebarSettingsShortcut.addEventListener("click", () => openAccountSettings("profile"));
elements.mobileHomeBrandButton.addEventListener("click", openHomeFromBrand);
elements.mobileSidebarToggle.addEventListener("click", toggleMobileSidebar);
elements.mobileSidebarClose.addEventListener("click", () => closeMobileSidebar({ restoreFocus: true }));
elements.mobileSidebarBackdrop.addEventListener("click", () => closeMobileSidebar({ restoreFocus: true }));
document.addEventListener("keydown", handleMobileSidebarKeydown);
mobileSidebarMedia.addEventListener("change", () => {
  suppressMobileSidebarTransition();
  closeMobileSidebar();
});

elements.pagePath.addEventListener("click", async (event) => {
  const target = event.target.closest("button[data-page-path-id]");
  if (!target) return;

  closePageActionsMenu();
  try {
    if (target.dataset.pagePathKind === "collection") {
      await showCollection(target.dataset.pagePathId);
      setStatus(t("status.collectionOpened"));
      return;
    }
    await openPage(target.dataset.pagePathId);
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.pageIconButton.addEventListener("click", () => {
  if (!requireWritablePage()) return;
  openPageEmojiPicker(state.selectedPage, elements.pageIconButton);
});

elements.collectionIconButton.addEventListener("click", () => {
  if (state.activeCollectionId === defaultCollectionKey) {
    openEmojiPicker(
      {
        type: "defaultCollection",
        currentEmoji: getDefaultCollectionEmoji(),
        defaultEmoji: "📁",
        isCollection: true
      },
      elements.collectionIconButton
    );
    return;
  }

  const collection = state.allPages.find((page) => page.id === state.activeCollectionId && isCollectionPage(page));
  openPageEmojiPicker(collection, elements.collectionIconButton);
});

function handleEmojiOptionClick(event) {
  const iconButton = event.target.closest("[data-icon-name]");
  if (iconButton) {
    if (!state.emojiSaving && iconRecordByName.has(iconButton.dataset.iconName)) {
      void saveEmojiSelection(`${builtInIconPrefix}${iconButton.dataset.iconName}`);
    }
    return;
  }

  const emojiButton = event.target.closest("[data-emoji-index]");
  if (!emojiButton) return;
  const record = emojiRecords[Number(emojiButton.dataset.emojiIndex)];
  if (record) void saveEmojiSelection(record[0]);
}

async function removeCustomIconLibraryItem(index) {
  if (state.emojiSaving) return;
  const entry = state.customIconLibrary[index];
  const userId = state.user?.id;
  if (!entry?.value || !userId || state.customIconLibraryRemovingValues.has(entry.value)) return;

  if (!globalThis.confirm(t("emoji.customLibraryRemoveConfirm"))) return;

  // Invalidate any older refresh so a stale GET cannot reinsert the item after removal.
  customIconLibraryLoadGeneration += 1;
  state.customIconLibraryRemovingValues.add(entry.value);
  renderCustomIconLibrary();
  try {
    const result = await removeCustomIconLibraryEntry(userId, entry.value);
    if (state.user?.id !== userId) return;
    if (typeof result?.removedKey === "string") state.customIconLibraryRemovedKeys.add(result.removedKey);
    state.customIconLibrary = state.customIconLibrary.filter((candidate) => candidate.value !== entry.value);
    setCustomIconMessage(t("emoji.customLibraryRemoved"));
  } catch (error) {
    setCustomIconMessage(error?.message ?? t("emoji.customLibraryRemoveError"), true);
  } finally {
    state.customIconLibraryRemovingValues.delete(entry.value);
    if (state.activeIconPickerTab === "custom") renderCustomIconLibrary();
  }
}

function handleCustomIconLibraryClick(event) {
  const removeButton = event.target.closest("[data-custom-icon-remove-index]");
  if (removeButton) {
    event.preventDefault();
    event.stopPropagation();
    void removeCustomIconLibraryItem(Number(removeButton.dataset.customIconRemoveIndex));
    return;
  }

  if (state.emojiSaving) return;
  const button = event.target.closest("[data-custom-icon-index]");
  if (!button) return;

  const index = Number(button.dataset.customIconIndex);
  const entry = state.customIconLibrary[index];
  if (!entry?.value || !getCustomImageSource(entry.value)) return;

  setCustomIconMessage();
  renderCustomIconPreview(entry.value);
  void saveEmojiSelection(entry.value);
}

function handleIconPickerTabKeydown(event) {
  const currentTab = event.target.closest("[data-icon-picker-tab]");
  if (!currentTab) return;
  const tabs = [elements.emojiTabEmojis, elements.emojiTabIcons, elements.emojiTabCustom];
  const currentIndex = tabs.indexOf(currentTab);
  let nextIndex = currentIndex;

  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabs.length - 1;
  else return;

  event.preventDefault();
  const nextTab = tabs[nextIndex];
  setIconPickerTab(nextTab.dataset.iconPickerTab, { focus: false });
  nextTab.focus();
}

async function applyCustomIconUrl() {
  if (state.emojiSaving) return;
  const value = normalizeCustomIconUrl(elements.emojiCustomUrlInput.value);
  if (!value) {
    setCustomIconMessage(t("emoji.customInvalidUrl"), true);
    elements.emojiCustomUrlInput.focus();
    return;
  }
  setCustomIconMessage();
  renderCustomIconPreview(value);
  await saveEmojiSelection(value);
}

async function applyCustomIconFile(file) {
  if (state.emojiSaving || !file) return;
  if (!isSupportedCustomIconFile(file)) {
    setCustomIconMessage(t("emoji.customInvalidFile"), true);
    return;
  }
  if (file.size > customIconMaxBytes) {
    setCustomIconMessage(t("emoji.customTooLarge"), true);
    return;
  }

  const targetKey = getIconPickerTargetKey(state.emojiPickerTarget);
  const operation = iconPickerOperationGuard.begin(targetKey);
  try {
    setCustomIconMessage(t("emoji.customReading"));
    if (!(await validateCustomIconFileContents(file))) throw new Error("INVALID_CUSTOM_ICON_FILE");
    if (!iconPickerOperationGuard.isCurrent(operation, getIconPickerTargetKey(state.emojiPickerTarget))) return;
    const value = await uploadCustomIconFile(file);
    if (!iconPickerOperationGuard.isCurrent(operation, getIconPickerTargetKey(state.emojiPickerTarget))) return;
    renderCustomIconPreview(value);
    setCustomIconMessage();
    await saveEmojiSelection(value, { operation });
  } catch (error) {
    if (iconPickerOperationGuard.isCurrent(operation, getIconPickerTargetKey(state.emojiPickerTarget))) {
      setCustomIconMessage(error?.message === "INVALID_CUSTOM_ICON_FILE" ? t("emoji.customInvalidFile") : error?.message ?? t("emoji.customInvalidFile"), true);
    }
  } finally {
    if (iconPickerOperationGuard.isCurrent(operation, getIconPickerTargetKey(state.emojiPickerTarget))) {
      elements.emojiCustomFileInput.value = "";
    }
  }
}

elements.emojiPickerClose.addEventListener("click", () => closeEmojiPicker());
elements.emojiPickerLayer.addEventListener("click", (event) => {
  if (event.target === elements.emojiPickerLayer) closeEmojiPicker();
});
elements.emojiPicker.addEventListener("click", (event) => {
  if (!event.target.closest(".emoji-skin-tone-control")) hideEmojiSkinToneMenu();
});
elements.emojiPickerTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-icon-picker-tab]");
  if (tab) setIconPickerTab(tab.dataset.iconPickerTab);
});
elements.emojiPickerTabs.addEventListener("keydown", handleIconPickerTabKeydown);
elements.emojiSearchInput.addEventListener("input", () => renderEmojiPickerResults());
elements.emojiRandomButton.addEventListener("click", () => {
  if (!state.emojiPickerResults.length || state.emojiSaving) return;
  const randomIndex = state.emojiPickerResults[Math.floor(Math.random() * state.emojiPickerResults.length)];
  if (state.activeIconPickerTab === "icons") {
    const record = iconRecords[randomIndex];
    if (record) void saveEmojiSelection(`${builtInIconPrefix}${record.name}`);
    return;
  }
  const record = emojiRecords[randomIndex];
  if (record) void saveEmojiSelection(record[0]);
});
elements.emojiSkinToneButton.addEventListener("click", () => {
  const willOpen = elements.emojiSkinToneMenu.classList.contains("hidden");
  elements.emojiSkinToneMenu.classList.toggle("hidden", !willOpen);
  elements.emojiSkinToneButton.setAttribute("aria-expanded", String(willOpen));
});
elements.emojiSkinToneMenu.addEventListener("click", (event) => {
  const button = event.target.closest("[data-emoji-skin-tone]");
  if (!button) return;
  state.emojiSkinTone = emojiSkinToneModifiers.includes(button.dataset.emojiSkinTone)
    ? button.dataset.emojiSkinTone
    : "";
  writeJsonStorage(getUserScopedStorageKey(emojiSkinToneStorageKey), state.emojiSkinTone);
  hideEmojiSkinToneMenu();
  renderEmojiPicker();
  elements.emojiSkinToneButton.focus();
});
elements.emojiCategoryList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-emoji-category]");
  if (!button) return;
  if (state.activeIconPickerTab === "icons") state.activeIconCategory = button.dataset.emojiCategory;
  else state.activeEmojiCategory = button.dataset.emojiCategory;
  elements.emojiSearchInput.value = "";
  renderEmojiPicker();
});
elements.emojiGrid.addEventListener("click", handleEmojiOptionClick);
elements.emojiRecentGrid.addEventListener("click", handleEmojiOptionClick);
elements.emojiGrid.addEventListener("scroll", () => {
  if (elements.emojiGrid.scrollTop + elements.emojiGrid.clientHeight >= elements.emojiGrid.scrollHeight - 180) {
    appendEmojiBatch();
  }
});
elements.emojiCustomLibraryGrid.addEventListener("click", handleCustomIconLibraryClick);
elements.emojiCustomUrlButton.addEventListener("click", () => void applyCustomIconUrl());
elements.emojiCustomUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void applyCustomIconUrl();
  }
});
elements.emojiCustomUploadButton.addEventListener("click", () => {
  if (!state.emojiSaving) elements.emojiCustomFileInput.click();
});
elements.emojiCustomFileInput.addEventListener("change", () => {
  void applyCustomIconFile(elements.emojiCustomFileInput.files?.[0]);
});
elements.emojiResetButton.addEventListener("click", () => {
  if (!state.emojiSaving) void saveEmojiSelection(null);
});
document.addEventListener("keydown", handleEmojiPickerKeydown);
window.addEventListener("resize", () => {
  if (!elements.emojiPickerLayer.classList.contains("hidden")) {
    positionEmojiPicker(state.emojiPickerReturnFocus);
  }
});

elements.accountSettingsTrigger.addEventListener("click", () => openAccountSettings("profile"));
elements.accountSettingsClose.addEventListener("click", () => closeAccountSettings());
elements.accountSettingsBackdrop.addEventListener("click", () => closeAccountSettings());
document.addEventListener("keydown", handleAccountSettingsKeydown);

elements.accountSettingsTabs.forEach((tab) => {
  tab.addEventListener("click", () => setAccountPanel(tab.dataset.accountPanel));
  tab.addEventListener("keydown", handleAccountTabKeydown);
});

elements.accountSecurityTabs.forEach((tab) => {
  tab.addEventListener("click", () => setSecurityPanel(tab.dataset.securityPanel));
  tab.addEventListener("keydown", handleSecurityTabKeydown);
});

elements.accountActiveSessionsRefresh.addEventListener("click", () => {
  state.activeSessions.loaded = false;
  void loadActiveSessions({ force: true });
});

elements.accountActiveSessionsBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-revoke-session]");
  if (!button) return;
  void revokeActiveSession(button.dataset.revokeSession);
});

elements.accountLoginHistoryMonths.addEventListener("change", () => {
  state.loginHistory.loadedMonths = null;
  void loadLoginHistory({ force: true });
});

elements.accountLoginHistoryRefresh.addEventListener("click", () => {
  state.loginHistory.loadedMonths = null;
  void loadLoginHistory({ force: true });
});

elements.accountBlockHistoryMonths.addEventListener("change", () => {
  state.blockHistory.loadedMonths = null;
  void loadBlockHistory({ force: true });
});

elements.accountBlockHistoryRefresh.addEventListener("click", () => {
  state.blockHistory.loadedMonths = null;
  void loadBlockHistory({ force: true });
});

elements.accountTotpIpBlockEnabled.addEventListener("change", () => {
  state.totpIpBlockPolicy.enabled = elements.accountTotpIpBlockEnabled.value === "true";
  renderTotpIpBlockPolicy();
  setAccountMessage();
});

elements.accountTotpIpBlockThreshold.addEventListener("change", () => {
  state.totpIpBlockPolicy.maxAttempts = Math.min(
    state.totpIpBlockPolicy.maxAllowedAttempts,
    Math.max(
      state.totpIpBlockPolicy.minAttempts,
      normalizeTotpIpBlockAttempts(elements.accountTotpIpBlockThreshold.value, 3)
    )
  );
  renderTotpIpBlockPolicy();
  setAccountMessage();
});

elements.accountTotpIpBlockSave.addEventListener("click", () => {
  void saveTotpIpBlockPolicy();
});

elements.accountTotpIpBlocksRefresh.addEventListener("click", () => {
  state.totpIpBlocks.loaded = false;
  void loadPermanentTotpIpBlocks({ force: true });
});

elements.accountTotpIpBlocksBody.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-unblock-totp-ip]");
  if (!button) return;
  void unblockPermanentTotpIp(button.dataset.unblockTotpIp);
});

elements.accountCountryLoginMode.addEventListener("change", () => {
  state.countryLoginPolicy.mode = normalizeCountryLoginMode(elements.accountCountryLoginMode.value);
  renderCountryLoginPolicy();
  setAccountMessage();
});

elements.accountCountryLoginAdd.addEventListener("click", () => {
  const countryCode = elements.accountCountryLoginCountry.value;
  if (!isoCountryCodes.includes(countryCode) || state.countryLoginPolicy.countries.includes(countryCode)) return;
  state.countryLoginPolicy.countries = [...state.countryLoginPolicy.countries, countryCode]
    .sort((left, right) => getCountryLoginCountryLabel(left).localeCompare(getCountryLoginCountryLabel(right), getLocale()));
  renderCountryLoginPolicy();
  setAccountMessage();
});

elements.accountCountryLoginSelected.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-country-code]");
  if (!button || state.countryLoginPolicy.loading || state.countryLoginPolicy.saving) return;
  state.countryLoginPolicy.countries = state.countryLoginPolicy.countries.filter(
    (countryCode) => countryCode !== button.dataset.countryCode
  );
  renderCountryLoginPolicy();
  setAccountMessage();
});

elements.accountCountryLoginSave.addEventListener("click", () => {
  void saveCountryLoginPolicy();
});

elements.accountVpnBlockEnabled.addEventListener("change", () => {
  state.vpnBlockPolicy.enabled = elements.accountVpnBlockEnabled.value === "true";
  renderVpnBlockPolicy();
  setAccountMessage();
});

elements.accountVpnBlockSave.addEventListener("click", () => {
  void saveVpnBlockPolicy();
});

elements.accountDataExport.addEventListener("click", async () => {
  if (state.accountDataOperationBusy) return;
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey) return;
  const operation = accountDataOperationGuard.begin(targetKey);
  setAccountDataOperationBusy(true);
  try {
    setAccountMessage(t("account.exportingData"));
    const result = await downloadUserDataBackup({ operation });
    if (result?.applied && isCurrentAccountDataOperation(operation)) {
      setAccountMessage(t("account.exportReady"));
    }
  } catch (error) {
    if (isCurrentAccountDataOperation(operation)) setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountDataOperation(operation)) setAccountDataOperationBusy(false);
  }
});

elements.accountDataInput.addEventListener("change", () => {
  const [file] = elements.accountDataInput.files ?? [];
  elements.accountDataFileName.textContent = file?.name || t("account.noBackupSelected");
  syncAccountDataOperationControls();
  setAccountMessage();
});

elements.accountDataImport.addEventListener("click", async () => {
  if (state.accountDataOperationBusy) return;
  const [file] = elements.accountDataInput.files ?? [];
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!file || !targetKey) return;
  if (!window.confirm(t("account.importConfirm"))) return;

  const operation = accountDataOperationGuard.begin(targetKey);
  setAccountDataOperationBusy(true);
  try {
    setAccountMessage(t("account.importingData"));
    const result = await restoreUserDataBackup(file, { operation });
    if (!result?.applied || !isCurrentAccountDataOperation(operation)) return;
    resetDataImportSelection();
    const counts = result.counts;
    const message = t("account.importComplete", {
      pages: formatNumber(counts.pages),
      blocks: formatNumber(counts.blocks),
      attachments: formatNumber(counts.attachments),
      shares: formatNumber(counts.shares ?? 0),
      pageVersions: formatNumber(counts.pageVersions ?? 0),
      navigationCollapsedPages: formatNumber(counts.navigationCollapsedPages ?? 0)
    });
    setAccountMessage(message);
    setStatus(message);
  } catch (error) {
    if (isCurrentAccountDataOperation(operation)) setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountDataOperation(operation)) setAccountDataOperationBusy(false);
  }
});

elements.accountAvatarInput.addEventListener("change", async () => {
  const [file] = elements.accountAvatarInput.files ?? [];
  if (!file) return;
  const targetKey = getAccountAvatarTargetKey(state.user);
  const operation = accountAvatarOperationGuard.begin(targetKey);
  setAccountAvatarPreparing(true);
  try {
    setAccountMessage(t("account.preparingAvatar"));
    const avatarData = await createAvatarDataUrl(file);
    if (
      !state.accountSettingsOpen
      || !accountAvatarOperationGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))
    ) return;
    state.pendingAvatarData = avatarData;
    renderUserAvatar(
      elements.accountAvatarPreview,
      elements.accountAvatarFallback,
      state.pendingAvatarData,
      getUserInitials(state.user)
    );
    elements.accountAvatarRemove.disabled = false;
    setAccountMessage(t("account.avatarReady"));
  } catch (error) {
    if (
      state.accountSettingsOpen
      && accountAvatarOperationGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))
    ) {
      state.pendingAvatarData = state.user?.avatarData ?? null;
      elements.accountAvatarInput.value = "";
      setAccountMessage(error.message, true);
    }
  } finally {
    if (accountAvatarOperationGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))) {
      setAccountAvatarPreparing(false);
    }
  }
});

elements.accountAvatarRemove.addEventListener("click", () => {
  accountAvatarOperationGuard.invalidate();
  state.pendingAvatarData = null;
  setAccountAvatarPreparing(false);
  elements.accountAvatarInput.value = "";
  renderUserAvatar(elements.accountAvatarPreview, elements.accountAvatarFallback, null, getUserInitials(state.user));
  elements.accountAvatarRemove.disabled = true;
  setAccountMessage(t("account.avatarRemoved"));
});

elements.accountProfileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.accountAvatarPreparing || state.accountProfileSaving) return;
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey) return;
  const submittedDraft = Object.freeze({
    targetKey,
    name: elements.accountDisplayName.value.trim() || null,
    avatarData: state.pendingAvatarData
  });
  const operation = accountProfileSaveGuard.begin(targetKey);
  setAccountProfileSaving(true);

  const getCurrentDraft = () => ({
    targetKey: getAccountAvatarTargetKey(state.user),
    name: elements.accountDisplayName.value.trim() || null,
    avatarData: state.pendingAvatarData
  });
  const canReplaceCurrentDraft = () => Boolean(
    state.accountSettingsOpen
      && !state.accountAvatarPreparing
      && accountProfileSaveGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))
      && isAccountProfileDraftUnchanged(submittedDraft, getCurrentDraft())
  );

  try {
    setAccountMessage(t("account.savingProfile"));
    const result = await enqueueAccountProfilePatch(targetKey, {
      name: submittedDraft.name,
      avatarData: submittedDraft.avatarData
    });
    if (!result.applied) return;
    const data = result.value;
    if (!accountProfileSaveGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))) return;
    state.user = data.user;
    updateUserIdentityUi();
    if (canReplaceCurrentDraft()) {
      fillAccountSettings();
      setAccountMessage(t("account.profileSaved"));
    }
    setStatus(t("account.profileSaved"));
  } catch (error) {
    if (!accountProfileSaveGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))) return;
    if (canReplaceCurrentDraft()) setAccountMessage(error.message, true);
    else setStatus(error.message, true);
  } finally {
    if (accountProfileSaveGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))) {
      setAccountProfileSaving(false);
    }
  }
});

elements.accountPasswordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey) return;
  const currentPassword = elements.accountCurrentPassword.value;
  const newPassword = elements.accountNewPassword.value;
  const confirmPassword = elements.accountConfirmPassword.value;
  if (newPassword !== confirmPassword) {
    setAccountMessage(t("account.passwordMismatch"), true);
    elements.accountConfirmPassword.focus();
    return;
  }

  const operation = accountSecurityOperationGuards.password.begin(targetKey);
  elements.accountPasswordSave.disabled = true;
  try {
    setAccountMessage(t("account.changingPassword"));
    await api("/api/auth/password", { method: "POST", body: { currentPassword, newPassword } });
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.password, operation)) return;
    // The server rotated the authentication cookie. Fence every response that began
    // under the previous credential generation, even though the account ID is unchanged.
    acceptRotatedAuthenticationSession();
    elements.accountPasswordForm.reset();
    setAccountMessage(t("account.passwordChanged"));
    setStatus(t("account.passwordChanged"));
  } catch (error) {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.password, operation)) {
      setAccountMessage(error.message, true);
    }
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.password, operation)) {
      elements.accountPasswordSave.disabled = false;
    }
  }
});

elements.accountTotpSetup.addEventListener("click", async () => {
  const targetKey = getAccountAvatarTargetKey(state.user);
  const currentPassword = requireMfaPassword();
  if (!targetKey || !currentPassword) return;
  const operation = accountSecurityOperationGuards.totpSetup.begin(targetKey);
  elements.accountTotpSetup.disabled = true;
  try {
    setAccountMessage(t("mfa.loading"));
    const data = await api("/api/auth/mfa/totp/setup", {
      method: "POST",
      body: { currentPassword }
    });
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpSetup, operation)) return;
    state.totpSetupToken = data.setupToken;
    elements.accountTotpQr.src = data.qrCodeDataUrl;
    elements.accountTotpSecret.textContent = data.secret;
    elements.accountTotpSetupPanel.classList.remove("hidden");
    elements.accountTotpVerifyForm.reset();
    setAccountMessage(t("mfa.totpSetupStarted"));
    window.requestAnimationFrame(() => {
      if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpSetup, operation)) {
        elements.accountTotpCode.focus();
      }
    });
  } catch (error) {
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpSetup, operation)) return;
    hideTotpSetup();
    setAccountMessage(error.message, true);
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpSetup, operation)) {
      elements.accountTotpSetup.disabled = false;
    }
  }
});

elements.accountTotpVerifyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetKey = getAccountAvatarTargetKey(state.user);
  const setupToken = state.totpSetupToken;
  if (!targetKey || !setupToken) {
    setAccountMessage(t("mfa.totpSetupExpired"), true);
    return;
  }
  const operation = accountSecurityOperationGuards.totpVerify.begin(targetKey);
  elements.accountTotpVerify.disabled = true;
  try {
    await api("/api/auth/mfa/totp/verify", {
      method: "POST",
      body: {
        setupToken,
        code: elements.accountTotpCode.value.trim()
      }
    });
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpVerify, operation)) return;
    acceptRotatedAuthenticationSession();
    elements.accountMfaPassword.value = "";
    hideTotpSetup();
    await loadMfaSettings({ showLoading: false });
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpVerify, operation)) {
      setAccountMessage(t("mfa.totpEnabled"));
    }
  } catch (error) {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpVerify, operation)) {
      setAccountMessage(error.message, true);
    }
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpVerify, operation)) {
      elements.accountTotpVerify.disabled = false;
    }
  }
});

elements.accountTotpCancel.addEventListener("click", () => {
  accountSecurityOperationGuards.totpSetup.invalidate();
  accountSecurityOperationGuards.totpVerify.invalidate();
  hideTotpSetup();
  elements.accountTotpSetup.disabled = false;
  elements.accountTotpVerify.disabled = false;
  setAccountMessage();
});

elements.accountTotpDisable.addEventListener("click", async () => {
  if (!window.confirm(t("mfa.disableTotpConfirm"))) return;
  const targetKey = getAccountAvatarTargetKey(state.user);
  const currentPassword = requireMfaPassword();
  if (!targetKey || !currentPassword) return;
  const operation = accountSecurityOperationGuards.totpDisable.begin(targetKey);
  elements.accountTotpDisable.disabled = true;
  try {
    await api("/api/auth/mfa/totp", {
      method: "DELETE",
      body: { currentPassword }
    });
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpDisable, operation)) return;
    acceptRotatedAuthenticationSession();
    elements.accountMfaPassword.value = "";
    hideTotpSetup();
    await loadMfaSettings({ showLoading: false });
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpDisable, operation)) {
      setAccountMessage(t("mfa.totpDisabled"));
    }
  } catch (error) {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpDisable, operation)) {
      setAccountMessage(error.message, true);
    }
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.totpDisable, operation)) {
      elements.accountTotpDisable.disabled = false;
    }
  }
});

elements.accountPasskeyRegisterForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetKey = getAccountAvatarTargetKey(state.user);
  const currentPassword = requireMfaPassword();
  if (!targetKey || !currentPassword) return;
  const name = elements.accountPasskeyName.value.trim();
  const registrationTarget = getPasskeyRegistrationTarget();
  if (!name) {
    setAccountMessage(t("mfa.nameRequired"), true);
    elements.accountPasskeyName.focus();
    return;
  }
  if (!isWebAuthnSupported()) {
    setAccountMessage(t("mfa.passkeyUnsupported"), true);
    return;
  }

  const operation = accountSecurityOperationGuards.passkeyRegister.begin(targetKey);
  setAccountPasskeyRegistering(true);
  try {
    setAccountMessage(t(registrationTarget === "remote" ? "mfa.passkeyAddingRemote" : "mfa.passkeyAdding"));
    const optionsData = await api("/api/auth/mfa/passkeys/options", {
      method: "POST",
      body: { currentPassword, name, registrationTarget }
    });
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.passkeyRegister, operation)) return;
    const response = await createWebAuthnCredential(optionsData.options);
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.passkeyRegister, operation)) return;
    await api("/api/auth/mfa/passkeys", {
      method: "POST",
      body: { challengeToken: optionsData.challengeToken, response }
    });
    if (!isCurrentAccountSecurityOperation(accountSecurityOperationGuards.passkeyRegister, operation)) return;
    acceptRotatedAuthenticationSession();
    elements.accountMfaPassword.value = "";
    elements.accountPasskeyRegisterForm.reset();
    await loadMfaSettings({ showLoading: false });
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.passkeyRegister, operation)) {
      setAccountMessage(t("mfa.passkeyAdded"));
    }
  } catch (error) {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.passkeyRegister, operation)) {
      setAccountMessage(normalizePasskeyRegistrationError(error, registrationTarget).message, true);
    }
  } finally {
    if (isCurrentAccountSecurityOperation(accountSecurityOperationGuards.passkeyRegister, operation)) {
      setAccountPasskeyRegistering(false);
    }
  }
});

elements.accountPasskeyRegistrationTarget.addEventListener("change", () => {
  void refreshPasskeyRegistrationSupport();
});

elements.mfaLoginTotpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.authOperationBusy) return;
  const mfaToken = state.mfaLogin?.token;
  if (!mfaToken) {
    resetMfaLogin({ focus: true });
    setStatus(t("mfa.sessionExpired"), true);
    return;
  }
  const operation = beginAuthFlowOperation();
  setAuthOperationBusy(true);
  try {
    setStatus(t("mfa.verifying"));
    const data = await api("/api/auth/mfa/login/totp", {
      method: "POST",
      body: {
        mfaToken,
        code: elements.mfaLoginCode.value.trim()
      },
      skipAuthReset: true
    });
    if (!isCurrentAuthFlowOperation(operation) || state.mfaLogin?.token !== mfaToken) return;
    await completeAuthenticatedLogin(data);
  } catch (error) {
    if (!isCurrentAuthFlowOperation(operation)) return;
    setStatus(error.message, true);
    elements.mfaLoginCode.select();
  } finally {
    if (isCurrentAuthFlowOperation(operation)) setAuthOperationBusy(false);
  }
});

elements.mfaLoginPasskey.addEventListener("click", async () => {
  if (state.authOperationBusy) return;
  const mfaToken = state.mfaLogin?.token;
  if (!mfaToken) {
    resetMfaLogin({ focus: true });
    setStatus(t("mfa.sessionExpired"), true);
    return;
  }
  const operation = beginAuthFlowOperation();
  setAuthOperationBusy(true);
  try {
    setStatus(t("mfa.passkeyAuthenticating"));
    const optionsData = await api("/api/auth/mfa/login/passkey/options", {
      method: "POST",
      body: { mfaToken },
      skipAuthReset: true
    });
    if (!isCurrentAuthFlowOperation(operation) || state.mfaLogin?.token !== mfaToken) return;
    const response = await getWebAuthnCredential(optionsData.options);
    if (!isCurrentAuthFlowOperation(operation) || state.mfaLogin?.token !== mfaToken) return;
    const data = await api("/api/auth/mfa/login/passkey/verify", {
      method: "POST",
      body: {
        mfaToken,
        challengeToken: optionsData.challengeToken,
        response
      },
      skipAuthReset: true
    });
    if (!isCurrentAuthFlowOperation(operation) || state.mfaLogin?.token !== mfaToken) return;
    await completeAuthenticatedLogin(data);
  } catch (error) {
    if (isCurrentAuthFlowOperation(operation)) {
      setStatus(normalizeWebAuthnError(error).message, true);
    }
  } finally {
    if (isCurrentAuthFlowOperation(operation)) setAuthOperationBusy(false);
  }
});

elements.mfaLoginCancel.addEventListener("click", () => {
  if (state.authOperationBusy) return;
  authFlowOperationGuard.invalidate();
  resetMfaLogin({ focus: true });
  setStatus(t("status.loginPrompt"));
});

elements.authSwitchLink.addEventListener("click", (event) => {
  event.preventDefault();
  if (state.authOperationBusy) return;
  authFlowOperationGuard.invalidate();
  setAuthMode(state.authMode === "register" ? "login" : "register");
  setStatus(t(state.authMode === "register" ? "status.registerPrompt" : "status.loginPrompt"));
  elements.username.focus();
});

window.addEventListener("hashchange", () => {
  if (state.authenticated && state.user) {
    const destination = parseWorkspaceLocation(window.location.hash);
    if (!destination) {
      syncWorkspaceLocation();
      return;
    }
    void restoreWorkspaceLocationFromHash().catch((error) => {
      syncWorkspaceLocation();
      setStatus(error?.message ?? t("errors.unknown"), true);
    });
    return;
  }

  if (state.authOperationBusy) {
    const expectedHash = state.authMode === "register" ? "#signup" : "#login";
    if (window.location.hash !== expectedHash) window.history.replaceState(null, "", expectedHash);
    return;
  }
  authFlowOperationGuard.invalidate();
  if (state.mfaLogin) resetMfaLogin();
  setAuthMode(window.location.hash === "#signup" ? "register" : "login", false);
});

function refreshLocalizedUi() {
  applyDocumentTranslations();
  elements.languageSelect.value = getLanguage();
  if (state.user) elements.themeSelect.value = normalizeTheme(state.user.theme);
  setAuthMode(state.authMode, false);
  renderPages();
  if (!isCollaborativePage()) syncVisibleBlocksToState();
  renderSelectedPage();
  syncPageModeUi();
  if (state.user) updateUserIdentityUi();
  populateLoginHistoryMonths();
  populateBlockHistoryMonths();
  populateCountryLoginCountryOptions();
  if (state.searchDialogOpen) renderSearchDialog();
  if (state.accountSettingsOpen) {
    if (state.activeSecurityPanel === "sessions") renderActiveSessions();
    else if (state.activeSecurityPanel === "history") renderLoginHistory();
    else if (state.activeSecurityPanel === "blocks") renderBlockHistory();
    else {
      renderMfaSettings();
      renderCountryLoginPolicy();
      renderVpnBlockPolicy();
    }
  }
  if (state.mfaLogin?.methods?.passkey) syncAuthOperationControls();
  if (!elements.emojiPickerLayer.classList.contains("hidden")) renderEmojiPicker();

  if (!elements.slashMenu.classList.contains("hidden") && state.activeSlashBlockId) {
    const row = elements.blockList.querySelector(`[data-block-id="${CSS.escape(state.activeSlashBlockId)}"]`);
    const textarea = getBlockTextarea(row);
    if (row) renderSlashMenu(row, textarea ? getSlashContext(textarea)?.query ?? "" : "");
  }
}

elements.languageSelect.addEventListener("change", async () => {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey) return;
  const language = elements.languageSelect.value;
  const operation = accountLanguageOperationGuard.begin(targetKey);

  try {
    setAccountMessage(t("account.savingLanguage"));
    const result = await enqueueAccountProfilePatch(
      targetKey,
      { preferredLanguage: language },
      { before: flushPendingPageEdits }
    );
    if (!result.applied) return;
    const data = result.value;
    state.user = data.user;
    if (!accountLanguageOperationGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))) return;
    const confirmedLanguage = state.user.preferredLanguage ?? language;
    setLanguage(confirmedLanguage);
    elements.languageSelect.value = confirmedLanguage;
    updateUserIdentityUi();
    setAccountMessage(t("status.languageChanged", { language: getLanguageLabel(confirmedLanguage) }));
    setStatus(t("status.languageChanged", { language: getLanguageLabel(confirmedLanguage) }));
  } catch (error) {
    if (!accountLanguageOperationGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))) return;
    const confirmedLanguage = state.user?.preferredLanguage ?? getLanguage();
    setLanguage(confirmedLanguage);
    elements.languageSelect.value = confirmedLanguage;
    setAccountMessage(error.message, true);
  }
});

elements.themeSelect.addEventListener("change", async () => {
  const targetKey = getAccountAvatarTargetKey(state.user);
  if (!targetKey) return;
  const nextTheme = normalizeTheme(elements.themeSelect.value);
  const operation = accountThemeOperationGuard.begin(targetKey);
  applyTheme(nextTheme);

  try {
    setAccountMessage(t("account.savingTheme"));
    const result = await enqueueAccountProfilePatch(targetKey, { theme: nextTheme });
    if (!result.applied) return;
    const data = result.value;
    state.user = data.user;
    if (!accountThemeOperationGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))) return;
    applyUserTheme();
    elements.themeSelect.value = normalizeTheme(state.user.theme);
    setAccountMessage(t("account.themeSaved"));
    setStatus(t("account.themeSaved"));
  } catch (error) {
    if (!accountThemeOperationGuard.isCurrent(operation, getAccountAvatarTargetKey(state.user))) return;
    const confirmedTheme = normalizeTheme(state.user?.theme ?? getActiveTheme());
    applyTheme(confirmedTheme);
    elements.themeSelect.value = confirmedTheme;
    setAccountMessage(error.message, true);
  }
});

window.addEventListener("brainvault:languagechange", refreshLocalizedUi);
window.addEventListener("storage", (event) => {
  if (event.key !== themeStorageKey || !supportedThemes.has(event.newValue)) return;
  const theme = applyTheme(event.newValue, { persist: false });
  if (state.user) state.user.theme = theme;
  if (elements.themeSelect) elements.themeSelect.value = theme;
});

elements.authPasskeyLogin.addEventListener("click", async () => {
  if (state.authOperationBusy || state.authMode !== "login") return;
  const operation = beginAuthFlowOperation();
  setAuthOperationBusy(true);
  try {
    setStatus(t("auth.passkeyAuthenticating"));
    const optionsData = await api("/api/auth/passkey/options", {
      method: "POST",
      body: {},
      skipAuthReset: true
    });
    if (!isCurrentAuthFlowOperation(operation)) return;
    const response = await getWebAuthnCredential(optionsData.options);
    if (!isCurrentAuthFlowOperation(operation)) return;
    const data = await api("/api/auth/passkey/verify", {
      method: "POST",
      body: { challengeToken: optionsData.challengeToken, response },
      skipAuthReset: true
    });
    if (!isCurrentAuthFlowOperation(operation)) return;
    await completeAuthenticatedLogin(data);
  } catch (error) {
    if (isCurrentAuthFlowOperation(operation)) {
      setStatus(normalizeWebAuthnError(error).message, true);
    }
  } finally {
    if (isCurrentAuthFlowOperation(operation)) setAuthOperationBusy(false);
  }
});

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.authOperationBusy) return;
  const operation = beginAuthFlowOperation();
  const mode = state.authMode;
  const body = {
    username: elements.username.value.trim(),
    password: elements.password.value
  };
  if (mode === "register") {
    if (elements.name.value.trim()) body.name = elements.name.value.trim();
    body.preferredLanguage = getLanguage();
  }

  setAuthOperationBusy(true);
  try {
    setStatus(t(mode === "login" ? "status.loggingIn" : "status.registering"));
    const data = await api(`/api/auth/${mode}`, { method: "POST", body });
    if (!isCurrentAuthFlowOperation(operation)) return;
    if (mode === "register") {
      setAuthMode("login");
      elements.username.value = body.username;
      elements.password.value = "";
      setStatus(t("status.loginPrompt"));
      return;
    }
    if (data?.mfaRequired) {
      showMfaLogin(data);
      return;
    }
    await completeAuthenticatedLogin(data);
  } catch (error) {
    if (isCurrentAuthFlowOperation(operation)) setStatus(error.message, true);
  } finally {
    if (isCurrentAuthFlowOperation(operation)) setAuthOperationBusy(false);
  }
});

elements.addCollectionButton.addEventListener("click", async () => {
  try {
    await createCollection();
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.logoutButton.addEventListener("click", () => {
  logout().catch((error) => setStatus(error.message, true));
});



elements.homeNewPageButton.addEventListener("click", async () => {
  try {
    await createUntitledPage();
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void performWorkspaceSearch();
});

elements.searchInput.addEventListener("input", () => {
  resetSearchDialogState({ clearInput: false });
});

elements.searchClear.addEventListener("click", () => {
  resetSearchDialogState();
  elements.searchInput.focus();
});

elements.searchDialogClose.addEventListener("click", () => closeSearchDialog());
elements.searchBackdrop.addEventListener("click", () => closeSearchDialog());
elements.searchResults.addEventListener("click", (event) => {
  const target = event.target.closest("button[data-search-result-index]");
  if (!target) return;
  void openSearchResult(Number.parseInt(target.dataset.searchResultIndex, 10));
});
document.addEventListener("keydown", handleSearchDialogKeydown);

elements.defaultCollectionButton.addEventListener("click", async () => {
  closeMobileSidebar({ restoreFocus: true });
  try {
    resetSearchDialogState();
    await flushPendingPageEdits();
    await loadPages("", "");
    await showCollection(defaultCollectionKey, { skipFlush: true });
    setStatus(t("status.collectionOpened"));
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.addDocumentButton.addEventListener("click", async () => {
  closeMobileSidebar({ restoreFocus: true });
  try {
    await createUntitledPage();
  } catch (error) {
    setStatus(error.message, true);
  }
});


async function handleSidebarPageClick(event) {
  const childrenToggle = event.target.closest("[data-page-children-toggle-id]");
  if (childrenToggle) {
    const pageId = childrenToggle.dataset.pageChildrenToggleId;
    const expanded = childrenToggle.getAttribute("aria-expanded") === "true";
    setNavigationSubpagesExpanded(pageId, !expanded);
    return;
  }

  const item = event.target.closest("[data-page-id], [data-collection-id]");
  if (!item) return;
  closeMobileSidebar({ restoreFocus: true });
  try {
    if (item.dataset.collectionId) {
      resetSearchDialogState();
      await flushPendingPageEdits();
      await loadPages("", "");
      await showCollection(item.dataset.collectionId, { skipFlush: true });
      setStatus(t("status.collectionOpened"));
      return;
    }
    await openPage(item.dataset.pageId);
  } catch (error) {
    setStatus(error.message, true);
  }
}

elements.pageList.addEventListener("click", handleSidebarPageClick);
elements.collectionList.addEventListener("click", handleSidebarPageClick);
elements.collectionViewList.addEventListener("click", handleSidebarPageClick);


elements.appSidebar.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".navigation-more-button");
  if (
    !handle
    || activeNavigationDrag
    || navigationOrderSaving
    || state.searchQuery
    || state.activeTag
    || event.isPrimary === false
  ) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  const node = getNavigationDragNode(handle);
  if (!node || getNavigationSiblingNodes(node).length < 2) return;
  activeNavigationDrag = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    handle,
    node,
    container: node.parentElement,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    initialIndex: -1,
    targetIndex: -1,
    siblingNodes: [],
    candidates: [],
    indicator: null
  };
  handle.classList.add("is-pressed");
  handle.setPointerCapture?.(event.pointerId);
});

elements.appSidebar.addEventListener("pointermove", (event) => {
  updateNavigationDrag(event);
});

elements.appSidebar.addEventListener("pointerup", (event) => {
  finishNavigationDrag(event).catch((error) => setStatus(error.message, true));
});

elements.appSidebar.addEventListener("pointercancel", (event) => {
  finishNavigationDrag(event, { cancelled: true }).catch((error) => setStatus(error.message, true));
});

elements.appSidebar.addEventListener("lostpointercapture", (event) => {
  if (!activeNavigationDrag || activeNavigationDrag.pointerId !== event.pointerId) return;
  finishNavigationDrag(event, { cancelled: true }).catch((error) => setStatus(error.message, true));
});

elements.subpageIndexList.addEventListener("click", async (event) => {
  const item = event.target.closest("[data-subpage-index-page-id]");
  if (!item) return;
  try {
    await openPage(item.dataset.subpageIndexPageId);
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


elements.sharePageButton.addEventListener("click", () => {
  openSharePageDialog().catch((error) => setSharePageMessage(error.message, true));
});

elements.sharePageClose.addEventListener("click", () => closeSharePageDialog());
elements.sharePageBackdrop.addEventListener("click", () => closeSharePageDialog());

elements.sharePageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedPage || !isPageOwner()) return;
  const username = elements.sharePageUsername.value.trim();
  if (!username) return;
  elements.sharePageSubmit.disabled = true;
  setSharePageMessage(t("sharing.adding"));
  try {
    const pageId = state.selectedPage.id;
    await withPagePersistenceTransition(pageId, "share-add", async () => {
      // The durable page-draft store is shared by same-origin tabs. Recheck it
      // immediately before changing persistence modes so another tab's direct-edit
      // recovery copy cannot become invisible behind the collaboration editor.
      await flushPendingPageEdits({ allowLocked: true });
      assertNoPendingLocalPageDrafts(pageId);
      const data = await api(`/api/pages/${encodeURIComponent(pageId)}/shares`, {
        method: "POST",
        body: { username }
      });
      if (state.selectedPage?.id !== pageId) return;
      state.sharePageEntries.push(data.share);
      elements.sharePageForm.reset();
      renderSharePageList();
      await setSelectedPageShareCount(Number(data.count ?? state.sharePageEntries.length));
      setSharePageMessage(t("sharing.added", { username: data.share?.user?.username ?? username }));
    });
  } catch (error) {
    setSharePageMessage(error.message, true);
  } finally {
    elements.sharePageSubmit.disabled = false;
    elements.sharePageUsername.focus();
  }
});

elements.sharePageList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-user-id]");
  if (!button || !state.selectedPage || !isPageOwner()) return;
  const pageId = state.selectedPage.id;
  const userId = button.dataset.userId;
  const username = button.dataset.username || "";
  button.disabled = true;
  setSharePageMessage(t("sharing.removing", { username }));
  try {
    await withPagePersistenceTransition(pageId, "share-remove", async () => {
      // A recovery record from this or another same-origin tab represents a Yjs
      // state that has not been acknowledged by the server. Never remove access
      // while one is present; final removal would make that state unreachable.
      await flushPendingPageEdits({ allowLocked: true, collaborationCompact: false });
      assertNoPendingLocalCollaborationRecovery(pageId);
      if (state.sharePageEntries.length === 1) {
        if (state.collaborationSession) await destroyPageCollaboration({ flush: false });
        // Closing the current session is asynchronous. Check once more before the
        // destructive request so a concurrent tab update cannot slip past the guard.
        assertNoPendingLocalCollaborationRecovery(pageId);
      }
      const data = await api(
        `/api/pages/${encodeURIComponent(pageId)}/shares/${encodeURIComponent(userId)}`,
        { method: "DELETE" }
      );
      if (state.selectedPage?.id !== pageId) return;
      state.sharePageEntries = state.sharePageEntries.filter((share) => share.user?.id !== userId);
      renderSharePageList();
      await setSelectedPageShareCount(Number(data.count ?? state.sharePageEntries.length));
      setSharePageMessage(t("sharing.removed", { username }));
    });
  } catch (error) {
    button.disabled = false;
    if (isCollaborativePage() && !state.collaborationSession) {
      void startPageCollaboration(state.selectedPage);
    }
    setSharePageMessage(error.message, true);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.sharePageOpen) {
    event.preventDefault();
    closeSharePageDialog();
  }
});


elements.pageCoverAddButton.addEventListener("click", openPageCoverDialog);
elements.pageCoverChangeButton.addEventListener("click", openPageCoverDialog);
elements.pageCoverDialogClose.addEventListener("click", closePageCoverDialog);
elements.pageCoverDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePageCoverDialog();
});
elements.pageCoverDialog.addEventListener("click", (event) => {
  if (event.target === elements.pageCoverDialog) closePageCoverDialog();
});

elements.pageCoverDialog.querySelector(".page-cover-default-grid").addEventListener("click", async (event) => {
  const option = event.target.closest("button[data-cover-url]");
  if (!option || pageCoverSaving) return;
  const coverUrl = option.dataset.coverUrl;
  if (!defaultPageCoverPaths.includes(coverUrl)) return;
  try {
    setStatus(t("cover.applying"));
    const updated = await persistPageCover(
      { coverUrl, coverPositionX: 50, coverPositionY: 50 },
      "cover.applied"
    );
    if (updated) closePageCoverDialog();
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.pageCoverCustomButton.addEventListener("click", () => {
  if (!requireWritablePage() || !isPageOwner() || pageCoverSaving) return;
  elements.pageCoverCustomInput.click();
});

elements.pageCoverCustomInput.addEventListener("change", async () => {
  const file = elements.pageCoverCustomInput.files?.[0] ?? null;
  elements.pageCoverCustomInput.value = "";
  const pageId = state.selectedPage?.id ?? null;
  if (!file || !pageId || pageCoverSaving) return;
  const operation = pageCoverOperationGuard.begin(pageId);
  try {
    setStatus(t("cover.preparing"));
    const coverUrl = await prepareCustomCoverDataUrl(file);
    if (!pageCoverOperationGuard.isCurrent(operation, state.selectedPage?.id)) return;
    setStatus(t("cover.applying"));
    const updated = await persistPageCover(
      { coverUrl, coverPositionX: 50, coverPositionY: 50 },
      "cover.customApplied",
      { operation }
    );
    if (updated) closePageCoverDialog();
  } catch (error) {
    if (pageCoverOperationGuard.isCurrent(operation, state.selectedPage?.id)) {
      setStatus(error.message, true);
    }
  }
});

elements.pageCoverRemoveButton.addEventListener("click", async () => {
  if (!window.confirm(t("cover.removeConfirm"))) return;
  closePageCoverPositionEditor();
  try {
    await persistPageCover(
      { coverUrl: null, coverPositionX: 50, coverPositionY: 50 },
      "cover.removed"
    );
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.pageCoverPositionButton.addEventListener("click", () => {
  if (!requireWritablePage() || !isPageOwner() || !state.selectedPage?.coverUrl) return;
  pageCoverPositionDraft = {
    pageId: state.selectedPage.id,
    x: clampPageCoverPosition(state.selectedPage.coverPositionX ?? 50),
    y: clampPageCoverPosition(state.selectedPage.coverPositionY ?? 50)
  };
  elements.pageCover.classList.add("is-repositioning");
  elements.pageCoverPositionPanel.classList.remove("hidden");
  elements.pageCoverPositionButton.setAttribute("aria-expanded", "true");
  setPageCoverPreviewPosition(pageCoverPositionDraft.x, pageCoverPositionDraft.y);
  elements.pageCoverPositionY.focus();
});

for (const slider of [elements.pageCoverPositionX, elements.pageCoverPositionY]) {
  slider.addEventListener("input", () => {
    setPageCoverPreviewPosition(elements.pageCoverPositionX.value, elements.pageCoverPositionY.value);
  });
}

elements.pageCoverPositionCancel.addEventListener("click", () => {
  closePageCoverPositionEditor({ restore: true });
  elements.pageCoverPositionButton.focus();
});

elements.pageCoverPositionSave.addEventListener("click", async () => {
  if (!pageCoverPositionDraft) return;
  const draft = pageCoverPositionDraft;
  if (!isPageCoverPositionDraftForPage(draft, state.selectedPage?.id)) {
    closePageCoverPositionEditor();
    return;
  }
  const { x, y } = draft;
  closePageCoverPositionEditor();
  try {
    await persistPageCover(
      { coverPositionX: x, coverPositionY: y },
      "cover.positionSaved"
    );
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.pageCoverImage.addEventListener("pointerdown", (event) => {
  if (!pageCoverPositionDraft || event.isPrimary === false) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  pageCoverDragPointerId = event.pointerId;
  elements.pageCoverImage.setPointerCapture(event.pointerId);
  updatePageCoverPositionFromPointer(event);
});
elements.pageCoverImage.addEventListener("pointermove", updatePageCoverPositionFromPointer);
function finishPageCoverPointerDrag(event, { update = false } = {}) {
  if (event.pointerId !== pageCoverDragPointerId) return;
  if (update) updatePageCoverPositionFromPointer(event);
  pageCoverDragPointerId = null;
  if (elements.pageCoverImage.hasPointerCapture(event.pointerId)) {
    elements.pageCoverImage.releasePointerCapture(event.pointerId);
  }
}
elements.pageCoverImage.addEventListener("pointerup", (event) => {
  finishPageCoverPointerDrag(event, { update: true });
});
elements.pageCoverImage.addEventListener("pointercancel", (event) => {
  finishPageCoverPointerDrag(event);
});

elements.pageTitle.addEventListener("input", (event) => {
  if (!requireWritablePage({ announce: false })) return;
  schedulePageTitleSave({ allowConflictPrompt: !event.isComposing });
  updateCollaborationAwareness(elements.pageTitle);
  scheduleRemoteCollaborationCaretRender();
});

elements.pageTitle.addEventListener("blur", () => {
  if (!requireWritablePage({ announce: false })) return;
  if (!elements.pageTitle.value.trim()) elements.pageTitle.value = t("newDocumentTitle");
  savePageTitleNow().catch((error) => setStatus(error.message, true));
  window.setTimeout(() => updateCollaborationAwareness(document.activeElement));
});

elements.pageTitle.addEventListener("focus", () => updateCollaborationAwareness(elements.pageTitle));
elements.pageTitle.addEventListener("keyup", () => updateCollaborationAwareness(elements.pageTitle));
elements.pageTitle.addEventListener("mouseup", () => updateCollaborationAwareness(elements.pageTitle));

elements.pageModeToggle.addEventListener("click", async () => {
  const nextMode = isPageReadOnly() ? pageModes.WRITE : pageModes.READ;
  closePageActionsMenu({ restoreFocus: false });
  try {
    await setPageMode(nextMode);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    elements.pageActionsButton.focus();
  }
});

elements.pageVersionHistoryButton.addEventListener("click", () => {
  if (!isPageOwner()) return;
  openPageVersionHistory();
});

elements.pageVersionHistoryClose.addEventListener("click", () => {
  closePageVersionHistory();
});

elements.pageVersionHistoryReset.addEventListener("click", () => {
  void resetPageVersionHistory();
});

elements.pageVersionHistoryMore.addEventListener("click", () => {
  if (!state.pageVersionHistory.loading && state.pageVersionHistory.nextCursor) {
    void loadPageVersionHistory({ append: true });
  }
});

elements.pageVersionHistoryList.addEventListener("click", (event) => {
  const item = event.target.closest("button[data-version-id]");
  if (!item) return;
  void loadPageVersionDetail(item.dataset.versionId);
});

elements.pageVersionHistoryDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePageVersionHistory();
});

elements.pageVersionHistoryDialog.addEventListener("click", (event) => {
  if (event.target === elements.pageVersionHistoryDialog) closePageVersionHistory();
});

elements.pageVersionHistoryDialog.addEventListener("close", () => {
  state.pageVersionHistory.requestId += 1;
  state.pageVersionHistory.detailRequestId += 1;
  state.pageVersionHistory.resetting = false;
  state.pageVersionHistory.pageId = null;
});

elements.exportPdfButton.addEventListener("click", () => {
  closePageActionsMenu({ restoreFocus: true });
  exportCurrentPageToPdf().catch((error) => {
    console.error("PDF export failed", error);
    clearPdfExportLayout();
    elements.exportPdfButton.disabled = false;
    setStatus(t("errors.pdfExportFailed"), true);
  });
});

elements.savePageButton.addEventListener("click", async () => {
  if (!requireWritablePage()) return;
  if (hasUnresolvedDraftConflicts()) {
    reportUnresolvedDraftConflict();
    return;
  }
  try {
    await withPageEditLock(async () => {
      await loadPages(elements.searchInput.value.trim(), state.activeTag);
      renderSelectedPage();
      setStatus(t("status.pageSaved"));
    });
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.archivePageButton.addEventListener("click", async () => {
  if (!requireWritablePage()) return;
  if (hasUnresolvedDraftConflicts()) {
    reportUnresolvedDraftConflict();
    return;
  }
  closePageActionsMenu({ restoreFocus: true });
  const ok = window.confirm(t("confirm.archivePage"));
  if (!ok) return;
  const pageId = state.selectedPage.id;
  const parentCollectionId = getCollectionRootId(pageId) ?? defaultCollectionKey;
  try {
    await withPageEditLock(async () => {
      await withPagePersistenceTransition(pageId, "page-archive", async () => {
        // Archiving disconnects every collaborator and makes the page unavailable
        // to them. Do not create an orphaned local Yjs state in another tab.
        await flushPendingPageEdits({ allowLocked: true, collaborationCompact: false });
        assertNoPendingLocalPageDrafts(pageId, "status.destructiveLocalDraftsPending");
        assertNoPendingLocalCollaborationRecovery(pageId);
        await api(`/api/pages/${pageId}`, {
          method: "PATCH",
          body: { isArchived: true, expectedVersion: state.selectedPage.version }
        });
      });
      resetPageEditTracking();
      state.selectedPage = null;
      state.workspaceView = "collection";
      state.activeCollectionId = parentCollectionId;
      await loadPages(elements.searchInput.value.trim(), state.activeTag);
      renderSelectedPage();
      setStatus(t("status.pageArchived"));
    });
  } catch (error) {
    setStatus(error.message, true);
  }
});

for (const eventName of ["focusin", "input", "keyup", "mouseup", "change"]) {
  elements.blockList.addEventListener(eventName, (event) => {
    if (!isCollaborativePage()) return;
    updateCollaborationAwareness(event.target);
    scheduleRemoteCollaborationCaretRender();
  });
}

window.addEventListener("resize", scheduleRemoteCollaborationCaretRender);
document.addEventListener("scroll", scheduleRemoteCollaborationCaretRender, true);
window.visualViewport?.addEventListener("resize", scheduleRemoteCollaborationCaretRender);
window.visualViewport?.addEventListener("scroll", scheduleRemoteCollaborationCaretRender);

document.addEventListener("selectionchange", () => {
  if (!isCollaborativePage()) return;
  const active = document.activeElement;
  if (active !== elements.pageTitle && !elements.blockList.contains(active)) return;
  updateCollaborationAwareness(active);
  scheduleRemoteCollaborationCaretRender();
});

elements.blockList.addEventListener("focusout", () => {
  if (!isCollaborativePage()) return;
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active !== elements.pageTitle && !elements.blockList.contains(active)) updateCollaborationAwareness(active);
  });
});

elements.blockList.addEventListener("pointerdown", (event) => {
  if (!requireWritablePage({ announce: false })) return;
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

elements.blockList.addEventListener("pointerdown", (event) => {
  if (!requireWritablePage({ announce: false })) return;
  const handle = event.target.closest(".kanban-column-menu");
  if (!handle || activeKanbanColumnDrag || event.isPrimary === false) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  const column = handle.closest(".kanban-column");
  const row = getBlockRow(column);
  const board = column?.parentElement;
  const scroller = board?.closest(".kanban-board-scroll");
  if (
    !column?.dataset.columnId
    || !row
    || row.dataset.blockType !== "KANBAN"
    || !board?.classList.contains("kanban-board")
    || getKanbanColumns(row).length < 2
  ) return;

  activeKanbanColumnDrag = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    handle,
    row,
    column,
    board,
    scroller,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    initialIndex: -1,
    targetIndex: -1,
    columns: [],
    candidates: [],
    indicator: null
  };
  handle.classList.add("is-pressed");
  handle.setPointerCapture?.(event.pointerId);
});

elements.blockList.addEventListener("pointermove", (event) => {
  updateKanbanColumnDrag(event);
});

elements.blockList.addEventListener("pointerup", (event) => {
  finishKanbanColumnDrag(event);
});

elements.blockList.addEventListener("pointercancel", (event) => {
  finishKanbanColumnDrag(event, { cancelled: true });
});

elements.blockList.addEventListener("lostpointercapture", (event) => {
  if (!activeKanbanColumnDrag || activeKanbanColumnDrag.pointerId !== event.pointerId) return;
  finishKanbanColumnDrag(event, { cancelled: true });
});

elements.blockList.addEventListener("dragstart", (event) => {
  if (!requireWritablePage({ announce: false })) {
    event.preventDefault();
    return;
  }
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
  if (!requireWritablePage({ announce: false })) {
    event.preventDefault();
    return;
  }
  const textarea = event.target.closest('textarea[name="markdown"]');
  if (!textarea || event.inputType !== "deleteContentBackward" || event.isComposing) return;
  const row = getBlockRow(textarea);
  if (!row || row.dataset.deleting === "true" || !isBlockMarkdownEmpty(row, textarea)) return;

  event.preventDefault();
  deleteEmptyBlock(row).catch((error) => {
    row.dataset.deleting = "false";
    setStatus(error.message, true);
  });
});

elements.blockList.addEventListener("input", (event) => {
  if (!requireWritablePage({ announce: false })) return;
  const toggleTitle = event.target.closest(".toggle-title-input");
  if (toggleTitle) {
    const row = getBlockRow(toggleTitle);
    if (row) scheduleBlockSave(row, { allowConflictPrompt: !event.isComposing });
    return;
  }

  const bookmarkTitle = event.target.closest(".bookmark-title-input");
  if (bookmarkTitle) {
    const row = getBlockRow(bookmarkTitle);
    if (row) scheduleBlockSave(row, { allowConflictPrompt: !event.isComposing });
    return;
  }

  const kanbanField = event.target.closest(
    ".kanban-title-input, .kanban-column-title, .kanban-card-title, .kanban-card-description, .kanban-card-tags, .kanban-card-emoji-input"
  );
  if (kanbanField) {
    if (kanbanField.classList.contains("kanban-card-description")) autoGrowTextarea(kanbanField);
    if (kanbanField.classList.contains("kanban-column-title")) sizeKanbanColumnTitle(kanbanField);
    if (kanbanField.classList.contains("kanban-card-tags")) syncKanbanTagField(kanbanField);
    if (kanbanField.classList.contains("kanban-card-emoji-input")) {
      const preview = kanbanField.closest(".kanban-card-style-menu")?.querySelector(".kanban-card-icon-preview");
      if (preview) preview.textContent = normalizeKanbanIcon(kanbanField.value) || "▦";
    }
    const row = getBlockRow(kanbanField);
    if (row) scheduleBlockSave(row, { allowConflictPrompt: !event.isComposing });
    return;
  }

  const tableCell = event.target.closest(".table-cell-input");
  if (tableCell) {
    const row = getBlockRow(tableCell);
    if (row) scheduleBlockSave(row, { allowConflictPrompt: !event.isComposing });
    return;
  }

  const textarea = event.target.closest('textarea[name="markdown"]');
  if (!textarea) return;
  autoGrowTextarea(textarea);
  updateSlashMenuForTextarea(textarea);
  if (elements.slashMenu.classList.contains("hidden")) updateInlineToolbarForTextarea(textarea);
  const row = getBlockRow(textarea);
  if (row) {
    if (row.dataset.blockType === "MATH") updateMathBlockPreview(row, textarea.value);
    if (row.dataset.blockType === "CODE") updateCodeBlockPreview(row, textarea.value, row.dataset.codeLanguage);
    if (row.dataset.blockType === "VIDEO") updateYouTubeVideoPreview(row, textarea.value);
    scheduleBlockSave(row, { allowConflictPrompt: !event.isComposing });
  }
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
  if (!requireWritablePage()) return;
  const languageSelect = event.target.closest(".code-language-select");
  if (languageSelect) {
    const row = getBlockRow(languageSelect);
    if (!row) return;
    row.dataset.codeLanguage = normalizeCodeLanguage(languageSelect.value);
    updateCodeBlockPreview(row, getBlockTextarea(row)?.value ?? "", row.dataset.codeLanguage);
    scheduleBlockSave(row);
    return;
  }

  const bookmarkColumns = event.target.closest(".bookmark-list-columns-select");
  if (bookmarkColumns) {
    const row = getBlockRow(bookmarkColumns);
    if (!row) return;
    setBookmarkListColumns(row, bookmarkColumns.value).catch((error) => setStatus(error.message, true));
    return;
  }

  const checkbox = event.target.closest('input[name="checked"]');
  if (!checkbox) return;
  const row = getBlockRow(checkbox);
  if (row) {
    if (!markBlockDirty(row)) return;
    saveBlockRow(row).catch((error) => setStatus(error.message, true));
  }
});

async function handleListBlockEnter(event, textarea, row) {
  const type = row?.dataset.blockType;
  if (!listBlockTypes.has(type) || event.key !== "Enter" || event.shiftKey || event.isComposing) return false;

  const value = textarea.value;
  const selectionStart = textarea.selectionStart ?? value.length;
  const selectionEnd = textarea.selectionEnd ?? selectionStart;
  const lineStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const nextBreak = value.indexOf("\n", selectionEnd);
  const lineEnd = nextBreak < 0 ? value.length : nextBreak;
  const currentLine = value.slice(lineStart, lineEnd);
  const markerPattern = type === "ORDERED_LIST" ? /^\s*(\d+)[.)]\s*/ : /^\s*([-+*])\s*/;
  const markerMatch = currentLine.match(markerPattern);
  const itemContent = currentLine.replace(markerPattern, "").trim();

  // Pressing Enter on an empty list item exits the list through the normal block append path.
  if (!itemContent) {
    if (markerMatch) {
      textarea.setRangeText("", lineStart, lineEnd, "end");
      autoGrowTextarea(textarea);
      scheduleBlockSave(row);
    }
    return false;
  }

  const nextMarker = type === "ORDERED_LIST"
    ? `${Math.max(1, Number.parseInt(markerMatch?.[1] ?? "1", 10) || 1) + 1}. `
    : `${markerMatch?.[1] ?? "-"} `;

  event.preventDefault();
  textarea.setRangeText(`\n${nextMarker}`, selectionStart, selectionEnd, "end");
  autoGrowTextarea(textarea);
  scheduleBlockSave(row);
  return true;
}

elements.blockList.addEventListener("keydown", async (event) => {
  if (!requireWritablePage({ announce: false })) return;
  const toggleTitle = event.target.closest(".toggle-title-input");
  if (toggleTitle) {
    const row = getBlockRow(toggleTitle);
    if (!row) return;
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      setToggleBlockOpen(row, true);
      getBlockTextarea(row)?.focus();
    }
    return;
  }

  const bookmarkInput = event.target.closest(".bookmark-url-input");
  if (bookmarkInput) {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      const bookmarkRow = getBlockRow(bookmarkInput);
      if (!bookmarkRow) return;
      try {
        await addBookmarkToRow(bookmarkRow);
      } catch (error) {
        setStatus(error.message, true);
      }
    }
    return;
  }

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

  if (row.dataset.blockType !== "MATH" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing) {
    const shortcut = event.key.toLowerCase();
    if (shortcut === "b" || shortcut === "i" || (shortcut === "m" && event.shiftKey)) {
      event.preventDefault();
      state.activeInlineBlockId = row.dataset.blockId;
      state.activeInlineSelection = getTextareaSelection(textarea);
      applyInlineFormat(shortcut === "b" ? "bold" : shortcut === "i" ? "italic" : "math-inline");
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

  if (event.key === "Backspace" && !event.isComposing && !event.repeat && isBlockMarkdownEmpty(row, textarea)) {
    event.preventDefault();
    try {
      await deleteEmptyBlock(row);
    } catch (error) {
      row.dataset.deleting = "false";
      setStatus(error.message, true);
    }
    return;
  }

  if (await handleListBlockEnter(event, textarea, row)) return;

  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    try {
      if (row.dataset.draftConflict === "true" && !promoteBlockDraftConflict(row)) return;
      await saveBlockRow(row, { quiet: true });
      await appendBlock(row);
    } catch (error) {
      setStatus(error.message, true);
    }
  }
});

elements.blockList.addEventListener("focusout", (event) => {
  if (!requireWritablePage({ announce: false })) return;
  const toggleTitle = event.target.closest(".toggle-title-input");
  if (toggleTitle) {
    const row = getBlockRow(toggleTitle);
    if (row && !row.contains(event.relatedTarget) && row.dataset.deleting !== "true") {
      saveBlockRow(row, { quiet: true }).catch((error) => setStatus(error.message, true));
    }
    return;
  }

  const bookmarkTitle = event.target.closest(".bookmark-title-input");
  if (bookmarkTitle) {
    const row = getBlockRow(bookmarkTitle);
    if (row && !row.contains(event.relatedTarget) && row.dataset.deleting !== "true") {
      saveBlockRow(row, { quiet: true }).catch((error) => setStatus(error.message, true));
    }
    return;
  }

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
  const downloadButton = event.target.closest('button[data-action="download-attachment"]');
  const renderedToggleSummary = event.target.closest(".rendered-toggle-summary");
  if (isPageReadOnly() && !downloadButton) {
    if (renderedToggleSummary) return;
    if (event.target.closest("button, summary, input, textarea, select")) reportReadOnlyBlocked();
    return;
  }

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
  if (button.classList.contains("kanban-column-menu") && Date.now() < suppressKanbanColumnMenuClickUntil) {
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
      const result = await downloadAttachment(block);
      if (result.applied) {
        setStatus(t("status.attachmentDownloaded", { name: getBlockAttachmentData(block).originalName }));
      }
      return;
    }

    if (button.dataset.action === "toggle-block") {
      setToggleBlockOpen(row, button.getAttribute("aria-expanded") !== "true");
      return;
    }

    if (button.dataset.action.startsWith("bookmark-")) {
      await handleBookmarkAction(row, button);
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
  if (!requireWritablePage()) return;
  const button = event.target.closest("button[data-action]");
  const blockId = state.activeBlockMenuId;
  if (!button || !blockId || !state.selectedPage) return;

  const row = elements.blockList.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
  if (!row) return closeBlockContextMenu();

  try {
    if (button.dataset.action === "change-callout-type") {
      await changeCalloutType(row, button.dataset.calloutType);
      return;
    }

    if (button.dataset.action === "toggle-accordion-order") {
      await changeAccordionOrderVisibility(row);
      return;
    }

    if (button.dataset.action === "insert-block-before" || button.dataset.action === "insert-block-after") {
      const placement = button.dataset.action === "insert-block-before" ? "before" : "after";
      closeBlockContextMenu();
      if (row.dataset.blockType !== "ATTACHMENT") {
        await saveBlockRow(row, { quiet: true, resolveConflict: true });
        if (row.dataset.draftConflict === "true") return;
      }
      await insertBlockRelative(row, placement);
      return;
    }

    if (button.dataset.action === "save-block") {
      closeBlockContextMenu({ restoreFocus: true });
      if (row.dataset.blockType === "ATTACHMENT") {
        setStatus(t("status.attachmentReady"));
        return;
      }
      await saveBlockRow(row, { resolveConflict: true });
      return;
    }

    if (button.dataset.action === "delete-block") {
      if (blockDeletionHasUnresolvedDraftConflict(blockId)) {
        closeBlockContextMenu({ restoreFocus: true });
        reportUnresolvedDraftConflict();
        return;
      }
      const ok = window.confirm(t("confirm.deleteBlock"));
      if (!ok) return;
      closeBlockContextMenu();
      const pageId = state.selectedPage.id;
      await withPageEditLock(async () => {
        row.dataset.deleting = "true";
        discardBlockSave(blockId);
        try {
          await deleteBlockWithVersionCheck(blockId);
        } catch (error) {
          row.dataset.deleting = "false";
          throw error;
        }
        await refreshSelectedPageAfterBlockDeletion(pageId);
        setStatus(t("status.blockDeleted"));
      });
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden" || !hasPendingPageEdits()) return;
  flushPendingPageEdits({ keepalive: true }).catch((error) => setStatus(error.message, true));
});

window.addEventListener("online", () => {
  if (!pendingBlockOrderTask) return;
  retryPendingBlockOrder().catch((error) => setStatus(error.message, true));
});

window.addEventListener("storage", (event) => {
  if (event.key?.startsWith(`${pageTransitionStoragePrefix}:`)) {
    syncPageModeUi();
    const pageId = state.selectedPage?.id;
    const workspaceTransitionId = getPageWorkspaceTransitionId();
    const transitions = [
      pageId ? inspectPageTransitionForUi(pageId) : null,
      workspaceTransitionId ? inspectPageTransitionForUi(workspaceTransitionId) : null
    ]
      .filter((transitionState) => transitionState?.locked)
      .map((transitionState) => transitionState.record ?? { sourceId: null })
      .filter((transition) => transition.sourceId !== pageDraftSourceId);
    const canFlushTransitionPage = Boolean(
      state.selectedPage
      && state.workspaceView === "page"
      && (isCollaborativePage() ? state.collaborationSession : canPersistSelectedPage())
    );
    if (transitions.length && canFlushTransitionPage) {
      flushPendingPageEdits({ allowLocked: true, collaborationCompact: false }).catch((error) =>
        setStatus(error.message, true)
      );
    }
    return;
  }
  if (event.key?.startsWith(`${collaborationRecoveryStoragePrefix}:`)) {
    if (state.workspaceView === "home") void refreshOrphanedCollaborationRecovery();
    return;
  }
  if (!event.key?.startsWith(pageDraftStoragePrefix)) return;
  if (state.workspaceView === "home") renderHome();
  const page = state.selectedPage;
  const selectedPageDraftPrefix = state.user?.id && page?.id
    ? `${pageDraftStoragePrefix}${encodeURIComponent(state.user.id)}:${encodeURIComponent(page.id)}:`
    : null;
  if (selectedPageDraftPrefix && event.key.startsWith(selectedPageDraftPrefix)) {
    refreshCollaborativePageDraftRecovery();
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

elements.pageActionsMenu.addEventListener("keydown", (event) => {
  const items = getPageActionsMenuItems();
  const currentIndex = items.indexOf(document.activeElement);

  if (event.key === "Escape") {
    event.preventDefault();
    closePageActionsMenu({ restoreFocus: true });
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

elements.navigationContextMenu.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  try {
    if (button.dataset.action === "add-navigation-subpage") {
      await createNavigationSubpage();
      return;
    }
    if (button.dataset.action === "delete-navigation-item") await deleteNavigationTarget();
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.navigationContextMenu.addEventListener("keydown", (event) => {
  const items = getNavigationContextMenuItems();
  const currentIndex = items.indexOf(document.activeElement);

  if (event.key === "Escape") {
    event.preventDefault();
    closeNavigationContextMenu({ restoreFocus: true });
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
  if (!requireWritablePage()) return;
  const item = event.target.closest(".slash-menu-item");
  if (!item || !state.activeSlashBlockId) return;
  const row = elements.blockList.querySelector(`[data-block-id="${CSS.escape(state.activeSlashBlockId)}"]`);
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
  if (!requireWritablePage()) return;
  const button = event.target.closest("button[data-format]");
  if (!button) return;
  applyInlineFormat(button.dataset.format, button.dataset.align ?? button.dataset.color ?? "");
});

document.addEventListener("click", (event) => {
  const pageActionsTrigger = event.target.closest("#page-actions-button");
  if (pageActionsTrigger) {
    event.preventDefault();
    openPageActionsMenu({ focusFirst: event.detail === 0 });
    return;
  }

  const navigationMenuTrigger = event.target.closest(".navigation-more-button");
  if (navigationMenuTrigger) {
    event.preventDefault();
    if (Date.now() < suppressNavigationMenuClickUntil) return;
    openNavigationContextMenu(navigationMenuTrigger, { focusFirst: event.detail === 0 });
    return;
  }

  if (!event.target.closest(".kanban-card-style-menu")) closeKanbanCardStyleMenus();

  if (!event.target.closest("#block-context-menu") && !event.target.closest(".block-handle")) {
    closeBlockContextMenu();
  }

  if (!event.target.closest("#navigation-context-menu")) {
    closeNavigationContextMenu();
  }

  if (!event.target.closest("#page-actions-menu")) {
    closePageActionsMenu();
  }

  if (event.target.closest("#slash-menu") || event.target.closest("#inline-toolbar") || event.target.closest(".editor-block-row")) return;
  closeSlashMenu();
  closeInlineToolbar();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;

  if (!elements.pageActionsMenu.classList.contains("hidden")) {
    event.preventDefault();
    closePageActionsMenu({ restoreFocus: true });
    return;
  }

  if (!elements.navigationContextMenu.classList.contains("hidden")) {
    event.preventDefault();
    closeNavigationContextMenu({ restoreFocus: true });
    return;
  }

  if (!elements.blockContextMenu.classList.contains("hidden")) {
    event.preventDefault();
    closeBlockContextMenu({ restoreFocus: true });
  }
});

window.addEventListener("resize", () => {
  closeSlashMenu();
  closeInlineToolbar();
  closeBlockContextMenu();
  closeNavigationContextMenu();
  closePageActionsMenu();
  closeKanbanCardStyleMenus();
});

document.addEventListener("scroll", () => {
  closeNavigationContextMenu();
  closePageActionsMenu();
  closeKanbanCardStyleMenus();
}, { capture: true, passive: true });
window.addEventListener("scroll", () => {
  closeBlockContextMenu();
  closeNavigationContextMenu();
  closePageActionsMenu();
}, { passive: true });

boot();

window.addEventListener("load", () => {
  hydrateMathExpressions(document);
  hydrateAccordionIcons(document);
});
