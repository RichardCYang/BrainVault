function isUnauthorized(error) {
  return Number(error?.status ?? 0) === 401;
}

/**
 * Restores an HttpOnly-cookie session without confusing workspace-loading
 * failures with authentication failures. A valid user is committed to state
 * before the workspace request, so a transient page-list error keeps the
 * authenticated shell available for retry instead of returning to login.
 */
export async function restoreSessionAtBoot(
  state,
  { loadUser, initializeAuthenticatedUi, loadWorkspace }
) {
  let user;
  try {
    user = await loadUser();
  } catch (error) {
    return { outcome: isUnauthorized(error) ? "unauthenticated" : "session-unavailable", error };
  }

  state.authenticated = true;
  state.user = user;

  try {
    await initializeAuthenticatedUi(user);
  } catch (error) {
    state.authenticated = false;
    state.user = null;
    return { outcome: "session-unavailable", error };
  }

  try {
    await loadWorkspace();
    return { outcome: "ready", user };
  } catch (error) {
    return { outcome: "workspace-unavailable", user, error };
  }
}
