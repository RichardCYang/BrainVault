import {
  ApiReadTimeoutError,
  fetchApiResponseText
} from "../public/api-read-transport.js";

function abortableNever(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
}

async function reproduceVulnerable() {
  let status = "Loading page...";
  let opened = false;
  const clearStatus = setTimeout(() => { status = ""; }, 24);
  const pendingRead = new Promise(() => undefined);
  await Promise.race([pendingRead, new Promise((resolve) => setTimeout(resolve, 40))]);
  clearTimeout(clearStatus);
  return {
    opened,
    visibleStatusAfterDelay: status,
    requestStillPending: !opened
  };
}

async function reproduceFixed() {
  let calls = 0;
  let status = "Loading page...";
  const fetchImpl = async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return { status: 200, text: () => abortableNever(init.signal) };
    }
    return { status: 200, text: async () => '{"page":{"id":"page-1"}}' };
  };

  try {
    const { text } = await fetchApiResponseText("/api/pages/page-1", {}, {
      fetchImpl,
      readTimeoutMs: 20,
      readRetryCount: 1
    });
    const data = JSON.parse(text);
    status = data.page?.id ? "Page opened." : "Invalid page.";
    return {
      calls,
      opened: data.page?.id === "page-1",
      finalStatus: status
    };
  } catch (error) {
    status = error instanceof ApiReadTimeoutError ? "Request timed out." : error.message;
    return { calls, opened: false, finalStatus: status };
  }
}

console.log(JSON.stringify({
  scenario: "a long-lived tab encounters a stalled page GET/body read",
  vulnerable: await reproduceVulnerable(),
  fixed: await reproduceFixed()
}, null, 2));
