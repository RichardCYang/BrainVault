import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

describe("Collection landing navigation", () => {
  it("keeps the workspace landing behind the desktop and mobile brand controls", () => {
    expect(index).toContain('id="home-brand-button"');
    expect(index).toContain('id="mobile-home-brand-button"');
    expect(client).toContain('state.workspaceView = "home"');
    expect(client).toContain('elements.homeBrandButton.addEventListener("click", openHomeFromBrand)');
    expect(client).toContain('elements.mobileHomeBrandButton.addEventListener("click", openHomeFromBrand)');
  });

  it("renders every collection through the title-and-page-list view", () => {
    expect(index).toContain('id="collection-view" class="collection-view hidden"');
    expect(index).toContain('id="collection-view-title"');
    expect(index).toContain('id="collection-view-list"');
    expect(client).toContain('button.dataset.collectionId = collection.id');
    expect(client).toContain('showCollection(defaultCollectionKey)');
    expect(client).toContain('showCollection(data.page.id)');
    expect(client).toContain('if (isCollectionPage(summary))');
    expect(client).toContain('elements.collectionViewList.addEventListener("click", handleSidebarPageClick)');
    expect(styles).toContain('.collection-view-title');
  });
});
