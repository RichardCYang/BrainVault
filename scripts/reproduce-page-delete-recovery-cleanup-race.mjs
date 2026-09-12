import { createPageDraftStore } from "../public/draft-store.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

const userId = "user-1";
const pageId = "page-1";
const sourceId = "tab-a";

const newerTitle = "recovery written after page delete dispatch";

function writeNewerRecovery(store) {
  store.saveTitle({
    userId,
    pageId,
    sourceId,
    value: newerTitle,
    expectedVersion: 7,
    revision: 1
  });
}

function runScenario(fixed) {
  const storage = new MemoryStorage();
  const store = createPageDraftStore(storage, { sourceId });

  // The destructive boundary has already verified that no local recovery record
  // exists. Capture exactly what the eventual server response is allowed to
  // acknowledge before the DELETE is dispatched.
  const cleanupOrigins = [pageId]
    .map((targetPageId) => store.loadPage(userId, targetPageId, sourceId))
    .filter(Boolean);

  // Simulate a delayed/admitted recovery write landing while the server DELETE
  // is in flight. This record is newer than the destructive intent.
  writeNewerRecovery(store);

  if (!fixed) {
    // Old behavior removed whatever occupied the source key at response time,
    // including a recovery record that did not exist when deletion was sent.
    store.removePages(userId, [pageId], sourceId);
  }
  // Fixed behavior deliberately performs no page-draft cleanup here. The
  // destructive preflight already proved recovery was empty before dispatch,
  // so anything visible now is newer than the delete intent.

  const record = store.loadPage(userId, pageId, sourceId);
  return {
    newerDraftPreserved: record?.title?.value === newerTitle,
    title: record?.title?.value ?? null
  };
}

console.log(JSON.stringify({
  vulnerable: runScenario(false),
  fixed: runScenario(true)
}, null, 2));
