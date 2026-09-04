function simulateFetchPreflightRace({ fixed }) {
  let requestGeneration = 7;
  const capturedGeneration = requestGeneration;
  let dialogOpen = true;

  const mutationIsCurrent = () => dialogOpen && requestGeneration === capturedGeneration;
  const currentAtApiEntry = mutationIsCurrent();

  // api() yields while preparing network-verification headers. The owner closes
  // the dialog (or navigates to another collection) before fetch() is invoked.
  dialogOpen = false;
  requestGeneration += 1;

  return {
    currentAtApiEntry,
    requestReachedFetch: currentAtApiEntry && (!fixed || mutationIsCurrent())
  };
}

function simulateTransitionWaitRace({ fixed }) {
  let navigationGeneration = 21;
  const capturedNavigation = navigationGeneration;
  let authenticatedSessionGeneration = 4;
  const capturedAuthentication = authenticatedSessionGeneration;

  const mutationIsCurrent = () => (
    navigationGeneration === capturedNavigation
      && authenticatedSessionGeneration === capturedAuthentication
  );
  const currentAtClick = mutationIsCurrent();

  // An owner-scoped writer barrier can wait for another tab. During that wait,
  // navigation and authentication are superseded. The stale callback must not
  // start an API request under the replacement session.
  navigationGeneration += 1;
  authenticatedSessionGeneration += 1;

  return {
    currentAtClick,
    requestWouldStart: currentAtClick && (!fixed || mutationIsCurrent())
  };
}

function simulateDurableRecoveryMirrorRace({ fixed }) {
  let cachedRecoveryRecords = 0;
  const durableRecoveryRecords = 1;

  // Another same-origin tab persisted an unacknowledged Yjs recovery record,
  // but this tab missed the notification and still has an empty memory mirror.
  if (fixed) cachedRecoveryRecords = durableRecoveryRecords;
  const blockedByRecovery = fixed && cachedRecoveryRecords > 0;

  return {
    cachedRecoveryRecords,
    durableRecoveryRecords,
    blockedByRecovery,
    requestReachedFetch: !blockedByRecovery
  };
}

console.log(JSON.stringify({
  fetchPreflightGap: {
    vulnerable: simulateFetchPreflightRace({ fixed: false }),
    fixed: simulateFetchPreflightRace({ fixed: true })
  },
  transitionWaitGap: {
    vulnerable: simulateTransitionWaitRace({ fixed: false }),
    fixed: simulateTransitionWaitRace({ fixed: true })
  },
  durableRecoveryMirrorGap: {
    vulnerable: simulateDurableRecoveryMirrorRace({ fixed: false }),
    fixed: simulateDurableRecoveryMirrorRace({ fixed: true })
  }
}, null, 2));
