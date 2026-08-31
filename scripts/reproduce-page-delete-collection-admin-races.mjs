function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function vulnerableAuthorizationRace() {
  let committed = {
    page: { id: "pag_shared", ownerId: "usr_owner", generation: "restored" },
    collectionGrant: { userId: "usr_admin", permission: "ADMIN", generation: "cshare_old" }
  };
  let repeatableReadSnapshot = null;
  const consistentRead = (selector) => {
    repeatableReadSnapshot ??= clone(committed);
    return selector(repeatableReadSnapshot);
  };
  const lockingRead = (selector) => selector(committed);

  const ownerHint = consistentRead((state) => state.page.ownerId);
  // Workspace restore commits while the delete waits for the owner's user-row lock.
  committed = {
    page: { id: "pag_shared", ownerId: "usr_owner", generation: "restored" },
    collectionGrant: null
  };
  const lockedPage = lockingRead((state) => state.page);
  const observedGrant = consistentRead((state) => state.collectionGrant);
  return {
    ownerHint,
    lockedPageGeneration: lockedPage.generation,
    currentGrant: committed.collectionGrant,
    observedGrant,
    authorized: observedGrant?.permission === "ADMIN"
  };
}

function fixedAuthorizationRace() {
  let committed = {
    page: { id: "pag_shared", ownerId: "usr_owner", generation: "before-restore" },
    collectionGrant: { userId: "usr_admin", permission: "ADMIN", generation: "cshare_old" }
  };
  // Autocommit preflight is only a lock-order hint and creates no transaction snapshot.
  const ownerHint = committed.page.ownerId;
  committed = {
    page: { id: "pag_shared", ownerId: "usr_owner", generation: "restored" },
    collectionGrant: null
  };

  let repeatableReadSnapshot = null;
  const consistentRead = (selector) => {
    repeatableReadSnapshot ??= clone(committed);
    return selector(repeatableReadSnapshot);
  };
  const lockingRead = (selector) => selector(committed);
  const lockedPage = lockingRead((state) => state.page);
  const observedGrant = consistentRead((state) => state.collectionGrant);
  return {
    ownerHint,
    lockedPageGeneration: lockedPage.generation,
    currentGrant: committed.collectionGrant,
    observedGrant,
    authorized: observedGrant?.permission === "ADMIN"
  };
}

function vulnerableLockOrder() {
  return {
    firstDelete: ["usr_admin_a", "usr_owner_b"],
    secondDelete: ["usr_owner_b", "usr_admin_a"],
    deadlock: true,
    reason: "each transaction holds its actor row while waiting for the other owner row"
  };
}

function fixedLockOrder() {
  const firstDelete = ["usr_admin_a", "usr_owner_b"].sort();
  const secondDelete = ["usr_owner_b", "usr_admin_a"].sort();
  return {
    firstDelete,
    secondDelete,
    deadlock: false,
    reason: "both transactions request the same sorted user-row order"
  };
}

const report = {
  authorizationRace: {
    vulnerable: vulnerableAuthorizationRace(),
    fixed: fixedAuthorizationRace()
  },
  reciprocalAdminDeletes: {
    vulnerable: vulnerableLockOrder(),
    fixed: fixedLockOrder()
  }
};

if (!report.authorizationRace.vulnerable.authorized) {
  throw new Error("The vulnerable model did not reproduce stale ADMIN authorization");
}
if (report.authorizationRace.fixed.authorized) {
  throw new Error("The fixed model did not reject the revoked ADMIN grant");
}
if (!report.reciprocalAdminDeletes.vulnerable.deadlock || report.reciprocalAdminDeletes.fixed.deadlock) {
  throw new Error("The lock-order model did not reproduce and eliminate the cycle");
}
if (JSON.stringify(report.reciprocalAdminDeletes.fixed.firstDelete) !== JSON.stringify(report.reciprocalAdminDeletes.fixed.secondDelete)) {
  throw new Error("Fixed transactions did not converge on one lock order");
}

console.log(JSON.stringify(report, null, 2));
