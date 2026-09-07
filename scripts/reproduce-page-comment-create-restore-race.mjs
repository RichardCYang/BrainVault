const admitted = Object.freeze({
  ownerId: "owner-a",
  shareGeneration: "cshare-old"
});

function canEdit(access) {
  return access.role === "EDITOR" || access.role === "ADMIN" || access.role === "OWNER";
}

function vulnerableMutation(access, action) {
  return canEdit(access)
    ? { action, outcome: "committed" }
    : { action, outcome: "rejected" };
}

function fixedMutation(admission, access, action) {
  if (
    access.ownerId !== admission.ownerId
    || access.shareGeneration !== admission.shareGeneration
  ) {
    return { action, outcome: "rejected-access-generation" };
  }
  return vulnerableMutation(access, action);
}

const replacedAccess = {
  ownerId: "owner-a",
  shareGeneration: "cshare-restored",
  role: "EDITOR"
};
const sameGenerationAccess = {
  ownerId: "owner-a",
  shareGeneration: "cshare-old",
  role: "EDITOR"
};

const staleGrantMutations = {};
const sameGenerationMutations = {};
for (const action of ["create-comment", "edit-comment", "delete-comment"]) {
  staleGrantMutations[action] = {
    vulnerable: vulnerableMutation(replacedAccess, action),
    fixed: fixedMutation(admitted, replacedAccess, action)
  };
  sameGenerationMutations[action] = fixedMutation(admitted, sameGenerationAccess, action);
}

console.log(JSON.stringify({ staleGrantMutations, sameGenerationMutations }));
