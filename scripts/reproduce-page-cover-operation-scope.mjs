import {
  createPageCoverOperationGuard,
  isPageCoverPositionDraftForPage
} from "../public/page-cover-operation.js";

const guard = createPageCoverOperationGuard();
const preparation = guard.begin("page-one");

// A native <dialog> cancel closes the picker without invoking a click handler.
// Before the correction, no invalidation occurred on this path.
const vulnerableDialogCancelWouldStillApply = guard.isCurrent(preparation, "page-one");

// The corrected cancel handler routes Escape through closePageCoverDialog().
guard.invalidate();
const fixedDialogCancelWouldStillApply = guard.isCurrent(preparation, "page-one");

const stalePositionDraft = { pageId: "page-one", x: 80, y: 20 };
const currentPageId = "page-two";

// Before the correction, the save path only checked that a draft existed, so
// this stale page-one draft could be submitted while page two was selected.
const vulnerableCrossPagePositionSave = Boolean(stalePositionDraft);
const fixedCrossPagePositionSave = isPageCoverPositionDraftForPage(
  stalePositionDraft,
  currentPageId
);

console.log(JSON.stringify({
  scenario: "page-cover dialog cancellation and cross-page position draft scope",
  vulnerable: {
    dialogCancelWouldStillApply: vulnerableDialogCancelWouldStillApply,
    crossPagePositionSaveAccepted: vulnerableCrossPagePositionSave
  },
  fixed: {
    dialogCancelWouldStillApply: fixedDialogCancelWouldStillApply,
    crossPagePositionSaveAccepted: fixedCrossPagePositionSave
  }
}, null, 2));
