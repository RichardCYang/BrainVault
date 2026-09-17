import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import test from "node:test";

const ts = createRequire(import.meta.url)("typescript");
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const parse = (name) => ts.createSourceFile(name, read(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// Execute selected production declarations with explicit isolated dependencies.
// These tests cover registration/validation, not Express HTTP, the database,
// network policy, or cryptographic verification of bookmark previews.
function declaration(source, name) {
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const found = statement.declarationList.declarations.find((item) => item.name.getText(source) === name);
      if (found) return `const ${found.getText(source)};`;
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
      return statement.getText(source).replace(/^export\s+/, "");
    }
  }
  throw new Error(`Missing production declaration: ${name}`);
}

function evaluate(source, dependencies, result) {
  const javascript = stripTypeScriptTypes(source);
  return new Function(...Object.keys(dependencies), `${javascript}\nreturn (${result});`)(...Object.values(dependencies));
}

const integritySource = parse("src/lib/structured-metadata-integrity.ts");
const bookmarkSource = parse("src/lib/bookmark.ts");
const rateLimitSource = parse("src/middleware/auth-rate-limit.ts");
const integrityLimits = evaluate(declaration(integritySource, "bookmarkLimits"), {}, "bookmarkLimits");
const bookmarkLimits = evaluate(declaration(bookmarkSource, "bookmarkLimits"), {}, "bookmarkLimits");

const bookmarkValidator = evaluate([
  "bookmarkLimits", "unsafeMetadataKeys", "StructuredMetadataIntegrityError", "fail", "isRecord",
  "assertAllowedKeys", "optionalRecord", "optionalArray", "optionalString", "optionalBoolean",
  "optionalFiniteNumber", "assertUnique", "assertCanonicalBookmarkText", "canonicalBookmarkUrl",
  "assertBookmarkMetadata"
].map((name) => declaration(integritySource, name)).join("\n"), {
  isPrivateOrLocalHostname: (hostname) => {
    assert.equal(hostname, "example.com", "Token tests must use the isolated public-host fixture");
    return false;
  }
}, "({ validate: assertBookmarkMetadata, IntegrityError: StructuredMetadataIntegrityError })");

function metadata(previewToken) {
  const item = { id: "bookmark-build-regression", url: "https://example.com/", title: "Example" };
  if (previewToken !== undefined) item.previewToken = previewToken;
  return { bookmark: { title: "Bookmarks", view: "gallery", items: [item] } };
}

test("build regression: bookmark token limit exists and matches the normalizer", () => {
  assert.equal(integrityLimits.previewTokenLength, 64);
  for (const [name, expected] of Object.entries(bookmarkLimits)) {
    if (name === "htmlBytes" || name === "redirects") continue;
    assert.equal(integrityLimits[name], expected, `Bookmark limit drift: ${name}`);
  }
});

for (const [name, value] of [
  ["absent", undefined], ["null", null], ["empty", ""],
  ["43-character base64url", Buffer.alloc(32, 5).toString("base64url")],
  ["base64url hyphen and underscore", "_-".repeat(21) + "A"]
]) {
  test(`build regression: bookmark preview token accepts ${name} without rewriting metadata`, () => {
    const input = metadata(value);
    const before = JSON.stringify(input);
    assert.doesNotThrow(() => bookmarkValidator.validate(input));
    assert.equal(JSON.stringify(input), before);
  });
}

for (const [name, value] of [
  ["42 characters", "A".repeat(42)], ["44 characters", "A".repeat(44)],
  ["64 characters", "A".repeat(64)], ["65 characters", "A".repeat(65)],
  ["an oversized value", "A".repeat(4_096)], ["a number", 123],
  ["an object", {}], ["an array", []], ["leading whitespace", " " + "A".repeat(43)],
  ["trailing whitespace", "A".repeat(43) + " "], ["a base64 plus", "+" + "A".repeat(42)],
  ["a base64 slash", "/" + "A".repeat(42)], ["base64 padding", "A".repeat(42) + "="]
]) {
  test(`build regression: bookmark preview token rejects ${name}`, () => {
    assert.throws(() => bookmarkValidator.validate(metadata(value)), (error) => {
      assert.ok(error instanceof bookmarkValidator.IntegrityError);
      assert.equal(error.path, "metadata.bookmark.items[0].previewToken");
      return true;
    });
  });
}

test("build regression: an oversized preview token hits the numeric limit before format validation", () => {
  assert.throws(() => bookmarkValidator.validate(metadata("A".repeat(65))), /the maximum is 64/);
});

function resetHelper(resetKey) {
  return evaluate([
    declaration(rateLimitSource, "hashRateLimitKey"),
    declaration(rateLimitSource, "clearPasswordLoginAccountLimit")
  ].join("\n"), { createHash, loginAccountRateLimit: { resetKey } }, "clearPasswordLoginAccountLimit");
}

const routes = [
  ["src/routes/auth.routes.ts", "authRouter", "put", "/totp-ip-block-policy", "requireAuth", "totpIpBlockPolicySchema"],
  ["src/routes/auth.routes.ts", "authRouter", "delete", "/totp-ip-blocks/:ipAddress", "requireAuthAllowTotpIpBlock", "totpIpUnblockSchema"],
  ["src/routes/auth.routes.ts", "authRouter", "put", "/vpn-block-policy", "requireAuth", "vpnBlockPolicySchema"],
  ["src/routes/auth.routes.ts", "authRouter", "put", "/country-login-policy", "requireAuth", "countryLoginPolicySchema"],
  ["src/routes/auth.routes.ts", "authRouter", "post", "/password", "requireAuth", "passwordSchema"],
  ["src/routes/passkey-login.routes.ts", "passkeyLoginRouter", "post", "/options", "requireSameOriginBrowserRequest", "optionsSchema"]
];

function routeStatement(source, router, method, routePath) {
  return source.statements.find((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    return ts.isPropertyAccessExpression(call.expression)
      && call.expression.expression.getText(source) === router
      && call.expression.name.text === method
      && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === routePath;
  });
}

for (const [file, router, method, routePath, authentication, schema] of routes) {
  test(`build regression: ${router} ${method.toUpperCase()} ${routePath} keeps middleware in order without the username helper`, async () => {
    const source = parse(file);
    const statement = routeStatement(source, router, method, routePath);
    assert.ok(statement, `Missing route ${routePath}`);
    let registered;
    const passThrough = (_req, _res, next) => next();
    const clearPasswordLoginAccountLimit = resetHelper(() => assert.fail("Must not clear an account before authentication succeeds"));
    evaluate(statement.getText(source), {
      [router]: { [method]: (_path, ...handlers) => { registered = handlers; } },
      [authentication]: passThrough,
      requireJsonRequestBody: passThrough,
      accountReauthenticationRateLimit: passThrough,
      loginLockoutRecoveryRateLimit: passThrough,
      passkeyLoginOptionsIpRateLimit: passThrough,
      clearPasswordLoginAccountLimit,
      validate: () => passThrough,
      [schema]: {},
      totpIpBlockParamsSchema: {}
    }, "undefined");
    assert.ok(registered);
    assert.ok(!registered.includes(clearPasswordLoginAccountLimit), "A username-taking helper is not Express middleware");
    const middlewareNames = statement.expression.arguments.slice(1, -1).map((argument) =>
      ts.isCallExpression(argument) ? argument.expression.getText(source) : argument.getText(source));
    assert.deepEqual(middlewareNames, router === "passkeyLoginRouter"
      ? [authentication, "requireJsonRequestBody", "passkeyLoginOptionsIpRateLimit", "validate"]
      : [authentication, "accountReauthenticationRateLimit", "loginLockoutRecoveryRateLimit", "validate"]);

    // Replay the registered pre-handler chain using a Request-shaped object.
    // The original bug passed this object to username.trim(). The business
    // handler itself is deliberately not executed in this isolated test.
    let reachedHandler = false;
    const req = { body: {}, params: {}, user: { id: "usr_test", username: "tester" } };
    const advance = async (index) => {
      if (index === registered.length - 1) { reachedHandler = true; return; }
      let forwarded;
      await registered[index](req, {}, (error) => {
        forwarded = error ? Promise.reject(error) : advance(index + 1);
        return forwarded;
      });
      assert.ok(forwarded, "A pre-handler middleware must forward or respond");
      await forwarded;
    };
    await assert.doesNotReject(() => advance(0));
    assert.equal(reachedHandler, true);
  });
}

test("build regression: authenticated account reset still normalizes and hashes only the account key", async () => {
  const cleared = [];
  const clear = resetHelper(async (key) => { cleared.push(key); });
  await clear("  Test-User  ");
  assert.deepEqual(cleared, [`account:${createHash("sha256").update("test-user").digest("hex")}`]);
  await clear("   ");
  assert.equal(cleared.length, 1);
});

test("build regression: authenticated account reset awaits asynchronous completion", async () => {
  let complete;
  let finished = false;
  const clear = resetHelper(() => new Promise((resolve) => { complete = resolve; }));
  const pending = clear("tester").then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  complete();
  await pending;
  assert.equal(finished, true);
});

test("build regression: authenticated account reset propagates storage failures", async () => {
  const failure = new Error("isolated store failure");
  await assert.rejects(resetHelper(async () => { throw failure; })("tester"), (error) => error === failure);
});

test("build regression: legitimate post-authentication reset calls remain awaited", () => {
  for (const [file, expected] of [
    ["src/routes/auth.routes.ts", "username"],
    ["src/routes/passkey-login.routes.ts", "result.user.username"]
  ]) {
    const source = parse(file);
    const calls = [];
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === "clearPasswordLoginAccountLimit") calls.push(node);
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.equal(calls.length, 1, `${file}: preserve exactly the existing legitimate reset call`);
    assert.ok(ts.isAwaitExpression(calls[0].parent));
    assert.equal(calls[0].arguments[0].getText(source), expected);
  }
});
