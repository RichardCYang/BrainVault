export const encryptedCollectionMaxBytes = 512 * 1024;
export const encryptedCollectionBackupMaxBytes = 720 * 1024;
export const encryptedCollectionMaxNotes = 256;
export const encryptedCollectionMinPassphrase = 16;

const passwordIterations = 600_000;
const backupFormat = "brainvault-encrypted-collection";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

export function encodeBase64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64Url(value, minBytes, maxBytes = minBytes) {
  if (typeof value !== "string" || value.length < Math.ceil(minBytes * 4 / 3)
    || value.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid encrypted data");
  }
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length < minBytes || bytes.length > maxBytes || encodeBase64Url(bytes) !== value) {
    throw new Error("Invalid encrypted data");
  }
  return bytes;
}

const keyAlgorithm = { name: "AES-GCM", length: 256 };

function additionalData(id, purpose) {
  return encoder.encode(JSON.stringify(["brainvault-encrypted-collection-v1", id, purpose]));
}

async function seal(key, bytes, id, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(id, purpose) }, key, bytes);
  return { iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(new Uint8Array(cipher)) };
}

function open(key, envelope, id, purpose, minBytes, maxBytes) {
  return crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: decodeBase64Url(envelope.iv, 12),
    additionalData: additionalData(id, purpose)
  }, key, decodeBase64Url(envelope.ciphertext, minBytes, maxBytes));
}

async function passwordKey(passphrase, salt) {
  const input = encoder.encode(passphrase);
  try {
    const secret = await crypto.subtle.importKey("raw", input, "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: passwordIterations, salt },
      secret, keyAlgorithm, false, ["encrypt", "decrypt"]);
  } finally {
    input.fill(0);
  }
}

async function passkeyKey(output, id, salt) {
  if (output.byteLength !== 32) throw new Error("Invalid WebAuthn PRF result");
  const secret = await crypto.subtle.importKey("raw", output, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt,
    info: additionalData(id, "passkey-wrap-key") }, secret, keyAlgorithm, false, ["encrypt", "decrypt"]);
}

function importCollectionKey(bytes) {
  return crypto.subtle.importKey("raw", bytes, keyAlgorithm, false, ["encrypt", "decrypt"]);
}

export function newPasskeySalt() {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createCollectionKeys(id, passphrase, passkey = null) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  try {
    const wrappingKey = await passwordKey(passphrase, salt);
    const password = { salt: encodeBase64Url(salt), wrapped: await seal(wrappingKey, raw, id, "password") };
    let passkeySlot = null;
    if (passkey) {
      const { credentialId, salt: passkeySalt, output } = passkey;
      const key = await passkeyKey(output, id, decodeBase64Url(passkeySalt, 32));
      passkeySlot = { credentialId, salt: passkeySalt, wrapped: await seal(key, raw, id, `passkey:${credentialId}`) };
    }
    return { key: await importCollectionKey(raw), keySlots: { version: 1, password, passkey: passkeySlot } };
  } finally {
    raw.fill(0);
  }
}

export async function unlockCollectionKey({ id, keySlots }, passphrase, passkey = null) {
  if (keySlots?.version !== 1) throw new Error("Unsupported collection key format");
  const slot = passkey ? keySlots.passkey : keySlots.password;
  if (!slot || (passkey && passkey.credentialId !== slot.credentialId)) throw new Error("Invalid collection key slot");
  const salt = decodeBase64Url(slot.salt, 32);
  const wrappingKey = passkey ? await passkeyKey(passkey.output, id, salt) : await passwordKey(passphrase, salt);
  const raw = new Uint8Array(await open(wrappingKey, slot.wrapped, id,
    passkey ? `passkey:${slot.credentialId}` : "password", 48, 48));
  try {
    return await importCollectionKey(raw);
  } finally {
    raw.fill(0);
  }
}

export async function sealCollectionDocument(key, id, revision, document) {
  const bytes = encoder.encode(JSON.stringify(document));
  try {
    if (bytes.byteLength > encryptedCollectionMaxBytes) throw new RangeError("Collection exceeds the encrypted size limit");
    return await seal(key, bytes, id, `document:${revision}`);
  } finally {
    bytes.fill(0);
  }
}

export async function openCollectionDocument(key, { id, revision, document }) {
  const bytes = new Uint8Array(await open(key, document, id, `document:${revision}`, 17, encryptedCollectionMaxBytes + 16));
  try {
    const value = JSON.parse(decoder.decode(bytes));
    if (typeof value?.title !== "string" || !value.title.trim() || value.title.length > 160
      || !Array.isArray(value.notes) || value.notes.length > encryptedCollectionMaxNotes) {
      throw new Error("Invalid encrypted collection content");
    }
    const ids = new Set();
    const notes = value.notes.map((note) => {
      if (typeof note?.id !== "string" || !uuidPattern.test(note.id) || ids.has(note.id)
        || typeof note.title !== "string" || note.title.length > 160 || typeof note.body !== "string") {
        throw new Error("Invalid encrypted note");
      }
      ids.add(note.id);
      return { id: note.id, title: note.title, body: note.body };
    });
    return { title: value.title, notes };
  } finally {
    bytes.fill(0);
  }
}

export function exportCollectionBackup({ id, revision, keySlots, document }) {
  // Account session grants are never part of a portable encrypted backup.
  return JSON.stringify({ format: backupFormat, version: 1, id, revision, keySlots, document });
}

export function parseCollectionBackup(text) {
  const value = JSON.parse(text);
  if (value?.format !== backupFormat || value.version !== 1 || !uuidPattern.test(value.id)
    || !Number.isInteger(value.revision) || value.revision < 1 || value.revision > 0xffffffff
    || value.keySlots?.version !== 1 || !value.keySlots.password?.wrapped || !value.document) {
    throw new Error("Invalid encrypted collection backup");
  }
  const { id, revision, keySlots, document } = value;
  return { id, revision, keySlots: { version: 1, password: keySlots.password }, document };
}
