function isAuthenticationDenied(error) {
  const status = Number(error?.status ?? 0);
  return status === 401 || (status === 403 && ["COUNTRY_LOGIN_BLOCKED", "VPN_ACCESS_BLOCKED"].includes(error?.code));
}

/**
 * Restores an HttpOnly-cookie session without confusing workspace-loading
 * failures with authentication failures. A valid user is committed to state
 * before the workspace request, so a transient page-list error keeps the
 * authenticated shell available for retry instead of returning to login.
 */
export async function restoreSessionAtBoot(
  state,
  { loadUser, initializeAuthenticatedUi, loadWorkspace, isCurrent = () => true }
) {
  const initialAuthenticated = state.authenticated;
  const initialUser = state.user;
  let user;
  let committed = false;

  const superseded = () => {
    // A newer login may already have replaced the boot user. Roll back only
    // when this restoration still owns the values it committed.
    if (committed && state.user === user) {
      state.authenticated = initialAuthenticated;
      state.user = initialUser;
    }
    return { outcome: "superseded" };
  };

  try {
    user = await loadUser();
  } catch (error) {
    if (!isCurrent()) return superseded();
    return { outcome: isAuthenticationDenied(error) ? "unauthenticated" : "session-unavailable", error };
  }

  if (!isCurrent()) return superseded();

  state.authenticated = true;
  state.user = user;
  committed = true;

  try {
    await initializeAuthenticatedUi(user);
    if (!isCurrent()) return superseded();
  } catch (error) {
    if (!isCurrent()) return superseded();
    state.authenticated = false;
    state.user = null;
    return { outcome: "session-unavailable", error };
  }

  try {
    await loadWorkspace();
    if (!isCurrent()) return superseded();
    return { outcome: "ready", user };
  } catch (error) {
    if (!isCurrent()) return superseded();
    return { outcome: "workspace-unavailable", user, error };
  }
}
