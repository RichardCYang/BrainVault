const admitted = Object.freeze({
  ownerId: "owner-a",
  shareGeneration: "cshare-admin-old"
});

function vulnerableMutation(currentAccess, action) {
  if (currentAccess.role !== "ADMIN" && currentAccess.role !== "OWNER") {
    return { action, outcome: "rejected-permission" };
  }
  return { action, outcome: "committed" };
}

function fixedMutation(admission, currentAccess, action) {
  if (
    currentAccess.ownerId !== admission.ownerId
    || currentAccess.shareGeneration !== admission.shareGeneration
  ) {
    return { action, outcome: "rejected-management-generation" };
  }
  return vulnerableMutation(currentAccess, action);
}

const regrantedAccess = {
  ownerId: "owner-a",
  shareGeneration: "cshare-admin-new",
  role: "ADMIN"
};
const sameGenerationAccess = {
  ownerId: "owner-a",
  shareGeneration: "cshare-admin-old",
  role: "ADMIN"
};

const staleAdminGrant = {};
const sameGeneration = {};
for (const action of ["create-share", "update-share", "delete-share"]) {
  staleAdminGrant[action] = {
    vulnerable: vulnerableMutation(regrantedAccess, action),
    fixed: fixedMutation(admitted, regrantedAccess, action)
  };
  sameGeneration[action] = fixedMutation(admitted, sameGenerationAccess, action);
}

console.log(JSON.stringify({ staleAdminGrant, sameGeneration }));
