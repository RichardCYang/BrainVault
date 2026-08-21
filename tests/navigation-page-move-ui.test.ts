import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Lossless page move from the sidebar navigation menu", () => {
  it("adds the move action to the existing vertical-three-dot page menu and opens an accessible destination dialog", () => {
    expect(index).toContain('id="navigation-move-page-button"');
    expect(index).toContain('data-action="move-navigation-page"');
    expect(index).toContain('data-i18n="navigationMenu.movePage"');
    expect(index).toContain('id="page-move-dialog"');
    expect(index).toContain('aria-labelledby="page-move-title"');
    expect(index).toContain('id="page-move-page-select"');
    expect(client).toContain('elements.navigationMovePageButton.classList.toggle("hidden", kind !== "page")');
    expect(client).toContain('openPageMoveDialog(target.id, returnFocus);');
    expect(client).toContain('elements.pageMoveDialog.showModal()');
  });

  it("only offers safe parent destinations and prevents client-side hierarchy cycles", () => {
    expect(client).toContain("const subtreeIds = getPageSubtreeIds(sourcePage.id);");
    expect(client).toContain("&& !subtreeIds.has(page.id)");
    expect(client).toContain("&& page.id !== sourcePage.parentPageId");
    expect(client).toContain("&& page.ownerId === sourcePage.ownerId");
    expect(client).toContain("&& !page.isArchived");
    expect(client).toContain("&& !isCollectionPage(page)");
    expect(client).toContain("&& isPageOwner(page)");
  });

  it("changes only the page parent through the existing optimistic/idempotent page mutation path", () => {
    expect(client).toContain('async function submitPageMoveMutation(pageId, targetPageId, expectedVersion, authenticationScope)');
    expect(client).toContain('method: "PATCH"');
    expect(client).toContain("parentPageId: targetPageId");
    expect(client).toContain("expectedVersion,");
    expect(client).toContain("mutationId: task.mutationId");
    expect(client).toContain("submitWithFreshMutationIdOnReuse(task");
    expect(client).toContain("reconciled?.page?.parentPageId === targetPageId");
    expect(client).toContain("applyPageMetadataMutationResult(committedPage, { parentPageId: committedPage.parentPageId ?? null })");
  });

  it("flushes unsaved edits for the moved current page and preserves the page/subpage objects in place", () => {
    expect(client).toContain("await assertWorkspacePersistenceUnlocked();");
    expect(client).toContain("const sourceIsSelected = state.selectedPage?.id === pageId;");
    expect(client).toContain("if (sourceIsSelected && hasUnresolvedDraftConflicts())");
    expect(client).toContain("{ flush: sourceIsSelected }");
    expect(client).toContain("setNavigationSubpagesExpanded(targetPageId, true);");
    expect(client).not.toContain("clonePageForMove");
    expect(client).not.toContain("copyPageForMove");
  });

  it("localizes the requested action and lossless move explanation in Korean", () => {
    expect(i18n).toContain('movePage: "다른 페이지로 이동하기"');
    expect(i18n).toContain('title: "다른 페이지로 이동하기"');
    expect(i18n).toContain('submit: "페이지 이동"');
    expect(i18n).toContain('이 페이지와 모든 하위 페이지를 내용, 블록, 첨부파일, 태그, 공유 데이터, 구조화 데이터를 변경하지 않고');
  });
});
