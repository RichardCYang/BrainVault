import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject
} from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: database,
  transaction: async (fn: (client: unknown) => unknown) => fn(database)
}));

import { createApp } from "../src/app.js";

type ChallengeRow = {
  token_hash: string;
  binding_hash: string;
  challenge: string;
  source_ip: string;
  expires_at: Date;
  used_at: Date | null;
};

type PasskeyRow = {
  id: string;
  user_id: string;
  credential_id: Buffer;
  webauthn_user_id: Buffer;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  device_type: string;
  backed_up: number;
};

const origin = "http://localhost:4000";
const rpID = "localhost";
const challenges = new Map<string, ChallengeRow>();
const loginOutcomes: string[] = [];
let user: Record<string, unknown>;
let passkey: PasskeyRow | null;
let privateKey: KeyObject;
let passkeyUpdateAffectedRows: number;

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest();
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url");
}

function encodeCoseP256PublicKey(publicKey: KeyObject) {
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("P-256 JWK did not include affine coordinates");
  }
  const x = decodeBase64Url(jwk.x);
  const y = decodeBase64Url(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error("Invalid P-256 coordinate length");

  // COSE_Key: { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y
  ]);
}

function buildAssertion(
  challenge: string,
  {
    credentialId = passkey?.credential_id ?? Buffer.alloc(0),
    rawCredentialId = credentialId,
    userHandle = passkey?.webauthn_user_id ?? Buffer.alloc(0),
    assertionOrigin = origin,
    assertionRpID = rpID,
    flags = 0x05,
    counter = (passkey?.counter ?? 0) + 1,
    signingKey = privateKey
  }: {
    credentialId?: Buffer;
    rawCredentialId?: Buffer;
    userHandle?: Buffer;
    assertionOrigin?: string;
    assertionRpID?: string;
    flags?: number;
    counter?: number;
    signingKey?: KeyObject;
  } = {}
) {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin: assertionOrigin,
    crossOrigin: false
  }), "utf8");
  const counterBuffer = Buffer.alloc(4);
  counterBuffer.writeUInt32BE(counter);
  const authenticatorData = Buffer.concat([
    sha256(assertionRpID),
    Buffer.from([flags]),
    counterBuffer
  ]);
  const signedData = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  const signature = sign("sha256", signedData, signingKey);

  return {
    id: credentialId.toString("base64url"),
    rawId: rawCredentialId.toString("base64url"),
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientDataJSON.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url"),
      userHandle: userHandle.toString("base64url")
    }
  };
}

async function issueOptions(agent = request.agent(createApp())) {
  const response = await agent
    .post("/api/auth/passkey/options")
    .set("Origin", origin)
    .send({})
    .expect(200);
  return { agent, response };
}

beforeEach(() => {
  challenges.clear();
  loginOutcomes.length = 0;

  user = {
    id: "usr_0123456789abcdef0123456789abcdef",
    username: "passkey-user",
    name: "Passkey User",
    avatar_data: null,
    preferred_language: "ko",
    default_collection_icon: null,
    theme: "light",
    password_hash: "unused-for-passkey-login",
    auth_version: 7,
    failed_login_attempts: 4,
    last_failed_login_at: "2026-08-09T00:00:00.000Z",
    login_locked_until: "2026-08-09T01:00:00.000Z",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z"
  };

  const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  privateKey = keyPair.privateKey;
  passkeyUpdateAffectedRows = 1;
  passkey = {
    id: "pky_0123456789abcdef0123456789abcdef",
    user_id: String(user.id),
    credential_id: randomBytes(32),
    webauthn_user_id: Buffer.from(String(user.id), "utf8"),
    public_key: encodeCoseP256PublicKey(keyPair.publicKey),
    counter: 0,
    transports: "internal,hybrid",
    device_type: "singleDevice",
    backed_up: 0
  };

  database.query.mockReset().mockResolvedValue([]);
  database.queryOne.mockReset().mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM passkey_login_challenges")) {
      const row = challenges.get(String(params[0]));
      if (
        !row
        || row.binding_hash !== String(params[1])
        || row.used_at
        || row.expires_at.getTime() <= Date.now()
      ) return undefined;
      return { ...row };
    }
    if (sql.includes("FROM user_passkeys") && sql.includes("WHERE credential_id = ?")) {
      const supplied = Buffer.from(params[0] as Buffer);
      return passkey && supplied.equals(passkey.credential_id) ? { ...passkey } : undefined;
    }
    if (sql.includes("SELECT * FROM users WHERE id = ? FOR UPDATE")) {
      return String(params[0]) === user.id ? { ...user } : undefined;
    }
    if (sql.includes("FROM user_passkeys") && sql.includes("WHERE id = ? AND user_id = ?")) {
      return passkey && params[0] === passkey.id && params[1] === passkey.user_id
        ? { ...passkey }
        : undefined;
    }
    return undefined;
  });

  database.execute.mockReset().mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("INSERT INTO passkey_login_challenges")) {
      challenges.set(String(params[0]), {
        token_hash: String(params[0]),
        binding_hash: String(params[1]),
        challenge: String(params[2]),
        source_ip: String(params[3]),
        expires_at: params[4] as Date,
        used_at: null
      });
      return { affectedRows: 1 };
    }
    if (sql.includes("UPDATE passkey_login_challenges") && sql.includes("SET used_at")) {
      const row = challenges.get(String(params[0]));
      if (
        !row
        || row.binding_hash !== String(params[1])
        || row.used_at
        || row.expires_at.getTime() <= Date.now()
      ) return { affectedRows: 0 };
      row.used_at = new Date();
      return { affectedRows: 1 };
    }
    if (sql.includes("UPDATE user_passkeys") && sql.includes("SET counter = ?")) {
      if (
        !passkey
        || params[3] !== passkey.id
        || params[4] !== passkey.user_id
        || Number(params[5]) !== passkey.counter
      ) return { affectedRows: 0 };
      passkey.counter = Number(params[0]);
      passkey.device_type = String(params[1]);
      passkey.backed_up = Number(Boolean(params[2]));
      return { affectedRows: passkeyUpdateAffectedRows };
    }
    if (sql.includes("UPDATE users") && sql.includes("failed_login_attempts = 0")) {
      user.failed_login_attempts = 0;
      user.last_failed_login_at = null;
      user.login_locked_until = null;
      return { affectedRows: 1 };
    }
    if (sql.includes("INSERT INTO user_login_attempts")) {
      loginOutcomes.push(String(params[3]));
      return { affectedRows: 1 };
    }
    return { affectedRows: 1 };
  });
});

describe("direct discoverable-passkey login", () => {
  it("issues username-less options and authenticates a real P-256 WebAuthn assertion", async () => {
    const { agent, response: optionsResponse } = await issueOptions();

    expect(optionsResponse.body.options).toMatchObject({
      rpId: rpID,
      allowCredentials: [],
      userVerification: "required"
    });
    expect(optionsResponse.body.challengeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(optionsResponse.headers["cache-control"]).toContain("no-store");
    expect(optionsResponse.headers["set-cookie"]?.join(";")).toContain("HttpOnly");
    expect(optionsResponse.headers["set-cookie"]?.join(";")).toContain("SameSite=Strict");

    const verifyResponse = await agent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({
        challengeToken: optionsResponse.body.challengeToken,
        response: buildAssertion(optionsResponse.body.options.challenge)
      })
      .expect(200);

    expect(verifyResponse.body.user).toMatchObject({
      id: user.id,
      username: user.username,
      preferredLanguage: "ko"
    });
    expect(verifyResponse.body.token).toBeUndefined();
    expect(verifyResponse.headers["set-cookie"]?.join(";")).toContain("brainvault_session=");
    expect(verifyResponse.headers["set-cookie"]?.join(";")).toContain("HttpOnly");
    expect(passkey?.counter).toBe(1);
    expect(user.failed_login_attempts).toBe(0);
    expect(loginOutcomes).toContain("SUCCESS");
  });

  it("accepts a confirmed no-op write for a legitimate zero-counter authenticator", async () => {
    if (!passkey) throw new Error("Passkey fixture is missing");
    passkey.counter = 0;
    passkeyUpdateAffectedRows = 0;
    const { agent, response: optionsResponse } = await issueOptions();

    const verifyResponse = await agent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({
        challengeToken: optionsResponse.body.challengeToken,
        response: buildAssertion(optionsResponse.body.options.challenge, { counter: 0 })
      })
      .expect(200);

    expect(verifyResponse.body.user).toMatchObject({ id: user.id });
    expect(passkey.counter).toBe(0);
    expect(loginOutcomes).toContain("SUCCESS");
  });

  it("binds a challenge to the HttpOnly ceremony cookie", async () => {
    const { response: optionsResponse } = await issueOptions();
    const response = await request(createApp())
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({
        challengeToken: optionsResponse.body.challengeToken,
        response: buildAssertion(optionsResponse.body.options.challenge)
      })
      .expect(401);

    expect(response.body.error.code).toBe("PASSKEY_LOGIN_FAILED");
  });

  it("consumes a challenge before verification so a corrected replay is rejected", async () => {
    const { agent, response: optionsResponse } = await issueOptions();
    const invalid = buildAssertion(optionsResponse.body.options.challenge, {
      assertionOrigin: "https://attacker.example"
    });

    const first = await agent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({ challengeToken: optionsResponse.body.challengeToken, response: invalid })
      .expect(401);
    const replay = await agent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({
        challengeToken: optionsResponse.body.challengeToken,
        response: buildAssertion(optionsResponse.body.options.challenge)
      })
      .expect(401);

    expect(first.body.error.code).toBe("PASSKEY_LOGIN_FAILED");
    expect(replay.body).toEqual(first.body);
  });

  it("consumes a valid challenge token before strict response-shape validation", async () => {
    const { agent, response: optionsResponse } = await issueOptions();
    const assertion = buildAssertion(optionsResponse.body.options.challenge) as Record<string, unknown>;
    assertion.unexpected = true;

    const malformed = await agent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({ challengeToken: optionsResponse.body.challengeToken, response: assertion })
      .expect(401);
    const replay = await agent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({
        challengeToken: optionsResponse.body.challengeToken,
        response: buildAssertion(optionsResponse.body.options.challenge)
      })
      .expect(401);

    expect(malformed.body.error.code).toBe("PASSKEY_LOGIN_FAILED");
    expect(replay.body).toEqual(malformed.body);
  });

  it("rejects an unexpected nested assertion field and consumes the challenge", async () => {
    const { agent, response: optionsResponse } = await issueOptions();
    const assertion = buildAssertion(optionsResponse.body.options.challenge) as Record<string, unknown>;
    (assertion.response as Record<string, unknown>).unexpected = true;

    const malformed = await agent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({ challengeToken: optionsResponse.body.challengeToken, response: assertion })
      .expect(401);
    const replay = await agent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({
        challengeToken: optionsResponse.body.challengeToken,
        response: buildAssertion(optionsResponse.body.options.challenge)
      })
      .expect(401);

    expect(malformed.body.error.code).toBe("PASSKEY_LOGIN_FAILED");
    expect(replay.body).toEqual(malformed.body);
  });

  it("rejects an oversized anonymous passkey body before creating ceremony state", async () => {
    const response = await request(createApp())
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(70 * 1024) }))
      .expect(413);

    expect(response.body.error.code).toBe("REQUEST_BODY_TOO_LARGE");
    expect(challenges.size).toBe(0);
  });

  it("rejects oversized client extension results with the generic failure response", async () => {
    const { agent, response: optionsResponse } = await issueOptions();
    const assertion = buildAssertion(optionsResponse.body.options.challenge);
    assertion.clientExtensionResults = { oversized: "x".repeat(9 * 1024) };

    const response = await agent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({ challengeToken: optionsResponse.body.challengeToken, response: assertion })
      .expect(401);

    expect(response.body.error.code).toBe("PASSKEY_LOGIN_FAILED");
  });

  it("rejects wrong RP ID hashes and assertions without user verification", async () => {
    for (const responseFactory of [
      (challenge: string) => buildAssertion(challenge, { assertionRpID: "attacker.example" }),
      (challenge: string) => buildAssertion(challenge, { flags: 0x01 })
    ]) {
      const { agent, response: optionsResponse } = await issueOptions();
      const response = await agent
        .post("/api/auth/passkey/verify")
        .set("Origin", origin)
        .send({
          challengeToken: optionsResponse.body.challengeToken,
          response: responseFactory(optionsResponse.body.options.challenge)
        })
        .expect(401);
      expect(response.body.error.code).toBe("PASSKEY_LOGIN_FAILED");
    }
  });

  it("rejects a mismatched userHandle and mismatched id/rawId before accepting the account", async () => {
    const attacks = [
      (challenge: string) => buildAssertion(challenge, { userHandle: Buffer.from("usr_other", "utf8") }),
      (challenge: string) => buildAssertion(challenge, { rawCredentialId: randomBytes(32) })
    ];

    for (const attack of attacks) {
      const { agent, response: optionsResponse } = await issueOptions();
      const response = await agent
        .post("/api/auth/passkey/verify")
        .set("Origin", origin)
        .send({
          challengeToken: optionsResponse.body.challengeToken,
          response: attack(optionsResponse.body.options.challenge)
        })
        .expect(401);
      expect(response.body.error.code).toBe("PASSKEY_LOGIN_FAILED");
    }
  });

  it("rejects a non-advancing counter for authenticators that use counters", async () => {
    if (!passkey) throw new Error("Passkey fixture is missing");
    passkey.counter = 7;
    const { agent, response: optionsResponse } = await issueOptions();

    const response = await agent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({
        challengeToken: optionsResponse.body.challengeToken,
        response: buildAssertion(optionsResponse.body.options.challenge, { counter: 7 })
      })
      .expect(401);

    expect(response.body.error.code).toBe("PASSKEY_LOGIN_FAILED");
    expect(passkey.counter).toBe(7);
  });

  it("does not reveal whether the credential or user handle was recognized", async () => {
    const { agent: unknownAgent, response: unknownOptions } = await issueOptions();
    const unknownCredential = randomBytes(32);
    const unknown = await unknownAgent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({
        challengeToken: unknownOptions.body.challengeToken,
        response: buildAssertion(unknownOptions.body.options.challenge, {
          credentialId: unknownCredential,
          rawCredentialId: unknownCredential
        })
      })
      .expect(401);

    const { agent: handleAgent, response: handleOptions } = await issueOptions();
    const wrongHandle = await handleAgent
      .post("/api/auth/passkey/verify")
      .set("Origin", origin)
      .send({
        challengeToken: handleOptions.body.challengeToken,
        response: buildAssertion(handleOptions.body.options.challenge, {
          userHandle: Buffer.from("usr_wrong_handle", "utf8")
        })
      })
      .expect(401);

    expect(unknown.body).toEqual(wrongHandle.body);
    expect(unknown.body.error.code).toBe("PASSKEY_LOGIN_FAILED");
  });
});
