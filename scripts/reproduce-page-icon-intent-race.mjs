function simulateQueuedEditLockRace({ fixed, invalidateBy }) {
  let navigationGeneration = 10;
  let selectedPageId = "page-A";
  let operationCurrent = true;
  const capturedNavigation = navigationGeneration;
  const capturedPageId = selectedPageId;

  const initialGuardPassed =
    operationCurrent
    && navigationGeneration === capturedNavigation
    && selectedPageId === capturedPageId;

  // saveEmojiSelection() is now queued behind withPageEditLock().
  // The old implementation did not re-check picker/navigation intent when
  // that queue released.
  if (invalidateBy === "picker-close") operationCurrent = false;
  if (invalidateBy === "navigation") navigationGeneration += 1;

  const fixedGuardPassed =
    operationCurrent
    && navigationGeneration === capturedNavigation
    && selectedPageId === capturedPageId;

  return {
    initialGuardPassed,
    requestWouldStart: initialGuardPassed && (fixed ? fixedGuardPassed : true),
    navigationGeneration,
    capturedNavigation,
    operationCurrent
  };
}

function simulateFetchPreflightRace({ fixed }) {
  let navigationGeneration = 20;
  let operationCurrent = true;
  const capturedNavigation = navigationGeneration;
  const selectedPageId = "page-A";

  const initialGuardPassed =
    operationCurrent
    && navigationGeneration === capturedNavigation
    && selectedPageId === "page-A";

  // api() performs asynchronous request-verification/header work before fetch.
  // Closing the picker in that gap invalidates the operation.
  operationCurrent = false;

  const beforeFetchPassed =
    !fixed
    || (
      operationCurrent
      && navigationGeneration === capturedNavigation
      && selectedPageId === "page-A"
    );

  return {
    initialGuardPassed,
    requestReachedFetch: initialGuardPassed && beforeFetchPassed
  };
}

function simulateCustomFilePreparationNavigation({ fixed }) {
  let navigationGeneration = 30;
  const capturedNavigation = navigationGeneration;
  const capturedPageId = "page-A";
  let selectedPageId = capturedPageId;
  const operationCurrent = true;

  // A page transition begins while file validation/upload work is running.
  // The selected page can still be A until the navigation lock completes.
  navigationGeneration += 1;

  const oldPostPreparationGuard =
    operationCurrent
    && selectedPageId === capturedPageId;
  const fixedPostPreparationGuard =
    oldPostPreparationGuard
    && navigationGeneration === capturedNavigation;

  return {
    saveWouldStart: fixed ? fixedPostPreparationGuard : oldPostPreparationGuard
  };
}

function simulateCollectionNavigation({ fixed }) {
  let navigationGeneration = 40;
  const capturedNavigation = navigationGeneration;
  const capturedCollectionId = "collection-A";
  let workspaceView = "collection";
  let activeCollectionId = capturedCollectionId;
  const selectedPageId = null;
  const operationCurrent = true;

  // Collection pages use the page PATCH route, but collection view intentionally
  // has no selectedPage. The vulnerable code therefore captured null instead of
  // the current workspace navigation generation.
  const vulnerableCapturedNavigation =
    selectedPageId === capturedCollectionId ? capturedNavigation : null;

  // The user navigates away during icon preprocessing or API request preflight.
  navigationGeneration += 1;
  workspaceView = "page";
  activeCollectionId = null;

  const vulnerableGuardPassed =
    operationCurrent
    && vulnerableCapturedNavigation === null;
  const fixedGuardPassed =
    operationCurrent
    && navigationGeneration === capturedNavigation
    && workspaceView === "collection"
    && activeCollectionId === capturedCollectionId;

  return {
    requestWouldStart: fixed ? fixedGuardPassed : vulnerableGuardPassed,
    vulnerableCapturedNavigation,
    navigationGeneration,
    capturedNavigation
  };
}

console.log(JSON.stringify({
  queuedPickerClose: {
    vulnerable: simulateQueuedEditLockRace({ fixed: false, invalidateBy: "picker-close" }),
    fixed: simulateQueuedEditLockRace({ fixed: true, invalidateBy: "picker-close" })
  },
  queuedNavigation: {
    vulnerable: simulateQueuedEditLockRace({ fixed: false, invalidateBy: "navigation" }),
    fixed: simulateQueuedEditLockRace({ fixed: true, invalidateBy: "navigation" })
  },
  fetchPreflight: {
    vulnerable: simulateFetchPreflightRace({ fixed: false }),
    fixed: simulateFetchPreflightRace({ fixed: true })
  },
  customFilePreparation: {
    vulnerable: simulateCustomFilePreparationNavigation({ fixed: false }),
    fixed: simulateCustomFilePreparationNavigation({ fixed: true })
  },
  collectionNavigation: {
    vulnerable: simulateCollectionNavigation({ fixed: false }),
    fixed: simulateCollectionNavigation({ fixed: true })
  }
}, null, 2));
