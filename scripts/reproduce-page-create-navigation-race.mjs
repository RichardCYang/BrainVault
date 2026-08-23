function simulateNavigationBeforeSubmit({ fixed }) {
  let navigationGeneration = 4;
  let selectedPageId = "page-a";
  const capturedNavigation = navigationGeneration;
  const requests = [];

  // The add-subpage path waits for persistence/editor flushes. While it waits,
  // the user intentionally opens another page.
  navigationGeneration += 1;
  selectedPageId = "page-b";

  const intentCurrent =
    navigationGeneration === capturedNavigation
    && selectedPageId === "page-a";
  if (!fixed || intentCurrent) {
    requests.push({ parentPageId: "page-a" });
  }

  return {
    requestSent: requests.length > 0,
    requestParentPageId: requests[0]?.parentPageId ?? null,
    selectedPageId
  };
}

function simulateNavigationWhileRequestInFlight({ fixed }) {
  let navigationGeneration = 9;
  let selectedPageId = "page-a";
  const capturedNavigation = navigationGeneration;
  const createdPages = [];

  // The fetch has already begun, so the server is allowed to commit the user's
  // original click. The remaining requirement is that the stale response does
  // not replace a newer navigation choice.
  createdPages.push({ id: "page-a-child", parentPageId: "page-a" });
  navigationGeneration += 1;
  selectedPageId = "page-b";

  const intentCurrent =
    navigationGeneration === capturedNavigation
    && selectedPageId === "page-a";
  if (!fixed || intentCurrent) {
    selectedPageId = "page-a-child";
  }

  return {
    committedPageId: createdPages[0].id,
    committedParentPageId: createdPages[0].parentPageId,
    selectedPageId,
    staleResponseOverrodeNewerNavigation: selectedPageId === "page-a-child"
  };
}

console.log(JSON.stringify({
  beforeSubmit: {
    vulnerable: simulateNavigationBeforeSubmit({ fixed: false }),
    fixed: simulateNavigationBeforeSubmit({ fixed: true })
  },
  inFlight: {
    vulnerable: simulateNavigationWhileRequestInFlight({ fixed: false }),
    fixed: simulateNavigationWhileRequestInFlight({ fixed: true })
  }
}, null, 2));
