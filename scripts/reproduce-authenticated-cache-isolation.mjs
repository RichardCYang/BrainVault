import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { privateNoStoreCacheControl, setPrivateNoStoreCacheControl } from "../src/lib/cache-control.ts";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

function sessionOwner(cookieHeader) {
  const match = /(?:^|;\s*)session=(alice|bob)(?:;|$)/.exec(String(cookieHeader ?? ""));
  return match?.[1] ?? "anonymous";
}

function sharedCacheMayStore(cacheControl) {
  const directives = String(cacheControl ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return !directives.includes("private") && !directives.includes("no-store");
}

async function runScenario(applyPolicy) {
  const origin = createServer((req, res) => {
    if (applyPolicy) setPrivateNoStoreCacheControl(res);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      owner: sessionOwner(req.headers.cookie),
      note: `private note for ${sessionOwner(req.headers.cookie)}`
    }));
  });
  const originUrl = await listen(origin);
  const cache = new Map();

  const proxy = createServer(async (req, res) => {
    const key = `${req.method} ${req.url}`;
    const stored = cache.get(key);
    if (stored) {
      res.statusCode = stored.status;
      for (const [name, value] of Object.entries(stored.headers)) res.setHeader(name, value);
      res.setHeader("X-Cache", "HIT");
      res.end(stored.body);
      return;
    }

    try {
      const upstream = await fetch(`${originUrl}${req.url}`, {
        headers: { cookie: String(req.headers.cookie ?? "") }
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      const headers = Object.fromEntries(upstream.headers.entries());
      if (upstream.status === 200 && sharedCacheMayStore(headers["cache-control"])) {
        cache.set(key, { status: upstream.status, headers, body });
      }
      res.statusCode = upstream.status;
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.setHeader("X-Cache", "MISS");
      res.end(body);
    } catch (error) {
      res.statusCode = 502;
      res.end(error instanceof Error ? error.message : "proxy failure");
    }
  });
  const proxyUrl = await listen(proxy);

  try {
    const first = await fetch(`${proxyUrl}/api/pages/page-secret`, {
      headers: { cookie: "session=alice" }
    });
    const firstBody = await first.json();
    const second = await fetch(`${proxyUrl}/api/pages/page-secret`, {
      headers: { cookie: "session=bob" }
    });
    const secondBody = await second.json();

    return {
      firstRequestCacheStatus: first.headers.get("x-cache"),
      secondRequestCacheStatus: second.headers.get("x-cache"),
      firstResponseOwner: firstBody.owner,
      secondResponseOwner: secondBody.owner,
      cacheControl: second.headers.get("cache-control"),
      crossUserDisclosure: secondBody.owner !== "bob"
    };
  } finally {
    await close(proxy);
    await close(origin);
  }
}

const vulnerable = await runScenario(false);
const fixed = await runScenario(true);

assert.equal(vulnerable.firstRequestCacheStatus, "MISS");
assert.equal(vulnerable.secondRequestCacheStatus, "HIT");
assert.equal(vulnerable.firstResponseOwner, "alice");
assert.equal(vulnerable.secondResponseOwner, "alice");
assert.equal(vulnerable.crossUserDisclosure, true);
assert.equal(fixed.firstRequestCacheStatus, "MISS");
assert.equal(fixed.secondRequestCacheStatus, "MISS");
assert.equal(fixed.firstResponseOwner, "alice");
assert.equal(fixed.secondResponseOwner, "bob");
assert.equal(fixed.cacheControl, privateNoStoreCacheControl);
assert.equal(fixed.crossUserDisclosure, false);

console.log(JSON.stringify({
  scenario: "cookie-authenticated API behind a URI-keyed shared cache with a default TTL",
  vulnerable,
  fixed
}, null, 2));
