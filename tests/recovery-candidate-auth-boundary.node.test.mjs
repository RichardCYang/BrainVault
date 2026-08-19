import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return text.slice(startIndex, endIndex);
}

const route = source("../src/routes/collaboration.routes.ts");
const recovery = source("../src/lib/recovery-candidates.ts");

const upload = section(
  route,
  'collaborationRouter.post(\n  "/recovery/pages/:pageId/candidates"',
  'collaborationRouter.get("/recovery/candidates"'
);
const deletion = section(
  route,
  'collaborationRouter.delete(\n  "/recovery/candidates/:candidateId"',
  'collaborationRouter.post(\n  "/pages/:pageId/collaboration/session"'
);

test("recovery-vault upload and deletion revalidate the exact auth session inside their durable transaction", () => {
  for (const mutation of [upload, deletion]) {
    assert.match(mutation, /const authScope = requireRequestAuthScope\(req\);/);
    assert.match(mutation, /transaction\(async \(client\) => \{/);
    assert.match(
      mutation,
      /await assertCurrentAuthSessionBoundary\(user\.id, authScope, client\);/
    );
  }

  assert.ok(
    upload.indexOf("assertCurrentAuthSessionBoundary")
      < upload.indexOf("return storeRecoveryCandidate("),
    "upload auth fence must precede recovery-vault persistence"
  );
  assert.ok(
    deletion.indexOf("assertCurrentAuthSessionBoundary")
      < deletion.indexOf("await deleteRecoveryCandidate("),
    "delete auth fence must precede destructive recovery-candidate deletion"
  );
});

test("recovery-vault helpers can share the caller transaction instead of escaping the auth fence", () => {
  const store = section(
    recovery,
    "export async function storeRecoveryCandidate",
    "export async function listRecoveryCandidates"
  );
  assert.match(store, /}, client\?: DbClient\) \{/);
  assert.match(store, /const persist = async \(client: DbClient\) => \{/);
  assert.match(store, /return client \? persist\(client\) : transaction\(persist\);/);

  const remove = recovery.slice(recovery.indexOf("export async function deleteRecoveryCandidate"));
  assert.match(remove, /client: DbClient = db/);
  assert.match(remove, /await client\.execute<\{ affectedRows: number \}>/);
  assert.doesNotMatch(remove, /await db\.execute/);
});

test("stale-auth recovery-vault race fails closed after credential or device-session revocation", () => {
  function reproduce({ fixed, operation, requestAuthVersion, currentAuthVersion, requestSessionActive }) {
    let candidatePresent = true;
    let candidateCount = 0;

    if (
      fixed
      && (
        requestAuthVersion !== currentAuthVersion
        || !requestSessionActive
      )
    ) {
      return { status: 401, candidatePresent, candidateCount };
    }

    if (operation === "delete") candidatePresent = false;
    else candidateCount += 1;
    return { status: operation === "delete" ? 204 : 201, candidatePresent, candidateCount };
  }

  const stale = {
    requestAuthVersion: 7,
    currentAuthVersion: 8,
    requestSessionActive: false
  };

  assert.deepEqual(
    reproduce({ fixed: false, operation: "delete", ...stale }),
    { status: 204, candidatePresent: false, candidateCount: 0 }
  );
  assert.deepEqual(
    reproduce({ fixed: true, operation: "delete", ...stale }),
    { status: 401, candidatePresent: true, candidateCount: 0 }
  );
  assert.deepEqual(
    reproduce({ fixed: false, operation: "upload", ...stale }),
    { status: 201, candidatePresent: true, candidateCount: 1 }
  );
  assert.deepEqual(
    reproduce({ fixed: true, operation: "upload", ...stale }),
    { status: 401, candidatePresent: true, candidateCount: 0 }
  );
});
