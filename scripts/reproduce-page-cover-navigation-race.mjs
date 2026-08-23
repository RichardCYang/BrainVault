function simulatePreparationRace({ fixed }) {
  let navigationGeneration = 10;
  let selectedPageId = "page-A";
  const capturedNavigation = navigationGeneration;
  const capturedPageId = selectedPageId;
  const operationStillCurrent = true;

  // Custom image preparation is asynchronous. Opening page B increments the
  // navigation generation immediately, while page A can remain selected until
  // B's request finishes.
  navigationGeneration += 1;

  const legacyGuardPassed =
    selectedPageId === capturedPageId
    && operationStillCurrent;
  const fixedGuardPassed =
    navigationGeneration === capturedNavigation
    && selectedPageId === capturedPageId
    && operationStillCurrent;

  return {
    requestWouldStart: fixed ? fixedGuardPassed : legacyGuardPassed,
    navigationGeneration,
    capturedNavigation,
    selectedPageId
  };
}

function simulateFetchPreflightRace({ fixed }) {
  let navigationGeneration = 20;
  const capturedNavigation = navigationGeneration;
  const selectedPageId = "page-A";

  // persistPageCover checked page A immediately before calling api().
  const initialGuardPassed =
    navigationGeneration === capturedNavigation
    && selectedPageId === "page-A";

  // api() then awaits asynchronous network-verification/header work. Navigation
  // begins in that gap.
  navigationGeneration += 1;

  const beforeFetchPassed = !fixed || navigationGeneration === capturedNavigation;
  return {
    initialGuardPassed,
    requestReachedFetch: initialGuardPassed && beforeFetchPassed
  };
}

console.log(JSON.stringify({
  preparationGap: {
    vulnerable: simulatePreparationRace({ fixed: false }),
    fixed: simulatePreparationRace({ fixed: true })
  },
  fetchPreflightGap: {
    vulnerable: simulateFetchPreflightRace({ fixed: false }),
    fixed: simulateFetchPreflightRace({ fixed: true })
  }
}, null, 2));
