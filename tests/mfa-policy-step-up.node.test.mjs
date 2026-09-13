import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const auth = readFileSync(new URL("../src/routes/auth.routes.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function routeSection(path) {
  const start = auth.indexOf(`authRouter.put(\n  "${path}"`);
  assert.ok(start >= 0, `missing PUT route ${path}`);
  const next = auth.indexOf("\nauthRouter.", start + path.length + 2);
  return auth.slice(start, next >= 0 ? next : undefined);
}

function functionSection(name, nextName) {
  const start = app.indexOf(`async function ${name}()`);
  assert.ok(start >= 0, `missing client function ${name}`);
  const end = nextName ? app.indexOf(`function ${nextName}`, start) : app.indexOf("\nfunction ", start + 1);
  return app.slice(start, end >= 0 ? end : undefined);
}

test("security posture schemas accept the existing MFA step-up token", () => {
  for (const schema of ["vpnBlockPolicySchema", "totpIpBlockPolicySchema", "countryLoginPolicySchema"]) {
    const start = auth.indexOf(`const ${schema} =`);
    assert.ok(start >= 0, `missing ${schema}`);
    const end = auth.indexOf(";", start);
    assert.match(auth.slice(start, end + 1), /stepUpToken:\s*mfaStepUpTokenSchema\.optional\(\)/);
  }
});

test("all login-defense policy mutations consume MFA step-up before changing security posture", () => {
  for (const path of ["/totp-ip-block-policy", "/vpn-block-policy", "/country-login-policy"]) {
    const section = routeSection(path);
    const consume = section.indexOf("consumeMfaStepUpIfRequired(client, user.id, authScope, stepUpToken)");
    const update = section.indexOf("UPDATE users");
    assert.ok(consume >= 0, `${path} must consume MFA step-up proof`);
    assert.ok(update > consume, `${path} must verify step-up before updating the policy`);
    assert.match(section, /DELETE FROM mfa_step_up_sessions WHERE user_id = \?/);
  }
});

test("account settings client obtains step-up proof before each policy PUT", () => {
  for (const [name, path] of [
    ["saveTotpIpBlockPolicy", "/api/auth/totp-ip-block-policy"],
    ["saveCountryLoginPolicy", "/api/auth/country-login-policy"],
    ["saveVpnBlockPolicy", "/api/auth/vpn-block-policy"]
  ]) {
    const section = functionSection(name);
    const stepUp = section.indexOf("await requestMfaStepUpToken(");
    const request = section.indexOf(`api("${path}"`);
    assert.ok(stepUp >= 0 && request > stepUp, `${name} must obtain step-up proof before the policy request`);
    assert.match(section, /\.\.\.\(stepUpToken \? \{ stepUpToken \} : \{\}\)/);
  }
});
