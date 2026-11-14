import { t } from "./i18n.js";

// Themed replacements for window.confirm()/window.prompt(). Native dialogs
// ignore the workspace theme and language, and browsers may let a user
// suppress them, after which confirm() silently returns false. These dialogs
// are rendered as modal <dialog> elements in the top layer, so the browser
// traps focus, makes the rest of the page inert, and closes them on Escape.

let dialogQueue = Promise.resolve();
let dialogSequence = 0;

const workspaceEventTypes = ["keydown", "keyup", "click", "pointerdown", "mousedown", "focusin"];

function stopEventFromReachingWorkspace(event) {
  // Workspace-level handlers listen on document for Escape, Tab trapping,
  // shortcuts, and outside-click dismissal. A dialog opened above another
  // layer (for example account settings) must not drive that layer too.
  event.stopPropagation();
}

function openDialog({
  title,
  message,
  field = null,
  cancelLabel,
  confirmLabel,
  alternateLabel = null,
  danger = false,
  initialFocus,
  readResult
}) {
  const run = () => new Promise((resolve) => {
    const id = `app-dialog-${++dialogSequence}`;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const dialog = document.createElement("dialog");
    dialog.className = "app-dialog";
    dialog.setAttribute("aria-labelledby", `${id}-title`);

    const form = document.createElement("form");
    form.method = "dialog";
    form.className = "app-dialog-surface";

    const heading = document.createElement("h2");
    heading.id = `${id}-title`;
    heading.className = "app-dialog-title";
    heading.textContent = title;
    form.append(heading);

    if (message) {
      const paragraph = document.createElement("p");
      paragraph.id = `${id}-message`;
      paragraph.className = "app-dialog-message";
      paragraph.textContent = message;
      dialog.setAttribute("aria-describedby", paragraph.id);
      form.append(paragraph);
    }

    const input = field?.(form, id) ?? null;

    const actions = document.createElement("div");
    actions.className = "app-dialog-actions";
    // Cancel is a plain button so implicit submission (Enter in a text field)
    // always resolves to the confirm action, never to the first button.
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = cancelLabel;
    cancel.addEventListener("click", () => dialog.close("cancel"));
    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.value = "confirm";
    confirm.className = danger ? "app-dialog-danger" : "";
    confirm.textContent = confirmLabel;
    // An optional middle choice, such as "delete only this block" next to
    // "delete everything". It is never the default, so Enter cannot pick it.
    if (alternateLabel) {
      actions.classList.add("has-alternate");
      const alternate = document.createElement("button");
      alternate.type = "button";
      alternate.className = "secondary";
      alternate.textContent = alternateLabel;
      alternate.addEventListener("click", () => dialog.close("alternate"));
      actions.append(cancel, alternate, confirm);
    } else {
      actions.append(cancel, confirm);
    }
    form.append(actions);
    dialog.append(form);

    for (const type of workspaceEventTypes) dialog.addEventListener(type, stopEventFromReachingWorkspace);

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      dialog.remove();
      if (returnFocus?.isConnected && !returnFocus.closest("[inert]")) {
        returnFocus.focus({ preventScroll: true });
      }
      resolve(readResult(value, input));
    };
    dialog.addEventListener("close", () => settle(dialog.returnValue), { once: true });

    document.body.append(dialog);
    try {
      dialog.showModal();
    } catch {
      settle("cancel");
      return;
    }
    const focusTarget = initialFocus === "cancel" ? cancel : initialFocus === "input" && input ? input : confirm;
    focusTarget.focus();
    if (focusTarget === input) input.select();
  });

  const result = dialogQueue.then(run, run);
  dialogQueue = result.catch(() => undefined);
  return result;
}

export function showConfirmDialog({
  title = t("dialog.confirmTitle"),
  message = "",
  confirmLabel = t("dialog.confirm"),
  cancelLabel = t("dialog.cancel"),
  danger = false
} = {}) {
  return openDialog({
    title,
    message,
    cancelLabel,
    confirmLabel,
    danger,
    // Destructive actions start on Cancel so a stray Enter cannot confirm them.
    initialFocus: danger ? "cancel" : "confirm",
    readResult: (value) => value === "confirm"
  });
}

// Like showConfirmDialog, with a second, less destructive way to go ahead.
// Resolves to "confirm", "alternate" or "cancel".
export function showChoiceDialog({
  title = t("dialog.confirmTitle"),
  message = "",
  confirmLabel = t("dialog.confirm"),
  alternateLabel,
  cancelLabel = t("dialog.cancel"),
  danger = false
} = {}) {
  return openDialog({
    title,
    message,
    cancelLabel,
    confirmLabel,
    alternateLabel,
    danger,
    initialFocus: danger ? "cancel" : "confirm",
    readResult: (value) => (value === "confirm" || value === "alternate" ? value : "cancel")
  });
}

export function showPromptDialog({
  title = t("dialog.promptTitle"),
  message = "",
  label = "",
  defaultValue = "",
  confirmLabel = t("dialog.ok"),
  cancelLabel = t("dialog.cancel"),
  maxLength = null,
  inputMode = null,
  autocomplete = "off",
  pattern = null
} = {}) {
  return openDialog({
    title,
    message,
    cancelLabel,
    confirmLabel,
    initialFocus: "input",
    field: (form, id) => {
      const field = document.createElement("label");
      field.className = "app-dialog-field";
      field.htmlFor = `${id}-input`;
      const caption = document.createElement("span");
      caption.textContent = label || title;
      const input = document.createElement("input");
      input.id = `${id}-input`;
      input.type = "text";
      input.value = defaultValue;
      input.setAttribute("autocomplete", autocomplete);
      input.required = true;
      if (Number.isSafeInteger(maxLength) && maxLength > 0) input.setAttribute("maxlength", String(maxLength));
      if (inputMode) input.setAttribute("inputmode", inputMode);
      if (pattern) input.setAttribute("pattern", pattern);
      field.append(caption, input);
      form.append(field);
      return input;
    },
    readResult: (value, input) => (value === "confirm" ? input.value : null)
  });
}
