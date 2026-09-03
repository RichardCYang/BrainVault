import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  hydrateDatabaseUrlPreviews,
  normalizeDatabaseData
} from "../public/database-block.js";

const databaseClientSource = readFileSync(new URL("../public/database-block.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const bookmarkSource = readFileSync(new URL("../src/lib/bookmark.ts", import.meta.url), "utf8");
const blockRoutesSource = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8");
const serverAppSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const faviconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlR0y8AAAAASUVORK5CYII=";

test("URL preview hydration changes presentation only and preserves the source database value", async () => {
  const sourceUrl = "https://example.com/path?utm_source=brainvault&item=1#section";
  const database = normalizeDatabaseData({
    title: "Links",
    properties: [
      { id: "title", name: "Name", type: "title", options: [] },
      { id: "link", name: "Link", type: "url", options: [] }
    ],
    rows: [{ id: "row-1", values: { title: "Example", link: sourceUrl } }],
    views: [{
      id: "view-1",
      name: "Table",
      type: "table",
      filters: [],
      sorts: [],
      groupPropertyId: null,
      hiddenPropertyIds: []
    }],
    activeViewId: "view-1"
  });
  const before = JSON.stringify(database);

  const titleElement = { textContent: "example.com" };
  const faviconSlot = {
    child: null,
    replaceChildren(child) { this.child = child ?? null; },
    append(child) { this.child = child ?? null; }
  };
  const preview = {
    dataset: { url: sourceUrl, previewState: "pending" },
    isConnected: true,
    querySelector(selector) {
      if (selector === ".database-url-preview-title") return titleElement;
      if (selector === ".database-url-preview-favicon") return faviconSlot;
      return null;
    }
  };
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, ".database-url-preview[data-url]");
      return [preview];
    }
  };

  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, "img");
      return {
        addEventListener() {}
      };
    }
  };

  let requests = 0;
  try {
    hydrateDatabaseUrlPreviews(root, async (url) => {
      requests += 1;
      assert.equal(url, sourceUrl);
      return {
        title: "Example Page Title",
        faviconUrl: faviconDataUrl
      };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }

  assert.equal(requests, 1);
  assert.equal(preview.dataset.previewState, "loaded");
  assert.equal(titleElement.textContent, "Example Page Title");
  assert.equal(faviconSlot.child?.src, faviconDataUrl);
  assert.equal(faviconSlot.child?.referrerPolicy, "no-referrer");
  assert.equal(database.rows[0].values.link, sourceUrl);
  assert.equal(JSON.stringify(database), before);
  assert.doesNotMatch(JSON.stringify(database), /favicon|Example Page Title/);
});

test("read mode swaps the URL input for a title/favicon link while write mode keeps the input", () => {
  assert.match(databaseClientSource, /urlPreview\.className = "database-url-preview"/);
  assert.match(databaseClientSource, /urlPreview\.target = "_blank"/);
  assert.match(databaseClientSource, /urlPreview\.rel = "noopener noreferrer"/);
  assert.match(databaseClientSource, /urlValue\.append\(control, urlPreview\)/);
  assert.match(databaseClientSource, /if \(urlPreview\) resetDatabaseUrlPreview\(urlPreview, control\.value\)/);

  assert.match(styles, /\.database-url-preview\s*\{[^}]*display:\s*none;/s);
  assert.match(styles, /\.page-view\.is-read-only \.database-url-value > \.database-value-input\s*\{[^}]*display:\s*none;/s);
  assert.match(styles, /\.page-view\.is-read-only \.database-url-preview:not\(\.is-empty\)\s*\{[^}]*display:\s*inline-flex;/s);
});

test("database favicon delivery is compatible with the existing restrictive image CSP", () => {
  assert.match(serverAppSource, /imgSrc:\s*\[[\s\S]*?"data:"/);
  assert.match(databaseClientSource, /databaseUrlPreviewFaviconDataPattern = \/\^data:image\\\//);
  assert.match(bookmarkSource, /return mimeType \? `data:\$\{mimeType\};base64,/);
});

test("read mode reuses the existing secured bookmark preview API without changing save serialization", () => {
  assert.match(appSource, /hydrateDatabaseUrlPreviews\(elements\.pageView, fetchDatabaseUrlPreview\)/);
  assert.match(appSource, /api\("\/api\/bookmarks\/preview"/);
  assert.match(appSource, /body: \{ url, mode: "database-url" \}/);
  assert.match(blockRoutesSource, /req\.body\.mode === "database-url"/);
  assert.match(blockRoutesSource, /fetchDatabaseUrlPreview\(String\(req\.body\.url\)\)/);
  assert.match(bookmarkSource, /fetchHtml\(value, bookmarkLimits\.redirects, deadline\)/);
  assert.match(bookmarkSource, /parseDatabaseUrlDocumentMetadata\(response\.html, response\.url\)/);
  assert.match(bookmarkSource, /createDatabaseFaviconDataUrl/);
  assert.match(databaseClientSource, /return normalizeDatabaseData\(row\?\.querySelector\("\.database-block-editor"\)\?\.databaseData\);/);
  assert.doesNotMatch(databaseClientSource, /databaseData\.(?:preview|favicon|pageTitle)/);
});
