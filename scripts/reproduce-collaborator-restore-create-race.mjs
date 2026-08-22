function simulateAttachmentCreate({
  admittedOwnerGeneration,
  currentOwnerGeneration,
  actorGeneration = 5,
  currentActorGeneration = 5,
  fixed
}) {
  if (actorGeneration !== currentActorGeneration) {
    return { outcome: "rejected-actor-generation", createdBlocks: 0, movedFiles: 0 };
  }
  if (fixed && admittedOwnerGeneration !== currentOwnerGeneration) {
    return { outcome: "rejected-owner-generation", createdBlocks: 0, movedFiles: 0 };
  }
  return { outcome: "committed", createdBlocks: 1, movedFiles: 1 };
}

const staleCollaboratorUpload = {
  admittedOwnerGeneration: 17,
  currentOwnerGeneration: 18
};

const sameGenerationUpload = {
  admittedOwnerGeneration: 18,
  currentOwnerGeneration: 18
};

const result = {
  staleCollaboratorAttachmentCreate: {
    vulnerable: simulateAttachmentCreate({ ...staleCollaboratorUpload, fixed: false }),
    fixed: simulateAttachmentCreate({ ...staleCollaboratorUpload, fixed: true })
  },
  sameGenerationAttachmentCreate: simulateAttachmentCreate({ ...sameGenerationUpload, fixed: true })
};

process.stdout.write(`${JSON.stringify(result)}\n`);
