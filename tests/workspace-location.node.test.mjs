import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseWorkspaceLocation,
  serializeWorkspaceLocation
} from "../public/workspace-location.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const indexSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("workspace fragments round-trip page, edit mode, collection, and home destinations", () => {
  const destinations = [
    { view: "home" },
    { view: "page", pageId: "page-123", pageMode: "read" },
    { view: "page", pageId: "page / unicode 한글", pageMode: "write" },
    { view: "collection", collectionId: "collection-123" }
  ];

  for (const destination of destinations) {
    assert.deepEqual(parseWorkspaceLocation(serializeWorkspaceLocation(destination)), destination);
  }
});

test("authentication and unknown fragments never masquerade as workspace destinations", () => {
  assert.equal(parseWorkspaceLocation("#login"), null);
  assert.equal(parseWorkspaceLocation("#signup"), null);
  assert.equal(parseWorkspaceLocation("#something-else"), null);
});

test("page mode defaults safely to read unless write is explicitly requested", () => {
  assert.deepEqual(parseWorkspaceLocation("#page=page-1"), {
    view: "page",
    pageId: "page-1",
    pageMode: "read"
  });
  assert.deepEqual(parseWorkspaceLocation("#page=page-1&mode=unexpected"), {
    view: "page",
    pageId: "page-1",
    pageMode: "read"
  });
});

test("authenticated navigation synchronizes the URL and boot restores it", () => {
  assert.match(appSource, /import \{ parseWorkspaceLocation, serializeWorkspaceLocation \} from "\.\/workspace-location\.js";/);
  assert.match(appSource, /function syncWorkspaceLocation\(\)/);
  assert.match(appSource, /async function restoreWorkspaceLocationFromHash/);
  assert.match(appSource, /await restoreWorkspaceLocationFromHash\(\{ fallbackToHome: true \}\);/);
  assert.match(appSource, /result\.outcome === "ready"[\s\S]*renderPages\(\);[\s\S]*await restoreWorkspaceLocationFromHash\(\{ fallbackToHome: true \}\);[\s\S]*renderShell\(\);/);
  assert.match(appSource, /state\.pageMode = normalizedRequestedPageMode \?\? pageModes\.READ/);
  assert.match(appSource, /function syncPageModeUi\(\) \{\n\s+syncWorkspaceLocation\(\);/);
  assert.match(appSource, /window\.addEventListener\("hashchange", \(\) => \{\n\s+if \(state\.authenticated && state\.user\)/);
});

test("the initial auth shell stays hidden until cookie-session restoration resolves", () => {
  assert.match(indexSource, /<body class="auth-mode boot-mode">/);
  assert.match(stylesSource, /body\.boot-mode \.shell[\s\S]*visibility:\s*hidden;/);
  assert.match(appSource, /document\.body\.classList\.remove\("boot-mode"\);/);
});
