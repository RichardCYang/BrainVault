import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("passkey registration exposes an explicit standards-based QR/hybrid path", async () => {
  const [route, client, index, i18n] = await Promise.all([
    read("src/routes/mfa.routes.ts"),
    read("public/app.js"),
    read("public/index.html"),
    read("public/i18n.js")
  ]);

  assert.match(route, /registrationTarget:\s*z\.enum\(\["automatic", "remote"\]\)\.default\("automatic"\)/);
  assert.match(route, /const passkeyRegistrationTimeoutMs = challengeLifetimeMs - 60_000/);
  assert.match(
    route,
    /function getWebAuthnUserDisplayName\(name: string \| null \| undefined, username: string\)[\s\S]*?return name\?\.trim\(\) \|\| username;/
  );
  assert.match(
    route,
    /userDisplayName:\s*getWebAuthnUserDisplayName\(lockedUser\.name, lockedUser\.username\)/
  );
  assert.match(
    route,
    /registrationTarget === "remote"[\s\S]*?preferredAuthenticatorType:\s*"remoteDevice"[\s\S]*?timeout:\s*passkeyRegistrationTimeoutMs[\s\S]*?supportedAlgorithmIDs:\s*\[-7, -257\]/
  );

  assert.match(index, /id="account-passkey-registration-target"/);
  assert.match(index, /option value="automatic"/);
  assert.match(index, /option value="remote"/);
  assert.match(client, /body:\s*\{ currentPassword, name, registrationTarget \}/);
  assert.match(client, /PublicKeyCredential\.getClientCapabilities/);
  assert.match(client, /capabilities\?\.hybridTransport/);
  assert.match(client, /normalizePasskeyRegistrationError\(error, registrationTarget\)/);

  assert.match(i18n, /passkeyRegistrationRemote:\s*"Phone or tablet by QR code"/);
  assert.match(i18n, /passkeyRegistrationRemote:\s*"휴대폰·태블릿 QR 등록"/);
  assert.match(i18n, /passkeyRemoteOperationCancelled/);
});
