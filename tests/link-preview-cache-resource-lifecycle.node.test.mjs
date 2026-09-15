import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function extractFunction(source, functionName, nextFunctionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const end = source.indexOf(`\n${nextFunctionName}`, start);
  assert.notEqual(end, -1, `${nextFunctionName} must follow ${functionName}`);
  return source.slice(start, end).trim();
}

function loadPreviewRequestFactory(source, {
  cacheName,
  maxName,
  functionName,
  nextFunctionName,
  maxEntries
}) {
  const functionSource = extractFunction(source, functionName, nextFunctionName);
  const factory = new Function(
    "cache",
    `const ${cacheName} = cache; const ${maxName} = ${maxEntries}; ${functionSource}; return ${functionName};`
  );
  const cache = new Map();
  return { cache, getRequest: factory(cache) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cases = [
  {
    file: new URL("../public/ai-chat-block.js", import.meta.url),
    cacheName: "aiChatLinkPreviewCache",
    maxName: "aiChatLinkPreviewCacheMaxEntries",
    functionName: "getAiChatLinkPreviewRequest",
    nextFunctionName: "async function hydrateRenderedAiChatLink"
  },
  {
    file: new URL("../public/database-block.js", import.meta.url),
    cacheName: "databaseUrlPreviewCache",
    maxName: "databaseUrlPreviewCacheMaxEntries",
    functionName: "getDatabaseUrlPreviewRequest",
    nextFunctionName: "async function hydrateDatabaseUrlPreview"
  }
];

for (const config of cases) {
  test(`${config.functionName} refreshes cache recency without changing the 250-entry production bound`, async () => {
    const source = await readFile(config.file, "utf8");
    assert.match(source, new RegExp(`const ${config.maxName} = 250;`));

    const { cache, getRequest } = loadPreviewRequestFactory(source, { ...config, maxEntries: 3 });
    let fetchCount = 0;
    const fetchPreview = async (url) => ({ title: url, fetch: ++fetchCount });

    const hot = getRequest("https://hot.example/", fetchPreview);
    await hot;
    await getRequest("https://cold-1.example/", fetchPreview);
    await getRequest("https://cold-2.example/", fetchPreview);

    assert.strictEqual(getRequest("https://hot.example/", fetchPreview), hot);
    await getRequest("https://cold-3.example/", fetchPreview);

    assert.equal(cache.size, 3);
    assert.equal(cache.has("https://hot.example/"), true, "a cache hit must refresh recency");
    assert.equal(cache.has("https://cold-1.example/"), false, "the least-recently-used entry must be evicted");
    assert.equal(fetchCount, 4, "the hot preview must not be re-fetched");
  });

  test(`${config.functionName} cannot let an evicted stale failure delete a newer request`, async () => {
    const source = await readFile(config.file, "utf8");
    const { cache, getRequest } = loadPreviewRequestFactory(source, { ...config, maxEntries: 2 });
    const firstA = deferred();
    const secondA = deferred();
    let aCalls = 0;

    const fetchPreview = (url) => {
      if (url === "https://a.example/") {
        aCalls += 1;
        return aCalls === 1 ? firstA.promise : secondA.promise;
      }
      return Promise.resolve({ title: url });
    };

    const oldRequest = getRequest("https://a.example/", fetchPreview);
    await getRequest("https://b.example/", fetchPreview);
    await getRequest("https://c.example/", fetchPreview); // evicts old A
    const newRequest = getRequest("https://a.example/", fetchPreview);
    assert.notStrictEqual(newRequest, oldRequest);
    assert.strictEqual(cache.get("https://a.example/"), newRequest);

    firstA.reject(new Error("stale request failed"));
    assert.equal(await oldRequest, null);
    assert.strictEqual(
      cache.get("https://a.example/"),
      newRequest,
      "late failure from the evicted request must not erase the replacement"
    );

    secondA.resolve({ title: "A" });
    assert.deepEqual(await newRequest, { title: "A" });
    assert.strictEqual(getRequest("https://a.example/", fetchPreview), newRequest);
    assert.equal(aCalls, 2, "the surviving newer request must remain reusable");
  });

  test(`${config.functionName} still removes a failed request when it remains the current owner`, async () => {
    const source = await readFile(config.file, "utf8");
    const { cache, getRequest } = loadPreviewRequestFactory(source, { ...config, maxEntries: 3 });
    const request = getRequest("https://failure.example/", async () => {
      throw new Error("preview unavailable");
    });

    assert.equal(await request, null);
    assert.equal(cache.has("https://failure.example/"), false);
  });
}
