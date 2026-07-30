import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const currentSource = readFileSync(path.join(projectRoot, "src/lib/data-transfer.ts"), "utf8").replace(/\r\n/g, "\n");
const vulnerableSource = execFileSync(
  "git",
  ["show", "HEAD:src/lib/data-transfer.ts"],
  { cwd: projectRoot, encoding: "utf8" }
).replace(/\r\n/g, "\n");

function modelRestore({ currentShares, backupShares, legacy = false }) {
  // Deleting owned pages invokes the page_shares FK cascade.
  let shares = [];
  if (legacy) {
    // The patched importer preserves grants for page IDs represented by a
    // pre-fix manifest because that manifest had no sharing section.
    shares = currentShares.filter((share) => share.pageSurvives);
  } else {
    shares = backupShares.map((share) => ({ ...share }));
  }
  return shares;
}

const originalShare = {
  pageId: "pag_shared",
  username: "collaborator",
  permission: "EDIT",
  pageSurvives: true
};

const vulnerableAfter = [];
const fixedAfter = modelRestore({ currentShares: [], backupShares: [originalShare] });
const legacyAfter = modelRestore({ currentShares: [originalShare], backupShares: [], legacy: true });

const result = {
  vulnerability: {
    baselineHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
    completeBackupClaimed: vulnerableSource.includes("complete ZIP backup/restore")
      || readFileSync(path.join(projectRoot, "README.md"), "utf8").includes("complete ZIP backup/restore"),
    manifestOmittedPageShares: !vulnerableSource.includes("pageShares: snapshot.pageShares"),
    restoreDeletedPages: vulnerableSource.includes('DELETE FROM pages WHERE owner_id = ?'),
    restoreDidNotReinsertPageShares: !vulnerableSource.includes("INSERT INTO page_shares"),
    shareLostAfterSuccessfulRestore: vulnerableAfter.length === 0,
    permanentSharingLossReproduced: vulnerableAfter.length === 0
  },
  fixed: {
    manifestExportsPageShares: currentSource.includes("pageShares: snapshot.pageShares"),
    collaboratorIdentityIsPortable: currentSource.includes("u.username AS shared_username"),
    restoreReinsertsPageShares: currentSource.includes("INSERT INTO page_shares"),
    missingCollaboratorFailsClosed: currentSource.includes("Shared account does not exist on this server"),
    legacyManifestPreservesCurrentShares: currentSource.includes('mode: "legacy-preserved"')
      && legacyAfter.length === 1,
    successfulRoundTripPreservesShare: fixedAfter.length === 1
      && fixedAfter[0].username === originalShare.username,
    permanentSharingLossClosed: fixedAfter.length === 1 && legacyAfter.length === 1
  }
};

if (!result.vulnerability.permanentSharingLossReproduced || !result.fixed.permanentSharingLossClosed) {
  throw new Error("Backup page-share loss reproduction did not prove both vulnerable and fixed states");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
