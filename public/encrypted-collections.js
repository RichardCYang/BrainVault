import { showConfirmDialog } from "./app-dialog.js";
import { formatDateTime, t } from "./i18n.js";
import { deviceCollectionKeys } from "./encrypted-collection-device.js";
import {
  createCollectionKeys,
  encryptedCollectionBackupMaxBytes,
  encryptedCollectionMaxNotes,
  encryptedCollectionMinPassphrase,
  exportCollectionBackup,
  newPasskeySalt,
  openCollectionDocument,
  parseCollectionBackup,
  sealCollectionDocument,
  unlockCollectionKey
} from "./encrypted-collection-crypto.js";

const endpoint = "/api/encrypted-collections";
const text = (key, variables) => t(`encryptedCollections.${key}`, variables);

export function bindEncryptedCollections({ api, captureScope, isCurrentScope, getPasskey, closeSidebar, copyNotes }) {
  const find = (suffix) => document.getElementById(`encrypted-collections-${suffix}`);
  const dialog = find("dialog");
  const trigger = find("open");
  const listPanel = find("list-panel");
  const list = find("list");
  const form = find("auth");
  const editor = find("editor");
  const newTitle = find("new-title");
  const file = find("file");
  const method = find("method");
  const password = find("password");
  const confirmation = find("confirm");
  const code = find("code");
  const remember = find("remember");
  const forget = find("forget");
  const submit = find("submit");
  const status = find("status");
  const title = find("title-input");
  const notes = find("notes");
  const noteTitle = find("note-title");
  const noteBody = find("note-body");
  const save = find("save");
  const addNote = find("add-note");
  const removeNote = find("remove-note");

  let scope = null;
  let active = null;
  let security = null;
  let formMode = null;
  let selected = null;
  let creationId = null;
  let verifyCreateOutcome = false;
  let opened = null;
  let key = null;
  let model = null;
  let note = null;
  let editVersion = 0;
  let savedVersion = 0;
  let pendingWrite = null;

  const unsaved = () => editVersion !== savedVersion;
  const available = () => dialog.open && scope && isCurrentScope(scope);
  const request = (path, options, signal) => api(path, { ...options, signal, mutationTimeoutMs: 15_000 });
  const deviceKeyTarget = (id) => [scope.targetKey, id];

  function showStatus(message = "", error = false) {
    status.textContent = message;
    status.classList.toggle("encrypted-collections-error", error);
  }

  function setPanel(panel) {
    for (const item of [listPanel, form, editor]) item.classList.toggle("hidden", item !== panel);
  }

  function syncControls() {
    for (const control of dialog.querySelectorAll("button, input, select, textarea")) {
      control.disabled = Boolean(active) && control !== submit;
    }
    submit.setAttribute("aria-disabled", String(Boolean(active)));
    if (active) return;
    find("create").disabled = !security;
    find("restore").disabled = !security;
    save.disabled = !unsaved();
    addNote.disabled = !model || model.notes.length >= encryptedCollectionMaxNotes;
    notes.disabled = !model?.notes.length;
    removeNote.disabled = !note;
  }

  function clearSecrets() {
    form.reset();
    opened = key = model = note = pendingWrite = null;
    selected = creationId = formMode = null;
    verifyCreateOutcome = false;
    editVersion = savedVersion = 0;
    title.value = noteTitle.value = noteBody.value = "";
    notes.replaceChildren();
    forget.classList.add("hidden");
    window.removeEventListener("beforeunload", preventUnsavedExit);
  }

  function reset() {
    active?.abort();
    active = security = scope = null;
    clearSecrets();
    list.replaceChildren();
    showStatus();
    if (dialog.open) dialog.close();
  }

  function preventUnsavedExit(event) {
    if (!unsaved()) return;
    event.preventDefault();
    event.returnValue = "";
  }

  async function run(action) {
    if (active || !available()) return;
    const controller = new AbortController();
    active = controller;
    syncControls();
    showStatus(text("working"));
    const check = () => {
      controller.signal.throwIfAborted();
      if (!available()) throw new DOMException("Session changed", "AbortError");
    };
    try {
      await action(controller.signal, check);
    } catch (error) {
      if (available() && !controller.signal.aborted) {
        const message = error?.code === "ENCRYPTED_COLLECTION_CONFLICT" ? text("conflict") : error?.message;
        showStatus(message || t("errors.unknown"), true);
      }
    } finally {
      if (active === controller) {
        active = null;
        syncControls();
        if (available() && dialog.contains(document.activeElement) === false) {
          dialog.querySelector("button:enabled")?.focus();
        }
      }
    }
  }

  async function loadList(signal, check, message = "") {
    clearSecrets();
    security = null;
    setPanel(listPanel);
    list.replaceChildren();
    find("empty").classList.add("hidden");
    const [{ collections }, methods] = await Promise.all([
      request(endpoint, {}, signal),
      request("/api/auth/mfa/status", {}, signal)
    ]);
    check();
    security = methods;
    find("empty").classList.toggle("hidden", collections.length > 0);
    for (const collection of collections) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = text("lockedLabel", {
        date: formatDateTime(new Date(collection.createdAt), { dateStyle: "medium", timeStyle: "short" }),
        id: collection.id.slice(0, 8)
      });
      button.addEventListener("click", () => startForm("unlock", collection));
      item.append(button);
      list.append(item);
    }
    showStatus(message);
  }

  function showField(row, input, visible) {
    find(`${row}-row`).classList.toggle("hidden", !visible);
    input.required = visible;
  }

  function syncAuthFields() {
    const restoring = formMode === "restore";
    const creating = formMode === "create" || formMode === "copy";
    const usesPassword = formMode !== "unlock" || !["prf", "totp-device"].includes(method.value);
    const usesTotpCode = ["totp", "totp-device"].includes(method.value);
    showField("new-title", newTitle, creating);
    showField("file", file, restoring);
    showField("method", method, method.options.length > 1 || method.value !== "password");
    showField("password", password, usesPassword);
    showField("confirm", confirmation, creating);
    showField("code", code, usesTotpCode);
    find("remember-row").classList.toggle("hidden", method.value !== "totp" || !globalThis.indexedDB);
    const help = [];
    if (formMode === "copy") help.push(text("copyHelp"));
    if (creating) help.push(text("passphraseHelp"));
    if (restoring) help.push(text("restoreHelp"));
    if (formMode === "unlock" && method.value === "totp") help.push(text("totpHelp"));
    find("auth-help").textContent = help.join(" ");
  }

  function startForm(mode, collection = null) {
    if (!available() || active || !security) return;
    clearSecrets();
    formMode = mode;
    selected = collection;
    if (mode === "copy") newTitle.value = collection.title;
    if (mode !== "unlock") creationId = crypto.randomUUID();
    const hasPasskey = security.passkeys.length > 0;
    const options = [];
    if (security.totpEnabled) options.push(["totp", "totpMethod"]);
    if (hasPasskey) options.push(["passkey", "passkeyMethod"]);
    if (!options.length) options.push(["password", "passwordMethod"]);
    if (hasPasskey && (mode !== "unlock" || collection.passkey)) {
      options.push(["prf", mode === "unlock" ? "prfMethod" : "prfSetupMethod"]);
    }
    method.replaceChildren(...options.map(([value, label]) => new Option(text(label), value)));
    if (mode === "unlock" && collection.passkey && hasPasskey) method.value = "prf";
    const action = mode === "unlock" ? "unlock" : mode;
    find("auth-title").textContent = text(action);
    submit.textContent = text(action);
    syncAuthFields();
    setPanel(form);
    showStatus();
    (mode === "create" || mode === "copy" ? newTitle : mode === "restore" ? file : method.value === "prf" ? submit : password).focus();
    if (mode === "unlock" && security.totpEnabled && globalThis.indexedDB) {
      const formScope = scope;
      void deviceCollectionKeys.has(deviceKeyTarget(collection.id)).then((stored) => {
        if (!stored || !available() || formScope !== scope || formMode !== mode || selected !== collection) return;
        if (!method.querySelector('option[value="totp-device"]')) method.add(new Option(text("totpDeviceMethod"), "totp-device"));
      }).catch(() => {});
    }
  }

  async function verify(methodValue, action, resourceId, totpCode, prfDescriptor, signal, check) {
    if (methodValue === "password") return {};
    const body = { action, resourceId };
    const options = { method: "POST", body, skipAuthReset: true };
    if (methodValue === "totp" || methodValue === "totp-device") {
      return request("/api/auth/mfa/step-up/totp", { ...options, body: { ...body, code: totpCode } }, signal);
    }
    const challenge = await request("/api/auth/mfa/step-up/passkey/options", options, signal);
    check();
    const { response, output } = await getPasskey(challenge.options, prfDescriptor, signal, submit);
    try {
      check();
      if (prfDescriptor && !output) throw new Error(text("prfUnavailable"));
      const { stepUpToken } = await request("/api/auth/mfa/step-up/passkey/verify", {
        ...options, body: { ...body, challengeToken: challenge.challengeToken, response }
      }, signal);
      return { stepUpToken, passkey: output && { ...prfDescriptor, credentialId: response.id, output } };
    } catch (error) {
      output?.fill(0);
      throw error;
    }
  }

  function renderNote() {
    note = model.notes.find((item) => item.id === notes.value) ?? null;
    find("note").classList.toggle("hidden", !note);
    noteTitle.value = note?.title ?? "";
    noteBody.value = note?.body ?? "";
    syncControls();
  }

  function renderNotes(id = model.notes[0]?.id) {
    notes.replaceChildren(...model.notes.map((item) => new Option(item.title || text("untitled"), item.id)));
    notes.value = id ?? "";
    renderNote();
  }

  function openEditor(record, collectionKey, document) {
    clearSecrets();
    opened = record;
    key = collectionKey;
    model = document;
    title.value = model.title;
    setPanel(editor);
    renderNotes();
    showStatus();
  }

  async function configureDeviceKey(id, collectionKey, rememberDevice, check) {
    if (!globalThis.indexedDB) return;
    const target = deviceKeyTarget(id);
    try {
      if (rememberDevice) await deviceCollectionKeys.remember(target, collectionKey);
      const stored = await deviceCollectionKeys.has(target);
      check();
      forget.classList.toggle("hidden", !stored);
    } catch {
      check();
      if (rememberDevice) showStatus(text("rememberFailed"), true);
    }
  }

  async function unlock(methodValue, passphrase, totpCode, rememberDevice, signal, check) {
    const { id } = selected;
    const prf = methodValue === "prf" ? selected.passkey : null;
    const { stepUpToken, passkey } = await verify(methodValue, "encrypted-collection-open", id, totpCode, prf, signal, check);
    try {
      check();
      const record = await request(`${endpoint}/${id}/open`, { method: "POST", body: { stepUpToken } }, signal);
      check();
      let deviceKey;
      if (methodValue === "totp-device") {
        try { deviceKey = await deviceCollectionKeys.read(deviceKeyTarget(id)); } catch { /* Cleared or inaccessible. */ }
        check();
        if (!deviceKey) throw new Error(text("deviceKeyMissing"));
      }
      const { collectionKey, document } = await decryptRecord(record, passphrase, passkey, deviceKey);
      check();
      openEditor(record, collectionKey, document);
      await configureDeviceKey(id, collectionKey, rememberDevice, check);
    } finally {
      passkey?.output.fill(0);
    }
  }

  async function decryptRecord(record, passphrase, passkey, deviceKey) {
    try {
      const collectionKey = deviceKey ?? await unlockCollectionKey(record, passphrase, passkey);
      return { collectionKey, document: await openCollectionDocument(collectionKey, record) };
    } catch {
      throw new Error(text("decryptFailed"));
    }
  }

  async function create(methodValue, passphrase, totpCode, rememberDevice, newDocument, signal, check) {
    const id = creationId;
    const createdPreviously = async () => (await request(endpoint, {}, signal)).collections.some((item) => item.id === id);
    if (verifyCreateOutcome && await createdPreviously()) {
      await loadList(signal, check, text("saved"));
      return;
    }
    check();
    const prf = methodValue === "prf" ? { salt: newPasskeySalt() } : null;
    const { stepUpToken, passkey } = await verify(methodValue, "encrypted-collection-create", id, totpCode, prf, signal, check);
    try {
      check();
      const { key: collectionKey, keySlots } = await createCollectionKeys(id, passphrase, passkey);
      const document = await sealDocument(collectionKey, id, 1, newDocument);
      check();
      let record;
      try {
        record = await request(endpoint, { method: "POST", body: { id, keySlots, document, stepUpToken } }, signal);
      } catch (error) {
        check();
        if (!error.ambiguous && error.code !== "ENCRYPTED_COLLECTION_CONFLICT") throw error;
        verifyCreateOutcome = true;
        if (!(await createdPreviously())) throw error;
        await loadList(signal, check, text("saved"));
        return;
      }
      check();
      openEditor(record, collectionKey, newDocument);
      await configureDeviceKey(id, collectionKey, rememberDevice, check);
    } finally {
      passkey?.output.fill(0);
    }
  }

  async function sealDocument(collectionKey, id, revision, document) {
    if (!document.title.trim()) throw new Error(text("titleRequired"));
    try {
      return await sealCollectionDocument(collectionKey, id, revision, document);
    } catch (error) {
      if (error instanceof RangeError) throw new Error(text("tooLarge"));
      throw error;
    }
  }

  function markDirty() {
    if (!unsaved()) showStatus(text("unsaved"));
    editVersion += 1;
    window.addEventListener("beforeunload", preventUnsavedExit);
    syncControls();
  }

  async function saveDocument(signal, check) {
    while (unsaved()) {
      const { id, revision, grant } = opened;
      if (!pendingWrite) {
        const version = editVersion;
        const document = await sealDocument(key, id, revision + 1, model);
        check();
        pendingWrite = { version, document };
      }
      const pending = pendingWrite;
      const result = await request(`${endpoint}/${id}`, {
        method: "PATCH", body: { grant, revision, document: pending.document }
      }, signal);
      check();
      opened = { ...opened, revision: result.revision, document: pending.document };
      savedVersion = pending.version;
      pendingWrite = null;
    }
    window.removeEventListener("beforeunload", preventUnsavedExit);
    showStatus(text("saved"));
  }

  async function canDiscard(message = "discard") {
    if (!unsaved()) return true;
    return showConfirmDialog({ title: text("unsaved"), message: text(message), confirmLabel: text("discardButton"), danger: true });
  }

  async function close() {
    if (active || !available() || !(await canDiscard()) || !available()) return;
    reset();
    trigger.focus();
  }

  async function openDialog(source = null) {
    if (dialog.open) return;
    const dialogScope = captureScope();
    if (!isCurrentScope(dialogScope)) return;
    scope = dialogScope;
    closeSidebar();
    setPanel(listPanel);
    dialog.showModal();
    if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
      syncControls();
      showStatus(text("secureContext"), true);
      return;
    }
    await run(loadList);
    if (source && scope === dialogScope) startForm("copy", source);
  }

  trigger.addEventListener("click", () => void openDialog());
  for (const event of ["keydown", "keyup", "click", "pointerdown", "mousedown", "focusin"]) {
    dialog.addEventListener(event, (value) => value.stopPropagation());
  }
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); void close(); });
  window.addEventListener("pagehide", reset);
  find("close").addEventListener("click", () => void close());
  find("create").addEventListener("click", () => startForm("create"));
  find("restore").addEventListener("click", () => startForm("restore"));
  find("back").addEventListener("click", () => void run(loadList));
  method.addEventListener("change", syncAuthFields);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async (signal, check) => {
      const passphrase = password.value;
      const repeated = confirmation.value;
      const totpCode = code.value;
      const methodValue = method.value;
      const rememberDevice = methodValue === "totp" && remember.checked;
      password.value = confirmation.value = code.value = "";
      if (formMode === "unlock") {
        await unlock(methodValue, passphrase, totpCode, rememberDevice, signal, check);
        return;
      }
      if (Array.from(passphrase).length < encryptedCollectionMinPassphrase) throw new Error(text("passphraseShort"));
      let newDocument;
      if (formMode === "restore") {
        const backupFile = file.files[0];
        if (!backupFile || backupFile.size > encryptedCollectionBackupMaxBytes) throw new Error(text("badBackup"));
        let record;
        try { record = parseCollectionBackup(await backupFile.text()); }
        catch { throw new Error(text("badBackup")); }
        check();
        ({ document: newDocument } = await decryptRecord(record, passphrase));
      } else {
        if (passphrase !== repeated) throw new Error(text("passphrasesDiffer"));
        if (!newTitle.value.trim()) throw new Error(text("titleRequired"));
        const collectionTitle = newTitle.value.trim();
        const copied = formMode === "copy" ? await copyNotes(selected.id, signal) : [];
        newDocument = { title: collectionTitle, notes: copied };
      }
      check();
      await create(methodValue, passphrase, totpCode, rememberDevice, newDocument, signal, check);
    });
  });
  title.addEventListener("input", () => { model.title = title.value; markDirty(); });
  notes.addEventListener("change", renderNote);
  noteTitle.addEventListener("input", () => {
    note.title = noteTitle.value;
    notes.selectedOptions[0].textContent = note.title || text("untitled");
    markDirty();
  });
  noteBody.addEventListener("input", () => { note.body = noteBody.value; markDirty(); });
  addNote.addEventListener("click", () => {
    const id = crypto.randomUUID();
    model.notes.push({ id, title: "", body: "" });
    renderNotes(id);
    markDirty();
    noteTitle.focus();
  });
  removeNote.addEventListener("click", async () => {
    const target = note;
    if (!await showConfirmDialog({ title: text("removeNote"), message: text("removeNoteConfirm"), danger: true })
      || !available() || target !== note) return;
    model.notes = model.notes.filter((item) => item !== target);
    renderNotes();
    markDirty();
  });
  save.addEventListener("click", () => void run(saveDocument));
  find("lock").addEventListener("click", async () => {
    if (await canDiscard() && available()) void run(loadList);
  });
  find("backup").addEventListener("click", () => void run(async (_signal, check) => {
    const { id, revision } = opened;
    const record = unsaved()
      ? { ...opened, document: await sealDocument(key, id, revision, model) } : opened;
    check();
    const url = URL.createObjectURL(new Blob([exportCollectionBackup(record)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `brainvault-${id}.brainvault-e2ee`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    showStatus(text("backupReady"));
  }));
  forget.addEventListener("click", () => void run(async (_signal, check) => {
    await deviceCollectionKeys.forget(deviceKeyTarget(opened.id));
    check();
    forget.classList.add("hidden");
    showStatus(text("deviceForgotten"));
  }));
  find("delete").addEventListener("click", async () => {
    const target = opened;
    if (!await showConfirmDialog({ title: text("delete"), message: text("deleteConfirm"), danger: true })
      || !available() || target !== opened) return;
    void run(async (signal, check) => {
      const { id, grant, revision } = opened;
      await request(`${endpoint}/${id}`, { method: "DELETE", body: { grant, revision } }, signal);
      check();
      if (globalThis.indexedDB) await deviceCollectionKeys.forget(deviceKeyTarget(id)).catch(() => {});
      check();
      await loadList(signal, check, text("deleted"));
    });
  });

  return { reset, openCopy: openDialog };
}
