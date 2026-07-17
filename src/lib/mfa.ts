import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { env } from "../config/env.js";

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const totpDigits = 6;
const totpPeriodSeconds = 30;

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  tag: string;
};

function getEncryptionKey() {
  return createHash("sha256")
    .update("brainvault:mfa:encryption:v1\0")
    .update(env.MFA_ENCRYPTION_KEY)
    .digest();
}

export function encryptMfaSecret(secret: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
}

export function decryptMfaSecret(encrypted: EncryptedSecret) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(encrypted.iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function encodeBase32(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let result = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) result += base32Alphabet[(value << (5 - bits)) & 31];
  return result;
}

export function decodeBase32(value: string) {
  const normalized = value.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];

  for (const character of normalized) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid Base32 secret");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return encodeBase32(randomBytes(20));
}

export function generateTotpCode(secret: string, timestampMs = Date.now()) {
  const step = Math.floor(timestampMs / 1000 / totpPeriodSeconds);
  return generateTotpCodeForStep(secret, step);
}

function generateTotpCodeForStep(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** totpDigits).padStart(totpDigits, "0");
}

export function findMatchingTotpStep(
  secret: string,
  code: string,
  { timestampMs = Date.now(), window = 1 }: { timestampMs?: number; window?: number } = {}
) {
  const normalizedCode = code.trim();
  if (!/^\d{6}$/.test(normalizedCode)) return null;
  const currentStep = Math.floor(timestampMs / 1000 / totpPeriodSeconds);
  const supplied = Buffer.from(normalizedCode, "utf8");

  for (let offset = -window; offset <= window; offset += 1) {
    const step = currentStep + offset;
    const expected = Buffer.from(generateTotpCodeForStep(secret, step), "utf8");
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return step;
  }

  return null;
}

export function buildTotpUri(username: string, secret: string) {
  const issuer = env.WEBAUTHN_RP_NAME;
  const label = `${issuer}:${username}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(totpDigits),
    period: String(totpPeriodSeconds)
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function toBase64Url(value: Buffer | Uint8Array) {
  return Buffer.from(value).toString("base64url");
}

export function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url");
}

export const webAuthnConfig = {
  rpName: env.WEBAUTHN_RP_NAME,
  rpID: env.WEBAUTHN_RP_ID,
  origins: env.WEBAUTHN_ORIGIN.split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean)
};
