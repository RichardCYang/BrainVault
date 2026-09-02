import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify
} from "node:crypto";
import { readFile } from "node:fs/promises";

const origin = "https://notes.example.test";
const rpID = "example.test";
const genericFailure = Object.freeze({
  ok: false,
  error: { code: "PASSKEY_LOGIN_FAILED", message: "The passkey could not be verified" }
});

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function hashToken(value) {
  return sha256(Buffer.from(value, "utf8")).toString("hex");
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function equalBytes(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeCanonicalBase64Url(value, maxBytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("boundary");
  const decoded = Buffer.from(value, "base64url");
  if (!decoded.length || decoded.length > maxBytes || decoded.toString("base64url") !== value) {
    throw new Error("boundary");
  }
  return decoded;
}

function hasExactKeys(value, requiredKeys, optionalKeys = []) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isBoundedClientExtensionResults(value) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;

  const stack = [{ value, depth: 0 }];
  let visitedNodes = 0;
  while (stack.length) {
    const current = stack.pop();
    visitedNodes += 1;
    if (visitedNodes > 256 || current.depth > 8) return false;
    const candidate = current.value;
    if (
      candidate === null
      || typeof candidate === "boolean"
      || (typeof candidate === "number" && Number.isFinite(candidate))
      || (typeof candidate === "string" && candidate.length <= 2_048)
    ) continue;
    if (Array.isArray(candidate)) {
      if (candidate.length > 64) return false;
      for (const item of candidate) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (typeof candidate !== "object" || Object.getPrototypeOf(candidate) !== Object.prototype) return false;
    const entries = Object.entries(candidate);
    if (entries.length > 32) return false;
    for (const [key, item] of entries) {
      if (
        !key
        || key.length > 128
        || key === "__proto__"
        || key === "prototype"
        || key === "constructor"
      ) return false;
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 8 * 1024;
}

function assertStrictAuthenticationResponse(response) {
  if (!hasExactKeys(
    response,
    ["id", "rawId", "type", "clientExtensionResults", "response"],
    ["authenticatorAttachment"]
  )) throw new Error("response shape");
  if (response.type !== "public-key") throw new Error("credential type");
  if (!isBoundedClientExtensionResults(response.clientExtensionResults)) {
    throw new Error("client extension boundary");
  }
  if (!hasExactKeys(
    response.response,
    ["clientDataJSON", "authenticatorData", "signature", "userHandle"]
  )) throw new Error("authenticator response shape");
}

function encodeCoseP256PublicKey(publicKey) {
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("missing coordinates");
  const x = decodeCanonicalBase64Url(jwk.x, 32);
  const y = decodeCanonicalBase64Url(jwk.y, 32);
  if (x.length !== 32 || y.length !== 32) throw new Error("invalid P-256 coordinates");
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y
  ]);
}

function decodeCoseP256PublicKey(cose) {
  const bytes = Buffer.from(cose);
  const prefix = Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]);
  const separator = Buffer.from([0x22, 0x58, 0x20]);
  if (
    bytes.length !== prefix.length + 32 + separator.length + 32
    || !bytes.subarray(0, prefix.length).equals(prefix)
    || !bytes.subarray(prefix.length + 32, prefix.length + 32 + separator.length).equals(separator)
  ) throw new Error("unsupported COSE key");
  const x = bytes.subarray(prefix.length, prefix.length + 32).toString("base64url");
  const y = bytes.subarray(prefix.length + 32 + separator.length).toString("base64url");
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });
}

function makeFixture({ storedCounter = 0 } = {}) {
  const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const user = {
    id: "usr_0123456789abcdef0123456789abcdef",
    username: "passkey-user",
    authVersion: 9
  };
  const passkey = {
    id: "pky_0123456789abcdef0123456789abcdef",
    userId: user.id,
    credentialId: randomBytes(32),
    userHandle: Buffer.from(user.id, "utf8"),
    publicKeyCose: encodeCoseP256PublicKey(keyPair.publicKey),
    counter: storedCounter
  };
  const challengeRows = new Map();

  function issueCeremony() {
    const challenge = randomToken();
    const challengeToken = randomToken();
    const binding = randomToken();
    challengeRows.set(hashToken(challengeToken), {
      bindingHash: hashToken(binding),
      challenge,
      used: false,
      expiresAt: Date.now() + 5 * 60_000
    });
    return { challenge, challengeToken, binding };
  }

  function buildAssertion(challenge, overrides = {}) {
    const credentialId = overrides.credentialId ?? passkey.credentialId;
    const rawCredentialId = overrides.rawCredentialId ?? credentialId;
    const userHandle = overrides.userHandle ?? passkey.userHandle;
    const assertionOrigin = overrides.origin ?? origin;
    const assertionRpID = overrides.rpID ?? rpID;
    const flags = overrides.flags ?? 0x05;
    const counter = overrides.counter ?? passkey.counter + 1;
    const signingKey = overrides.signingKey ?? keyPair.privateKey;

    const clientDataJSON = Buffer.from(JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin: assertionOrigin,
      crossOrigin: false
    }), "utf8");
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const authenticatorData = Buffer.concat([
      sha256(Buffer.from(assertionRpID, "utf8")),
      Buffer.from([flags]),
      counterBytes
    ]);
    const signedData = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    let signature = sign("sha256", signedData, signingKey);
    if (overrides.tamperSignature) {
      signature = Buffer.from(signature);
      signature[signature.length - 1] ^= 0x01;
    }

    return {
      id: credentialId.toString("base64url"),
      rawId: rawCredentialId.toString("base64url"),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authenticatorData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: userHandle.toString("base64url")
      }
    };
  }

  function consumeChallenge(challengeToken, binding) {
    if (typeof challengeToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challengeToken)) {
      throw new Error("token boundary");
    }
    const row = challengeRows.get(hashToken(challengeToken));
    if (!row || row.bindingHash !== hashToken(binding) || row.used || row.expiresAt <= Date.now()) {
      throw new Error("ceremony");
    }
    // Consume before any credential or signature verification to make every token one-shot.
    row.used = true;
    return row.challenge;
  }

  function authenticate({ challengeToken, binding, response, beforeCommit } = {}) {
    try {
      const expectedChallenge = consumeChallenge(challengeToken, binding);
      assertStrictAuthenticationResponse(response);
      const credentialId = decodeCanonicalBase64Url(response.id, 1023);
      const rawCredentialId = decodeCanonicalBase64Url(response.rawId, 1023);
      if (!equalBytes(credentialId, rawCredentialId)) throw new Error("credential ID mismatch");
      if (!equalBytes(credentialId, passkey.credentialId)) throw new Error("unknown credential");

      const userHandle = decodeCanonicalBase64Url(response.response.userHandle, 64);
      if (!equalBytes(userHandle, passkey.userHandle)) throw new Error("user handle mismatch");

      const clientDataJSON = decodeCanonicalBase64Url(response.response.clientDataJSON, 12_288);
      const clientData = JSON.parse(clientDataJSON.toString("utf8"));
      if (
        clientData.type !== "webauthn.get"
        || clientData.challenge !== expectedChallenge
        || clientData.origin !== origin
        || clientData.crossOrigin === true
      ) throw new Error("client data mismatch");

      const authenticatorData = decodeCanonicalBase64Url(response.response.authenticatorData, 12_288);
      if (authenticatorData.length < 37) throw new Error("authenticator data too short");
      if (!equalBytes(authenticatorData.subarray(0, 32), sha256(Buffer.from(rpID, "utf8")))) {
        throw new Error("RP ID hash mismatch");
      }
      const flags = authenticatorData[32];
      if ((flags & 0x01) === 0 || (flags & 0x04) === 0) throw new Error("UP/UV missing");
      const newCounter = authenticatorData.readUInt32BE(33);
      if (passkey.counter > 0 && newCounter <= passkey.counter) throw new Error("counter regression");

      const signature = decodeCanonicalBase64Url(response.response.signature, 3_072);
      const publicKey = decodeCoseP256PublicKey(passkey.publicKeyCose);
      const signedData = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
      if (!verify("sha256", signedData, publicKey, signature)) throw new Error("signature mismatch");

      const verifiedSnapshot = {
        id: passkey.id,
        userId: passkey.userId,
        credentialId: Buffer.from(passkey.credentialId),
        userHandle: Buffer.from(passkey.userHandle),
        publicKeyCose: Buffer.from(passkey.publicKeyCose),
        counter: passkey.counter
      };
      beforeCommit?.(passkey);
      if (
        passkey.id !== verifiedSnapshot.id
        || passkey.userId !== verifiedSnapshot.userId
        || passkey.counter !== verifiedSnapshot.counter
        || !equalBytes(passkey.credentialId, verifiedSnapshot.credentialId)
        || !equalBytes(passkey.userHandle, verifiedSnapshot.userHandle)
        || !equalBytes(passkey.publicKeyCose, verifiedSnapshot.publicKeyCose)
      ) throw new Error("credential changed after verification");

      passkey.counter = newCounter;
      return { ok: true, user: { id: user.id, username: user.username }, counter: newCounter };
    } catch {
      return structuredClone(genericFailure);
    }
  }

  return { user, passkey, issueCeremony, buildAssertion, authenticate };
}

function runSuccessAndReplay() {
  const fixture = makeFixture();
  const ceremony = fixture.issueCeremony();
  const response = fixture.buildAssertion(ceremony.challenge);
  const success = fixture.authenticate({ ...ceremony, response });
  const replay = fixture.authenticate({ ...ceremony, response });
  return { success, replay };
}

function runAttack({ fixtureOptions, assertionOverrides, requestOverrides, beforeCommit } = {}) {
  const fixture = makeFixture(fixtureOptions);
  const ceremony = fixture.issueCeremony();
  const response = fixture.buildAssertion(ceremony.challenge, assertionOverrides);
  return fixture.authenticate({
    challengeToken: requestOverrides?.challengeToken ?? ceremony.challengeToken,
    binding: requestOverrides?.binding ?? ceremony.binding,
    response,
    beforeCommit
  });
}

const { success, replay } = runSuccessAndReplay();
assert.equal(success.ok, true);
assert.deepEqual(replay, genericFailure);

const copiedChallenge = (() => {
  const fixture = makeFixture();
  const ceremony = fixture.issueCeremony();
  return fixture.authenticate({
    ...ceremony,
    binding: randomToken(),
    response: fixture.buildAssertion(ceremony.challenge)
  });
})();

const malformedResponseReplay = (() => {
  const fixture = makeFixture();
  const ceremony = fixture.issueCeremony();
  const malformed = { ...fixture.buildAssertion(ceremony.challenge), unexpected: true };
  const first = fixture.authenticate({ ...ceremony, response: malformed });
  const replayAttempt = fixture.authenticate({
    ...ceremony,
    response: fixture.buildAssertion(ceremony.challenge)
  });
  assert.deepEqual(first, genericFailure);
  return replayAttempt;
})();

const attackResults = {
  copiedChallenge,
  malformedResponseReplay,
  unexpectedNestedField: (() => {
    const fixture = makeFixture();
    const ceremony = fixture.issueCeremony();
    const response = fixture.buildAssertion(ceremony.challenge);
    response.response.unexpected = true;
    return fixture.authenticate({ ...ceremony, response });
  })(),
  wrongOrigin: runAttack({ assertionOverrides: { origin: "https://attacker.example" } }),
  wrongRpId: runAttack({ assertionOverrides: { rpID: "attacker.example" } }),
  missingUserVerification: runAttack({ assertionOverrides: { flags: 0x01 } }),
  wrongUserHandle: runAttack({ assertionOverrides: { userHandle: Buffer.from("usr_attacker", "utf8") } }),
  mismatchedCredentialIds: runAttack({ assertionOverrides: { rawCredentialId: randomBytes(32) } }),
  counterRegression: runAttack({ fixtureOptions: { storedCounter: 7 }, assertionOverrides: { counter: 7 } }),
  tamperedSignature: runAttack({ assertionOverrides: { tamperSignature: true } }),
  invalidChallengeTokenShape: runAttack({ requestOverrides: { challengeToken: "not-issued" } }),
  oversizedClientExtensionResults: (() => {
    const fixture = makeFixture();
    const ceremony = fixture.issueCeremony();
    const response = fixture.buildAssertion(ceremony.challenge);
    response.clientExtensionResults = { oversized: "x".repeat(9 * 1024) };
    return fixture.authenticate({ ...ceremony, response });
  })(),
  unknownCredential: runAttack({ assertionOverrides: { credentialId: randomBytes(32), rawCredentialId: randomBytes(32) } }),
  credentialStateRace: runAttack({
    beforeCommit(current) {
      const replacement = generateKeyPairSync("ec", { namedCurve: "P-256" });
      current.publicKeyCose = encodeCoseP256PublicKey(replacement.publicKey);
    }
  })
};

for (const [name, outcome] of Object.entries(attackResults)) {
  assert.deepEqual(outcome, genericFailure, `${name} must fail with the generic response`);
}

const [routeSource, cookieSource, migrationSource, clientSource, registrationSource, appSource] = await Promise.all([
  readFile(new URL("../src/routes/passkey-login.routes.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/passkey-ceremony-cookie.ts", import.meta.url), "utf8"),
  readFile(new URL("../migrations/040_passkey_direct_login.sql", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/routes/mfa.routes.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app.ts", import.meta.url), "utf8")
]);

const staticContract = {
  discoverableOptions: /allowCredentials:\s*\[\]/.test(routeSource),
  userVerificationRequired: /userVerification:\s*"required"/.test(routeSource)
    && /requireUserVerification:\s*true/.test(routeSource),
  exactOriginAndRpId: /expectedOrigin:\s*webAuthnConfig\.origins/.test(routeSource)
    && /expectedRPID:\s*webAuthnConfig\.rpID/.test(routeSource),
  oneTimeChallenge: /SET used_at = CURRENT_TIMESTAMP\(3\)/.test(routeSource),
  cookieBinding: /binding_hash/.test(routeSource)
    && /httpOnly:\s*true/.test(cookieSource)
    && /sameSite:\s*"strict"/.test(cookieSource),
  canonicalCredentialBoundary: /decodeBase64UrlStrict/.test(routeSource)
    && /equalBytes\(credentialId, rawCredentialId\)/.test(routeSource),
  exactOpaqueTokenBoundary: /opaqueTokenPattern = \/\^\[A-Za-z0-9_\-\]\{43\}\$\//.test(routeSource),
  strictResponseShape: /directPasskeyResponseSchema[\s\S]*?\.strict\(\)/.test(routeSource)
    && /verifySchema[\s\S]*?\.strict\(\)/.test(routeSource),
  schemaIndependentExactKeyContract: /function hasStrictDirectPasskeyShape/.test(routeSource)
    && /if \(!hasStrictDirectPasskeyShape\(req\.body\)\) throw loginFailure\(\)/.test(routeSource),
  boundedClientExtensions: /maxClientExtensionResultsBytes = 8 \* 1024/.test(routeSource)
    && /maxClientExtensionNodes = 256/.test(routeSource),
  boundedAnonymousRequestBody: /app\.use\("\/api\/auth\/passkey", express\.json\(\{ limit: "64kb" \}\)\)/
    .test(appSource)
    && /app\.use\("\/api\/auth\/mfa\/login\/passkey", express\.json\(\{ limit: "64kb" \}\)\)/.test(appSource),
  consumeBeforeFullValidation: routeSource.indexOf("consumePasskeyLoginChallenge(challengeToken, binding, sourceIp)")
    < routeSource.indexOf("verifySchema.safeParse(req.body)"),
  userHandleBinding: /equalBytes\(userHandle, passkey\.webauthn_user_id\)/.test(routeSource),
  stableCredentialCommit: /assertStablePasskey/.test(routeSource)
    && /WHERE id = \? AND user_id = \? AND counter = \?/.test(routeSource),
  genericFailure: /PASSKEY_LOGIN_FAILED/.test(routeSource),
  boundedAnonymousStorage: /passkey_login_challenges/.test(migrationSource)
    && /expires_at DATETIME\(3\) NOT NULL/.test(migrationSource),
  browserUserHandleSerialization: /response\.userHandle/.test(clientSource),
  newRegistrationsAreDiscoverable: /residentKey:\s*"required"/.test(registrationSource)
};

for (const [name, passed] of Object.entries(staticContract)) {
  assert.equal(passed, true, `static contract failed: ${name}`);
}

const report = {
  schemaVersion: 2,
  cryptographicVerification: {
    validP256AssertionAccepted: success.ok === true,
    counterAdvanced: success.counter === 1,
    tamperedSignatureRejected: attackResults.tamperedSignature.ok === false
  },
  attackReproductions: Object.fromEntries(
    Object.entries({ replay, ...attackResults }).map(([name, outcome]) => [
      name,
      outcome.ok === false && outcome.error?.code === "PASSKEY_LOGIN_FAILED"
    ])
  ),
  staticContract,
  allPassed: true
};

console.log(JSON.stringify(report, null, 2));
