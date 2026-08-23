function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function runNavigationScenario(fixed) {
  let navigationGeneration = 1;
  let selectedPageId = "page-a";
  let staleSourceDeleteSent = false;
  const initiatingNavigationGeneration = navigationGeneration;
  const discardWait = deferred();

  const replacement = (async () => {
    // The attachment upload itself already committed while page A was current.
    await discardWait.promise;

    // Vulnerable behavior omitted the initiating navigation generation when it
    // entered the destructive source-block replacement.
    if (
      fixed
      && (
        navigationGeneration !== initiatingNavigationGeneration
        || selectedPageId !== "page-a"
      )
    ) return;

    staleSourceDeleteSent = true;
  })();

  navigationGeneration += 1;
  selectedPageId = "page-b";
  discardWait.resolve();
  await replacement;

  return {
    selectedPageId,
    staleSourceDeleteSent,
    newerNavigationPreserved: selectedPageId === "page-b"
  };
}

function runAuthenticationScenario(fixed) {
  let authenticationGeneration = 1;
  let staleSourceDeleteSent = false;
  const initiatingAuthenticationGeneration = authenticationGeneration;

  // The upload response was accepted under generation 1. A credential/session
  // rotation lands just before the collaborative replacement helper is called.
  authenticationGeneration += 1;

  // Vulnerable behavior captured a fresh scope here (generation 2); fixed
  // behavior carries the upload's initiating generation into the delete helper.
  const deletionAuthenticationGeneration = fixed
    ? initiatingAuthenticationGeneration
    : authenticationGeneration;

  if (deletionAuthenticationGeneration === authenticationGeneration) {
    staleSourceDeleteSent = true;
  }

  return {
    authenticationGeneration,
    deletionAuthenticationGeneration,
    staleSourceDeleteSent
  };
}

const vulnerable = {
  navigation: await runNavigationScenario(false),
  authentication: runAuthenticationScenario(false)
};
const fixed = {
  navigation: await runNavigationScenario(true),
  authentication: runAuthenticationScenario(true)
};

console.log(JSON.stringify({ vulnerable, fixed }, null, 2));
