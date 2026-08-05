import { createHash } from "node:crypto";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function requestHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function reproducePageCreateIdempotency() {
  const payload = { title: "Untitled", icon: "📄" };

  const vulnerablePages = [];
  const vulnerableCreate = () => {
    const id = `page-${vulnerablePages.length + 1}`;
    vulnerablePages.push({ id, ...payload });
    return id;
  };
  const vulnerableFirstId = vulnerableCreate();
  // The server committed, but the first response was lost. The client retries POST.
  const vulnerableRetryId = vulnerableCreate();

  const receipts = new Map();
  const fixedPages = new Map();
  const fixedCreate = (mutationId, body) => {
    const hash = requestHash(body);
    const receipt = receipts.get(mutationId);
    if (receipt) {
      if (receipt.requestHash !== hash) {
        const error = new Error("mutation id reused");
        error.code = "MUTATION_ID_REUSED";
        throw error;
      }
      return receipt.pageId;
    }
    const pageId = `page-${fixedPages.size + 1}`;
    receipts.set(mutationId, { pageId, requestHash: hash });
    fixedPages.set(pageId, { id: pageId, ...body });
    return pageId;
  };

  const mutationId = "mut-retry-safe";
  const fixedFirstId = fixedCreate(mutationId, payload);
  const fixedRetryId = fixedCreate(mutationId, payload);
  let mismatchedPayloadRejected = false;
  try {
    fixedCreate(mutationId, { ...payload, title: "Different intent" });
  } catch (error) {
    mismatchedPayloadRejected = error?.code === "MUTATION_ID_REUSED";
  }

  const createWorkflowServer = () => {
    const workflowReceipts = new Map();
    const workflowPages = new Map();
    return {
      create(mutationId, body) {
        const hash = requestHash(body);
        const receipt = workflowReceipts.get(mutationId);
        if (receipt) {
          if (receipt.requestHash !== hash) throw new Error("mutation id reused");
          return receipt.pageId;
        }
        const pageId = `workflow-page-${workflowPages.size + 1}`;
        workflowReceipts.set(mutationId, { pageId, requestHash: hash });
        workflowPages.set(pageId, { id: pageId, ...body });
        return pageId;
      },
      get pageCount() {
        return workflowPages.size;
      }
    };
  };

  // Before the fix, the client forgot its mutation ID immediately after POST returned.
  // If the following list refresh failed, the next click used a fresh ID and duplicated the page.
  const vulnerableWorkflowServer = createWorkflowServer();
  let vulnerablePendingMutationId = "mut-workflow-vulnerable-1";
  const vulnerableWorkflowFirstId = vulnerableWorkflowServer.create(vulnerablePendingMutationId, payload);
  vulnerablePendingMutationId = null;
  const vulnerableWorkflowRetryId = vulnerableWorkflowServer.create(
    vulnerablePendingMutationId ?? "mut-workflow-vulnerable-2",
    payload
  );

  // The fixed client keeps the task until list refresh and navigation finish. A retry after
  // a post-success UI failure therefore replays the same durable create receipt.
  const fixedWorkflowServer = createWorkflowServer();
  const fixedPendingMutationId = "mut-workflow-fixed";
  const fixedWorkflowFirstId = fixedWorkflowServer.create(fixedPendingMutationId, payload);
  const fixedWorkflowRetryId = fixedWorkflowServer.create(fixedPendingMutationId, payload);

  return {
    vulnerableDuplicateCreated: vulnerablePages.length === 2 && vulnerableFirstId !== vulnerableRetryId,
    fixedDuplicateCreated: fixedPages.size !== 1 || fixedFirstId !== fixedRetryId,
    fixedPageCount: fixedPages.size,
    fixedReplayReturnedOriginalPage: fixedFirstId === fixedRetryId,
    mismatchedPayloadRejected,
    vulnerablePostSuccessRefreshFailureCreatedDuplicate:
      vulnerableWorkflowServer.pageCount === 2 && vulnerableWorkflowFirstId !== vulnerableWorkflowRetryId,
    fixedPostSuccessRefreshFailureCreatedDuplicate:
      fixedWorkflowServer.pageCount !== 1 || fixedWorkflowFirstId !== fixedWorkflowRetryId
  };
}

async function reproduceRapidCreateSerialization() {
  const gate = deferred();
  let vulnerableRequests = 0;
  const vulnerableSubmit = async () => {
    vulnerableRequests += 1;
    await gate.promise;
  };
  const vulnerableFirst = vulnerableSubmit();
  const vulnerableSecond = vulnerableSubmit();
  gate.resolve();
  await Promise.all([vulnerableFirst, vulnerableSecond]);

  const fixedGate = deferred();
  let fixedBusy = false;
  let fixedRequests = 0;
  const fixedSubmit = async () => {
    if (fixedBusy) return false;
    fixedBusy = true;
    try {
      fixedRequests += 1;
      await fixedGate.promise;
      return true;
    } finally {
      fixedBusy = false;
    }
  };
  const fixedFirst = fixedSubmit();
  const fixedSecondStarted = await fixedSubmit();
  fixedGate.resolve();
  await fixedFirst;

  return {
    vulnerableRequestCount: vulnerableRequests,
    vulnerableDuplicateRequestStarted: vulnerableRequests === 2,
    fixedRequestCount: fixedRequests,
    fixedDuplicateRequestStarted: fixedSecondStarted !== false
  };
}

async function reproduceAuthenticationBoundary() {
  const accountA = { generation: 1, targetKey: "user:account-a" };
  const accountB = { generation: 2, targetKey: "user:account-b" };

  const vulnerableState = { scope: accountA, selectedPage: null, downloads: [], resetCount: 0 };
  const staleCreate = deferred();
  const staleAttachment = deferred();
  const staleUnauthorized = deferred();
  const vulnerableTasks = [
    staleCreate.promise.then((page) => { vulnerableState.selectedPage = page; }),
    staleAttachment.promise.then((name) => { vulnerableState.downloads.push(name); }),
    staleUnauthorized.promise.then(() => { vulnerableState.resetCount += 1; })
  ];
  vulnerableState.scope = accountB;
  staleCreate.resolve({ id: "account-a-page", ownerId: "account-a" });
  staleAttachment.resolve("account-a-private.txt");
  staleUnauthorized.resolve({ status: 401 });
  await Promise.all(vulnerableTasks);

  const fixedState = { scope: accountA, selectedPage: null, downloads: [], resetCount: 0 };
  const createScope = fixedState.scope;
  const attachmentScope = fixedState.scope;
  const unauthorizedScope = fixedState.scope;
  const isCurrent = (scope) => (
    scope.generation === fixedState.scope.generation
    && scope.targetKey === fixedState.scope.targetKey
  );
  const fixedCreate = deferred();
  const fixedAttachment = deferred();
  const fixedUnauthorized = deferred();
  const fixedTasks = [
    fixedCreate.promise.then((page) => {
      if (isCurrent(createScope)) fixedState.selectedPage = page;
    }),
    fixedAttachment.promise.then((name) => {
      if (isCurrent(attachmentScope)) fixedState.downloads.push(name);
    }),
    fixedUnauthorized.promise.then(() => {
      if (isCurrent(unauthorizedScope)) fixedState.resetCount += 1;
    })
  ];
  fixedState.scope = accountB;
  fixedCreate.resolve({ id: "account-a-page", ownerId: "account-a" });
  fixedAttachment.resolve("account-a-private.txt");
  fixedUnauthorized.resolve({ status: 401 });
  await Promise.all(fixedTasks);

  const sameAccountBeforeCredentialRotation = { generation: 7, targetKey: "user:account-a" };
  const sameAccountAfterCredentialRotation = { generation: 8, targetKey: "user:account-a" };
  const vulnerableStale401ResetRotatedSameAccountSession =
    sameAccountBeforeCredentialRotation.targetKey === sameAccountAfterCredentialRotation.targetKey;
  const fixedStale401ResetRotatedSameAccountSession =
    sameAccountBeforeCredentialRotation.generation === sameAccountAfterCredentialRotation.generation
    && sameAccountBeforeCredentialRotation.targetKey === sameAccountAfterCredentialRotation.targetKey;

  return {
    vulnerableOldPageOpenedInNewAccount: vulnerableState.selectedPage?.ownerId === "account-a",
    fixedOldPageOpenedInNewAccount: fixedState.selectedPage?.ownerId === "account-a",
    vulnerableOldAttachmentDownloaded: vulnerableState.downloads.includes("account-a-private.txt"),
    fixedOldAttachmentDownloaded: fixedState.downloads.includes("account-a-private.txt"),
    vulnerableStale401ResetNewSession: vulnerableState.resetCount === 1,
    fixedStale401ResetNewSession: fixedState.resetCount === 1,
    vulnerableStale401ResetRotatedSameAccountSession,
    fixedStale401ResetRotatedSameAccountSession,
    fixedCurrentTargetKey: fixedState.scope.targetKey
  };
}

console.log(JSON.stringify({
  scenario: "page creation idempotency and authenticated completion boundaries",
  pageCreate: reproducePageCreateIdempotency(),
  rapidCreate: await reproduceRapidCreateSerialization(),
  authenticationBoundary: await reproduceAuthenticationBoundary()
}, null, 2));
