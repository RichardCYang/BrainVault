import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

describe("Navigation collapse persistence", () => {
  it("loads server-side collapse preferences before rendering an authenticated tree", () => {
    expect(client).toContain('async function loadNavigationPreferences()');
    expect(client).toContain('api("/api/auth/navigation-preferences")');
    expect(client).toContain('state.collapsedNavigationPageIds = new Set(data.collapsedPageIds);');
    expect(client).toContain('state.navigationPageOrder = navigationPageOrder;');
    expect(client).toMatch(/Promise\.all\(\[fetchAllPageSummaries\(\), loadNavigationPreferences\(\)\]\)/);
  });

  it("persists every page toggle with keepalive and preserves per-page ordering", () => {
    expect(client).toContain('const navigationPreferenceSaveQueues = new Map();');
    expect(client).toContain('function getNavigationPreferenceSaveQueue(pageId)');
    expect(client).toContain('persistNavigationPreference(pageId, !expanded);');
    expect(client).toContain('method: "PATCH"');
    expect(client).toContain('keepalive: true');
    expect(client).toContain('body: { pageId: task.pageId, collapsed: task.collapsed }');
  });

  it("clears in-memory collapse state and pending writes at authentication boundaries", () => {
    expect(client).toContain('discardNavigationPreferenceSaves();');
    expect(client).toContain('state.collapsedNavigationPageIds = new Set();');
    expect(client).toContain('state.navigationPageOrder = new Map();');
  });
});
