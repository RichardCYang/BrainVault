import { getLocale, t } from "./i18n.js";

export const aiProviderPresets = Object.freeze([
  { id: "chatgpt", label: "ChatGPT" },
  { id: "gemini", label: "Gemini" },
  { id: "claude", label: "Claude" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "grok", label: "Grok" }
]);

export const aiChatLimits = Object.freeze({
  titleLength: 120,
  turns: 50,
  questionLength: 8_000,
  answerLength: 12_000,
  modelLength: 120
});

const providerById = new Map(aiProviderPresets.map((provider) => [provider.id, provider]));
const svgNamespace = "http://www.w3.org/2000/svg";

function normalizeText(value, maxLength) {
  return (value === null || value === undefined ? "" : String(value))
    .replace(/\u0000/g, "")
    .slice(0, maxLength);
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

export function createLocalDateTimeValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}T${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`;
}

function normalizeLocalDateTime(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().slice(0, 16);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return "";

  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day) ||
    date.getHours() !== Number(hour) ||
    date.getMinutes() !== Number(minute)
  ) {
    return "";
  }
  return normalized;
}

export function getAiProviderPreset(value) {
  return providerById.get(typeof value === "string" ? value.toLowerCase() : "") ?? aiProviderPresets[0];
}

function normalizeTurn(value, { fallbackAnsweredAt = "" } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    answeredAt: normalizeLocalDateTime(source.answeredAt) || normalizeLocalDateTime(fallbackAnsweredAt) || createLocalDateTimeValue(),
    question: normalizeText(source.question, aiChatLimits.questionLength),
    answer: normalizeText(source.answer, aiChatLimits.answerLength)
  };
}

export function createDefaultAiChatData({ question = "", answeredAt = "" } = {}) {
  return {
    title: "",
    provider: "chatgpt",
    model: "",
    turns: [normalizeTurn({ question, answeredAt }, { fallbackAnsweredAt: answeredAt })]
  };
}

export function normalizeAiChatData(value, { fallbackAnsweredAt = "" } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawTurns = Array.isArray(source.turns)
    ? source.turns.slice(0, aiChatLimits.turns)
    : [source];
  const turns = rawTurns.map((turn, index) => normalizeTurn(turn, {
    fallbackAnsweredAt: index === 0 ? fallbackAnsweredAt : ""
  }));

  return {
    title: normalizeText(source.title, aiChatLimits.titleLength).trim(),
    provider: getAiProviderPreset(source.provider).id,
    model: normalizeText(source.model, aiChatLimits.modelLength).trim(),
    turns: turns.length ? turns : [normalizeTurn({}, { fallbackAnsweredAt })]
  };
}

export function summarizeAiChatData(value) {
  const data = normalizeAiChatData(value);
  const provider = getAiProviderPreset(data.provider).label;
  return [
    data.title,
    `${provider}${data.model ? ` · ${data.model}` : ""}`,
    ...data.turns.flatMap((turn, index) => [
      `Question ${index + 1}`,
      turn.answeredAt,
      turn.question,
      turn.answer
    ])
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 20_000);
}

function addSvgShape(svg, tagName, attributes, text = "") {
  const shape = document.createElementNS(svgNamespace, tagName);
  Object.entries(attributes).forEach(([name, value]) => shape.setAttribute(name, String(value)));
  if (text) shape.textContent = text;
  svg.append(shape);
}

function drawProviderIcon(svg, provider) {
  if (provider === "gemini") {
    addSvgShape(svg, "path", { d: "M12 2.8c.7 4.8 2.4 7.5 7.2 8.2-4.8.7-7.5 3.4-8.2 8.2-.7-4.8-2.4-7.5-7.2-8.2 4.8-.7 7.5-3.4 8.2-8.2Z" });
    return;
  }

  if (provider === "claude") {
    addSvgShape(svg, "circle", { cx: 12, cy: 12, r: 2.2 });
    [0, 45, 90, 135].forEach((angle) => {
      addSvgShape(svg, "path", { d: "M12 3.2v3.4M12 17.4v3.4", transform: `rotate(${angle} 12 12)` });
    });
    return;
  }

  if (provider === "deepseek") {
    addSvgShape(svg, "path", { d: "M4 13.4c2.2-3 5.2-4.4 8.7-4.2 2.4.1 4.4 1 6.1 2.6-1.1 4.3-4.1 6.8-8.5 6.8-3.1 0-5.4-1.7-6.3-5.2Z" });
    addSvgShape(svg, "path", { d: "M17.6 8.8c.8-1.4 1.8-2.2 3-2.5-.2 1.8-.8 3.2-1.9 4.2" });
    addSvgShape(svg, "circle", { cx: 14.7, cy: 12.5, r: 0.75, fill: "currentColor", stroke: "none" });
    addSvgShape(svg, "path", { d: "M6.2 14.3c1.7.7 3.4.8 5.1.2" });
    return;
  }

  if (provider === "grok") {
    addSvgShape(svg, "path", { d: "M5 5.5 18.5 19" });
    addSvgShape(svg, "path", { d: "M18.8 5.2 9.6 14.4" });
    addSvgShape(svg, "path", { d: "M14.8 5.2h4v4" });
    return;
  }

  addSvgShape(svg, "path", { d: "M12 3.2 15.8 5.4 20 7.8v4.4l-3.8 2.2v4.3L12 21l-3.8-2.3v-4.3L4 12V7.8l4.2-2.4L12 7.6l3.8-2.2" });
  addSvgShape(svg, "path", { d: "m8.2 5.4 3.8 2.2v4.3l4.2 2.5M20 7.8l-4.2 2.4L12 8M8.2 18.7V14.4L4 12" });
}

export function createAiProviderIcon(providerValue, className = "") {
  const provider = getAiProviderPreset(providerValue);
  const wrapper = document.createElement("span");
  wrapper.className = ["ai-provider-icon", className].filter(Boolean).join(" ");
  wrapper.dataset.provider = provider.id;
  wrapper.setAttribute("aria-hidden", "true");

  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", provider.id === "claude" ? "1.65" : "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  drawProviderIcon(svg, provider.id);
  wrapper.append(svg);
  return wrapper;
}

function autoGrow(textarea) {
  const minimum = textarea.classList.contains("ai-chat-question-input") ? 38 : 112;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(textarea.scrollHeight, minimum)}px`;
}

function formatLocalDateTime(value) {
  const normalized = normalizeLocalDateTime(value);
  if (!normalized) return t("aiChat.timeNotSet");
  const [datePart, timePart] = normalized.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  try {
    return new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return normalized.replace("T", " ");
  }
}

function createLabeledField(labelText, input) {
  const label = document.createElement("label");
  label.className = "ai-chat-setting-field";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  label.append(caption, input);
  return label;
}

function syncEditorPreview(editor) {
  const provider = getAiProviderPreset(editor.dataset.aiProvider);
  const modelInput = editor.querySelector(".ai-chat-model-input");

  editor.dataset.aiProvider = provider.id;
  editor.querySelectorAll(".ai-chat-provider-option").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.aiProvider === provider.id);
    button.setAttribute("aria-pressed", String(button.dataset.aiProvider === provider.id));
  });
  editor.querySelectorAll(".ai-chat-answer-icon").forEach((iconHost) => {
    iconHost.replaceChildren(createAiProviderIcon(provider.id));
  });
  editor.querySelectorAll(".ai-chat-provider-label").forEach((providerLabel) => {
    providerLabel.textContent = provider.label;
  });

  const model = normalizeText(modelInput?.value, aiChatLimits.modelLength).trim();
  editor.querySelectorAll(".ai-chat-model-preview").forEach((modelLabel) => {
    modelLabel.textContent = model || t("aiChat.modelNotSet");
    modelLabel.classList.toggle("is-empty", !model);
  });
}

function syncTurnControls(editor) {
  const turns = [...editor.querySelectorAll(".ai-chat-turn")];
  const addTurnButton = editor.querySelector(".ai-chat-add-turn");
  if (addTurnButton) {
    const atLimit = turns.length >= aiChatLimits.turns;
    addTurnButton.disabled = atLimit;
    addTurnButton.setAttribute("aria-disabled", String(atLimit));
  }

  turns.forEach((turn, index) => {
    turn.dataset.aiTurnIndex = String(index);
    const turnLabel = turn.querySelector(".ai-chat-turn-label");
    if (turnLabel) turnLabel.textContent = t("aiChat.turnLabel", { count: index + 1 });
    const questionInput = turn.querySelector(".ai-chat-question-input");
    const answerInput = turn.querySelector(".ai-chat-answer-input");
    const timeInput = turn.querySelector(".ai-chat-time-input");
    questionInput?.setAttribute("aria-label", t("aiChat.questionAriaNumbered", { count: index + 1 }));
    answerInput?.setAttribute("aria-label", t("aiChat.answerAriaNumbered", { count: index + 1 }));
    timeInput?.setAttribute("aria-label", t("aiChat.timeAriaNumbered", { count: index + 1 }));
    const removeButton = turn.querySelector(".ai-chat-remove-turn");
    if (removeButton) {
      removeButton.hidden = turns.length <= 1;
      removeButton.title = t("aiChat.removeTurnNumbered", { count: index + 1 });
      removeButton.setAttribute("aria-label", t("aiChat.removeTurnNumbered", { count: index + 1 }));
    }
  });
}

function createTurnEditor(editor, row, turnData, { onDirty } = {}) {
  const turn = document.createElement("section");
  turn.className = "ai-chat-turn";

  const turnHeader = document.createElement("div");
  turnHeader.className = "ai-chat-turn-header";
  const turnLabel = document.createElement("span");
  turnLabel.className = "ai-chat-turn-label";
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "ai-chat-remove-turn";
  removeButton.dataset.action = "remove-ai-chat-turn";
  removeButton.textContent = "×";
  removeButton.addEventListener("click", () => {
    if (editor.querySelectorAll(".ai-chat-turn").length <= 1) return;
    turn.remove();
    syncTurnControls(editor);
    onDirty?.(row);
  });
  turnHeader.append(turnLabel, removeButton);

  const questionMessage = document.createElement("article");
  questionMessage.className = "ai-chat-message ai-chat-message--question";
  const questionMeta = document.createElement("header");
  questionMeta.className = "ai-chat-message-meta";
  const questionRole = document.createElement("span");
  questionRole.className = "ai-chat-role-mark";
  questionRole.textContent = "Q";
  const questionLabel = document.createElement("strong");
  questionLabel.textContent = t("aiChat.questionLabel");
  questionMeta.append(questionRole, questionLabel);

  const questionInput = document.createElement("textarea");
  questionInput.className = "ai-chat-question-input";
  questionInput.value = turnData.question;
  questionInput.maxLength = aiChatLimits.questionLength;
  questionInput.placeholder = t("aiChat.questionPlaceholder");
  questionInput.spellcheck = true;
  questionInput.rows = 1;
  questionMessage.append(questionMeta, questionInput);

  const answerMessage = document.createElement("article");
  answerMessage.className = "ai-chat-message ai-chat-message--answer";
  const answerMeta = document.createElement("header");
  answerMeta.className = "ai-chat-message-meta ai-chat-answer-meta";
  const answerIdentity = document.createElement("span");
  answerIdentity.className = "ai-chat-answer-identity";
  const answerIcon = document.createElement("span");
  answerIcon.className = "ai-chat-answer-icon";
  answerIcon.append(createAiProviderIcon(editor.dataset.aiProvider));
  const providerLabel = document.createElement("strong");
  providerLabel.className = "ai-chat-provider-label";
  const modelPreview = document.createElement("span");
  modelPreview.className = "ai-chat-model-preview";
  answerIdentity.append(answerIcon, providerLabel, modelPreview);

  const timeControl = document.createElement("label");
  timeControl.className = "ai-chat-turn-time-control";
  const timeCaption = document.createElement("span");
  timeCaption.textContent = t("aiChat.timeLabel");
  const timeInput = document.createElement("input");
  timeInput.type = "datetime-local";
  timeInput.className = "ai-chat-time-input";
  timeInput.value = turnData.answeredAt;
  timeInput.step = "60";
  timeInput.title = formatLocalDateTime(turnData.answeredAt);
  timeControl.append(timeCaption, timeInput);
  answerMeta.append(answerIdentity, timeControl);

  const answerInput = document.createElement("textarea");
  answerInput.className = "ai-chat-answer-input";
  answerInput.value = turnData.answer;
  answerInput.maxLength = aiChatLimits.answerLength;
  answerInput.placeholder = t("aiChat.answerPlaceholder");
  answerInput.spellcheck = true;
  answerInput.rows = 4;
  answerMessage.append(answerMeta, answerInput);

  const handleInput = (event) => {
    if (event.target instanceof HTMLTextAreaElement) autoGrow(event.target);
    if (event.target === timeInput) timeInput.title = formatLocalDateTime(timeInput.value);
    syncEditorPreview(editor);
    onDirty?.(row);
  };
  [questionInput, answerInput, timeInput].forEach((control) => {
    control.addEventListener("input", handleInput);
    control.addEventListener("change", handleInput);
  });

  turn.append(turnHeader, questionMessage, answerMessage);
  requestAnimationFrame(() => {
    autoGrow(questionInput);
    autoGrow(answerInput);
  });
  return turn;
}

export function createAiChatEditor(row, value, { onDirty, htmlCache = "" } = {}) {
  const data = normalizeAiChatData(value);
  const editor = document.createElement("section");
  editor.className = "ai-chat-block-editor";
  editor.dataset.aiProvider = data.provider;
  editor.setAttribute("aria-label", t("aiChat.editorAria"));

  const editingSurface = document.createElement("div");
  editingSurface.className = "ai-chat-editing-surface";

  const titleRow = document.createElement("div");
  titleRow.className = "ai-chat-title-row";
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "ai-chat-title-input";
  titleInput.value = data.title;
  titleInput.maxLength = aiChatLimits.titleLength;
  titleInput.placeholder = t("aiChat.titlePlaceholder");
  titleInput.setAttribute("aria-label", t("aiChat.titleAria"));
  titleRow.append(titleInput);

  const settings = document.createElement("div");
  settings.className = "ai-chat-settings";

  const providerField = document.createElement("div");
  providerField.className = "ai-chat-provider-field";
  const providerCaption = document.createElement("span");
  providerCaption.className = "ai-chat-setting-caption";
  providerCaption.textContent = t("aiChat.providerLabel");
  const providerPicker = document.createElement("div");
  providerPicker.className = "ai-chat-provider-picker";
  providerPicker.setAttribute("role", "group");
  providerPicker.setAttribute("aria-label", t("aiChat.providerAria"));

  aiProviderPresets.forEach((provider) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-chat-provider-option";
    button.dataset.aiProvider = provider.id;
    button.title = t("aiChat.chooseProvider", { provider: provider.label });
    button.setAttribute("aria-label", t("aiChat.chooseProvider", { provider: provider.label }));
    button.setAttribute("aria-pressed", String(provider.id === data.provider));
    button.append(createAiProviderIcon(provider.id), document.createTextNode(provider.label));
    button.addEventListener("click", () => {
      editor.dataset.aiProvider = provider.id;
      syncEditorPreview(editor);
      onDirty?.(row);
    });
    providerPicker.append(button);
  });
  providerField.append(providerCaption, providerPicker);

  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.className = "ai-chat-model-input";
  modelInput.value = data.model;
  modelInput.maxLength = aiChatLimits.modelLength;
  modelInput.placeholder = t("aiChat.modelPlaceholder");
  modelInput.setAttribute("aria-label", t("aiChat.modelAria"));
  modelInput.autocomplete = "off";

  settings.append(
    providerField,
    createLabeledField(t("aiChat.modelLabel"), modelInput)
  );

  const conversation = document.createElement("div");
  conversation.className = "ai-chat-conversation";
  data.turns.forEach((turnData) => {
    conversation.append(createTurnEditor(editor, row, turnData, { onDirty }));
  });

  const actions = document.createElement("div");
  actions.className = "ai-chat-actions";
  const addTurnButton = document.createElement("button");
  addTurnButton.type = "button";
  addTurnButton.className = "ai-chat-add-turn";
  addTurnButton.textContent = t("aiChat.addTurn");
  addTurnButton.title = t("aiChat.addTurnTitle");
  addTurnButton.addEventListener("click", () => {
    if (conversation.querySelectorAll(".ai-chat-turn").length >= aiChatLimits.turns) return;
    const turn = createTurnEditor(editor, row, normalizeTurn({ answeredAt: createLocalDateTimeValue() }), { onDirty });
    conversation.append(turn);
    syncTurnControls(editor);
    syncEditorPreview(editor);
    onDirty?.(row);
    turn.querySelector(".ai-chat-question-input")?.focus();
  });
  actions.append(addTurnButton);

  const preview = document.createElement("div");
  preview.className = "block-rendered-preview ai-chat-rendered-preview";
  preview.innerHTML = htmlCache || "";

  editingSurface.append(titleRow, settings, conversation, actions);
  editor.append(editingSurface, preview);

  const handleInput = () => {
    syncEditorPreview(editor);
    onDirty?.(row);
  };
  [titleInput, modelInput].forEach((control) => {
    control.addEventListener("input", handleInput);
    control.addEventListener("change", handleInput);
  });

  syncEditorPreview(editor);
  syncTurnControls(editor);
  return editor;
}

export function extractAiChatData(row) {
  const editor = row?.querySelector(".ai-chat-block-editor");
  if (!editor) return createDefaultAiChatData();
  return normalizeAiChatData({
    title: editor.querySelector(".ai-chat-title-input")?.value ?? "",
    provider: editor.dataset.aiProvider,
    model: editor.querySelector(".ai-chat-model-input")?.value ?? "",
    turns: [...editor.querySelectorAll(".ai-chat-turn")].map((turn) => ({
      answeredAt: turn.querySelector(".ai-chat-time-input")?.value ?? "",
      question: turn.querySelector(".ai-chat-question-input")?.value ?? "",
      answer: turn.querySelector(".ai-chat-answer-input")?.value ?? ""
    }))
  });
}
