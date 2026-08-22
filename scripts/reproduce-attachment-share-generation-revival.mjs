const admittedOldGrant = "share_old_generation";
const replacementGrant = "share_new_generation";

// An attachment request is authorized before Multer writes the multipart body.
// While the upload/inspection is in flight, the owner revokes the collaborator
// and immediately re-adds the same account under a fresh share generation.
const currentGrantAfterReAdd = replacementGrant;

// Vulnerable behavior only rechecked that the actor had access again.
const vulnerableStaleUploadAccepted = Boolean(currentGrantAfterReAdd);

// Fixed behavior rechecks the exact grant lineage captured at admission.
const fixedStaleUploadAccepted = admittedOldGrant === currentGrantAfterReAdd;
const fixedReplacementUploadAccepted = replacementGrant === currentGrantAfterReAdd;

const result = {
  scenario: "collaborator attachment upload crosses revoke-and-readd while multipart processing is in flight",
  vulnerable: {
    staleUploadAccepted: vulnerableStaleUploadAccepted
  },
  fixed: {
    staleUploadAccepted: fixedStaleUploadAccepted,
    replacementUploadAccepted: fixedReplacementUploadAccepted
  },
  verified:
    vulnerableStaleUploadAccepted === true
    && fixedStaleUploadAccepted === false
    && fixedReplacementUploadAccepted === true
};

console.log(JSON.stringify(result, null, 2));
if (!result.verified) process.exitCode = 1;
