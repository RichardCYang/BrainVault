import assert from "node:assert/strict";
import test from "node:test";
import {
  createCollectionKeys,
  decodeBase64Url,
  encryptedCollectionMaxBytes,
  exportCollectionBackup,
  newPasskeySalt,
  openCollectionDocument,
  parseCollectionBackup,
  sealCollectionDocument,
  unlockCollectionKey
} from "../public/encrypted-collection-crypto.js";

const passphrase = "collection-passphrase-for-tests";

test("a password and the enrolled passkey independently unlock the same ciphertext", async () => {
  const id = crypto.randomUUID();
  const passkey = { credentialId: "cGFzc2tleQ", salt: newPasskeySalt(), output: crypto.getRandomValues(new Uint8Array(32)) };
  const plaintext = { title: "컬렉션", notes: [{ id: crypto.randomUUID(), title: "제목", body: "기밀 문서" }] };
  const { key, keySlots } = await createCollectionKeys(id, passphrase, passkey);
  const record = { id, keySlots, revision: 1, document: await sealCollectionDocument(key, id, 1, plaintext) };

  assert.equal(key.extractable, false);
  assert.equal(JSON.stringify(record).includes(plaintext.notes[0].body), false);
  const passwordKey = await unlockCollectionKey(record, passphrase);
  const passkeyKey = await unlockCollectionKey(record, null, passkey);
  assert.deepEqual(await openCollectionDocument(passwordKey, record), plaintext);
  assert.deepEqual(await openCollectionDocument(passkeyKey, record), plaintext);
  await assert.rejects(unlockCollectionKey(record, "wrong collection password"));
  await assert.rejects(unlockCollectionKey(record, null, { ...passkey, credentialId: "d3Jvbmc" }));
  await assert.rejects(unlockCollectionKey(record, null, { ...passkey, output: new Uint8Array(32) }));

  const backupText = exportCollectionBackup({ ...record, grant: "live-session-grant" });
  assert.equal(backupText.includes("live-session-grant"), false);
  const restored = parseCollectionBackup(backupText);
  assert.deepEqual(await openCollectionDocument(await unlockCollectionKey(restored, passphrase), restored), plaintext);
});

test("collection binding, revisions, and the authenticated tag protect the document", async () => {
  const id = crypto.randomUUID();
  const model = { title: "private", notes: [] };
  const { key } = await createCollectionKeys(id, passphrase);
  const document = await sealCollectionDocument(key, id, 6, model);
  const record = { id, revision: 6, document };
  assert.notEqual((await sealCollectionDocument(key, id, 6, model)).iv, document.iv);
  const flipped = (document.ciphertext[0] === "A" ? "B" : "A") + document.ciphertext.slice(1);
  await assert.rejects(openCollectionDocument(key, { ...record, id: crypto.randomUUID() }));
  await assert.rejects(openCollectionDocument(key, { ...record, revision: 5 }));
  await assert.rejects(openCollectionDocument(key, { ...record, document: { ...document, ciphertext: flipped } }));
  await assert.rejects(sealCollectionDocument(key, id, 6, { ...model, title: "😀".repeat(encryptedCollectionMaxBytes / 4) }), RangeError);
  assert.throws(() => decodeBase64Url("_x", 1), /Invalid encrypted data/);
});
