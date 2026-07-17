import { describe, expect, it } from "vitest";
import {
  decodeBase32,
  decryptMfaSecret,
  encodeBase32,
  encryptMfaSecret,
  findMatchingTotpStep,
  generateTotpCode
} from "../src/lib/mfa.js";

const rfc6238Sha1Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("MFA cryptography helpers", () => {
  it("generates six-digit TOTP values from the RFC 6238 SHA-1 vectors", () => {
    expect(generateTotpCode(rfc6238Sha1Secret, 59_000)).toBe("287082");
    expect(generateTotpCode(rfc6238Sha1Secret, 1_111_111_109_000)).toBe("081804");
    expect(generateTotpCode(rfc6238Sha1Secret, 1_111_111_111_000)).toBe("050471");
  });

  it("accepts only a code in the configured time window", () => {
    const timestampMs = 1_111_111_111_000;
    const code = generateTotpCode(rfc6238Sha1Secret, timestampMs);
    expect(findMatchingTotpStep(rfc6238Sha1Secret, code, { timestampMs, window: 1 })).toBe(
      Math.floor(timestampMs / 1000 / 30)
    );
    expect(findMatchingTotpStep(rfc6238Sha1Secret, "000000", { timestampMs, window: 1 })).toBeNull();
    expect(findMatchingTotpStep(rfc6238Sha1Secret, "not-a-code", { timestampMs, window: 1 })).toBeNull();
  });

  it("round-trips Base32 and AES-256-GCM encrypted secrets", () => {
    const source = Buffer.from("BrainVault MFA secret", "utf8");
    expect(decodeBase32(encodeBase32(source))).toEqual(source);

    const encrypted = encryptMfaSecret(rfc6238Sha1Secret);
    expect(encrypted.ciphertext).not.toContain(rfc6238Sha1Secret);
    expect(decryptMfaSecret(encrypted)).toBe(rfc6238Sha1Secret);
  });
});
