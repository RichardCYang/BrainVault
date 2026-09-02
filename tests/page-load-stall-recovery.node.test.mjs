import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import {
  ApiReadTimeoutError,
  fetchApiResponseText,
  isSafeApiReadMethod
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

test("safe API reads include GET and HEAD only", () => {
  assert.equal(isSafeApiReadMethod(undefined), true);
  assert.equal(isSafeApiReadMethod("get"), true);
  assert.equal(isSafeApiReadMethod("HEAD"), true);
  assert.equal(isSafeApiReadMethod("POST"), false);
  assert.equal(isSafeApiReadMethod("PATCH"), false);
});

test("a stalled GET response body is aborted and retried once", async () => {
  let calls = 0;
  const fetchImpl = async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 200,
        text: () => abortableNever(init.signal)
      };
    }
    return {
      status: 200,
      text: async () => '{"page":{"id":"page-1"}}'
    };
  };

  const result = await fetchApiResponseText("/api/pages/page-1", {}, {
    fetchImpl,
    readTimeoutMs: 20,
    readRetryCount: 1
  });

  assert.equal(calls, 2);
  assert.equal(result.text, '{"page":{"id":"page-1"}}');
});

test("the deadline aborts a real fetch whose response body never finishes, then retries", async (t) => {
  let calls = 0;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"page":');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"page":{"id":"page-real-fetch"}}');
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  const address = server.address();
  assert.equal(typeof address, "object");
  const result = await fetchApiResponseText(`http://127.0.0.1:${address.port}/page`, {}, {
    readTimeoutMs: 75,
    readRetryCount: 1
  });

  assert.equal(calls, 2);
  assert.equal(JSON.parse(result.text).page.id, "page-real-fetch");
});

test("a GET that stalls twice surfaces a deterministic timeout", async () => {
  let calls = 0;
  const fetchImpl = async (_input, init) => {
    calls += 1;
    return {
      status: 200,
      text: () => abortableNever(init.signal)
    };
  };

  await assert.rejects(
    fetchApiResponseText("/api/pages/page-1", {}, {
      fetchImpl,
      readTimeoutMs: 15,
      readRetryCount: 1
    }),
    (error) => error instanceof ApiReadTimeoutError && error.code === "REQUEST_TIMEOUT"
  );
  assert.equal(calls, 2);
});

test("mutation transport failures are never auto-retried", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError("network failed");
  };

  await assert.rejects(
    fetchApiResponseText("/api/pages/page-1", { method: "PATCH" }, {
      fetchImpl,
      readTimeoutMs: 15,
      readRetryCount: 5
    }),
    /network failed/
  );
  assert.equal(calls, 1);
});

test("caller abort cancels a safe read without retrying", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = async (_input, init) => {
    calls += 1;
    return abortableNever(init.signal);
  };

  const pending = fetchApiResponseText("/api/pages/page-1", { signal: controller.signal }, {
    fetchImpl,
    readTimeoutMs: 1_000,
    readRetryCount: 1
  });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(calls, 1);
});

test("authentication boundary callbacks are not treated as transport retries", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { status: 200, text: async () => "{}" };
  };
  const authenticationError = Object.assign(new Error("stale auth"), {
    status: 401,
    code: "UNAUTHENTICATED"
  });

  await assert.rejects(
    fetchApiResponseText("/api/pages/page-1", {}, {
      fetchImpl,
      readTimeoutMs: 50,
      readRetryCount: 1,
      beforeRead: () => { throw authenticationError; }
    }),
    (error) => error === authenticationError
  );
  assert.equal(calls, 1);
});

test("the app routes API reads through the bounded transport without weakening auth fencing", () => {
  const client = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const apiStart = client.indexOf("async function api(path, options = {})");
  const nextFunction = client.indexOf("async function fetchDatabaseUrlPreview", apiStart);
  const apiSource = client.slice(apiStart, nextFunction);

  assert.match(apiSource, /fetchApiResponseText/);
  assert.match(apiSource, /beforeAttempt: assertAuthenticationScopeCurrent/);
  assert.match(apiSource, /beforeRead: assertAuthenticationScopeCurrent/);
  assert.match(apiSource, /afterRead: assertAuthenticationScopeCurrent/);
  assert.match(apiSource, /code: "REQUEST_TIMEOUT"/);
});

test("all supported languages contain the read-timeout error", () => {
  const i18n = fs.readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
  assert.equal((i18n.match(/requestTimeout:/g) ?? []).length, 7);
});

test("page navigation keeps loading status visible while the read is pending", () => {
  const client = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const openPageStart = client.indexOf("async function openPage");
  const bootStart = client.indexOf("async function boot", openPageStart);
  const openPage = client.slice(openPageStart, bootStart);

  assert.match(openPage, /setStatus\(t\("status\.loadingDocument"\), false, \{ dismissAfter: 0 \}\)/);
  assert.match(openPage, /fetchApiResponseText|api\(`\/api\/pages\/\$\{encodeURIComponent\(pageId\)\}`/);
});
