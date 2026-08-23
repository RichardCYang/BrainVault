function simulateDialogOpenRace({ fixed }) {
  let navigationGeneration = 10;
  const capturedNavigation = navigationGeneration;
  const selectedPageId = "page-A";
  const capturedPageId = selectedPageId;
  const requestGeneration = 4;
  const currentRequestGeneration = requestGeneration;

  // Opening the share dialog waits for pending edits. A navigation to page B
  // starts in that gap, but page A can remain selected until B finishes loading.
  navigationGeneration += 1;

  const legacyGuardPassed =
    currentRequestGeneration === requestGeneration
    && selectedPageId === capturedPageId;
  const fixedGuardPassed =
    legacyGuardPassed
    && navigationGeneration === capturedNavigation;

  return {
    dialogWouldOpen: fixed ? fixedGuardPassed : legacyGuardPassed,
    navigationGeneration,
    capturedNavigation,
    selectedPageId
  };
}

function simulatePersistenceTransitionRace({ fixed }) {
  let navigationGeneration = 20;
  const capturedNavigation = navigationGeneration;
  const selectedPageId = "page-A";
  const capturedPageId = selectedPageId;
  const authenticationStillCurrent = true;
  const dialogStillOpen = true;

  // The share mutation begins while page A is current, then waits on the
  // persistence transition/writer barrier. Navigation begins while it waits.
  navigationGeneration += 1;

  const legacyMutationGuard =
    authenticationStillCurrent
    && dialogStillOpen
    && selectedPageId === capturedPageId;
  const fixedMutationGuard =
    legacyMutationGuard
    && navigationGeneration === capturedNavigation;

  return {
    requestWouldStart: fixed ? fixedMutationGuard : legacyMutationGuard,
    navigationGeneration,
    capturedNavigation,
    selectedPageId
  };
}

function simulateFetchPreflightRace({ fixed }) {
  let navigationGeneration = 30;
  const capturedNavigation = navigationGeneration;
  const selectedPageId = "page-A";

  // The mutation is current when api() starts.
  const initialGuardPassed =
    navigationGeneration === capturedNavigation
    && selectedPageId === "page-A";

  // api() asynchronously prepares network-verification headers before fetch().
  // A new navigation starts in that preflight gap.
  navigationGeneration += 1;

  const beforeFetchPassed = !fixed || navigationGeneration === capturedNavigation;
  return {
    initialGuardPassed,
    requestReachedFetch: initialGuardPassed && beforeFetchPassed
  };
}

console.log(JSON.stringify({
  dialogOpenGap: {
    vulnerable: simulateDialogOpenRace({ fixed: false }),
    fixed: simulateDialogOpenRace({ fixed: true })
  },
  persistenceTransitionGap: {
    vulnerable: simulatePersistenceTransitionRace({ fixed: false }),
    fixed: simulatePersistenceTransitionRace({ fixed: true })
  },
  fetchPreflightGap: {
    vulnerable: simulateFetchPreflightRace({ fixed: false }),
    fixed: simulateFetchPreflightRace({ fixed: true })
  }
}, null, 2));
