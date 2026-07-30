import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  getBackupPageShareIdentityMode,
  isExactBackupPageShareIdentityMatch,
  isLegacyBackupPageShareCurrentMatch
} from "../src/lib/page-share-integrity.ts";

const exactShare = {
  shared_user_id: "usr_collaborator",
  shared_username: "collaborator"
};
const legacyShare = {
  page_id: "pag_shared",
  shared_username: "collaborator",
  permission: "EDIT"
};

test("backup page-share identity generations are classified deterministically", () => {
  assert.equal(getBackupPageShareIdentityMode([]), "exact");
  assert.equal(getBackupPageShareIdentityMode([exactShare]), "exact");
  assert.equal(getBackupPageShareIdentityMode([legacyShare]), "legacy");
  assert.equal(getBackupPageShareIdentityMode([exactShare, legacyShare]), "mixed");
});

test("same username cannot rebind an ID-bound share to an unrelated account", () => {
  assert.equal(isExactBackupPageShareIdentityMatch(exactShare, {
    id: "usr_unrelated",
    username: "collaborator"
  }), false);
});

test("an ID-bound share requires both account ID and username", () => {
  assert.equal(isExactBackupPageShareIdentityMatch(exactShare, {
    id: "usr_collaborator",
    username: "collaborator"
  }), true);
  assert.equal(isExactBackupPageShareIdentityMatch(exactShare, {
    id: "usr_collaborator",
    username: "renamed-collaborator"
  }), false);
  assert.equal(isExactBackupPageShareIdentityMatch(exactShare, undefined), false);
});

test("legacy username-only grants require a current exact page-to-account grant", () => {
  const currentShare = {
    page_id: "pag_shared",
    user_id: "usr_collaborator",
    permission: "EDIT"
  };
  const currentUser = {
    id: "usr_collaborator",
    username: "collaborator"
  };

  assert.equal(isLegacyBackupPageShareCurrentMatch(legacyShare, currentShare, currentUser), true);
  assert.equal(isLegacyBackupPageShareCurrentMatch(legacyShare, undefined, currentUser), false);
  assert.equal(isLegacyBackupPageShareCurrentMatch(legacyShare, currentShare, {
    id: "usr_recreated",
    username: "collaborator"
  }), false);
  assert.equal(isLegacyBackupPageShareCurrentMatch(legacyShare, {
    ...currentShare,
    page_id: "pag_other"
  }, currentUser), false);
});

test("backup export and restore wire stable collaborator identity end to end", async () => {
  const source = (await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  assert.match(source, /shared_user_id: idSchema\.optional\(\)/);
  assert.match(source, /ps\.user_id AS shared_user_id/);
  assert.match(source, /SELECT id, username FROM users WHERE id IN/);
  assert.match(source, /isExactBackupPageShareIdentityMatch\(share, sharedUser\)/);
  assert.match(source, /isLegacyBackupPageShareCurrentMatch/);
  assert.match(source, /Legacy sharing grant cannot be verified against a current exact account grant/);
  assert.match(source, /The backup mixes ID-bound and legacy username-only sharing grants/);
});

test("identity-rebinding reproducer proves vulnerable and fixed states", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../scripts/reproduce-backup-share-identity-rebinding.mjs", import.meta.url))
    ],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);
  assert.equal(result.vulnerable.unrelatedAccountReceivedEditAccess, true);
  assert.equal(result.vulnerable.noteDataDeletedByWrongAccount, true);
  assert.equal(result.vulnerable.integrityRiskReproduced, true);
  assert.equal(result.fixed.newBackupBindsAccountId, true);
  assert.equal(result.fixed.unrelatedSameUsernameRejected, true);
  assert.equal(result.fixed.exactIdentityAccepted, true);
  assert.equal(result.fixed.legacyWithoutCurrentExactGrantRejected, true);
  assert.equal(result.fixed.legacyCurrentExactGrantAccepted, true);
  assert.equal(result.fixed.deletedAndReregisteredUsernameRejected, true);
  assert.equal(result.fixed.editorGrantCarriesWriteAuthority, true);
  assert.equal(result.fixed.unrelatedAccountCannotDeleteAfterFix, true);
  assert.equal(result.fixed.identityRebindingClosed, true);
});
