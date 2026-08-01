import { formatNumber, getLocale, t } from "./i18n.js";

export const timetableLimits = Object.freeze({
  titleLength: 120,
  entries: 200,
  entryTitleLength: 160,
  noteLength: 500,
  idLength: 64
});

export const timetableIntervals = Object.freeze([1]);
export const timetableDefaultDurationMinutes = 30;
export const timetableTimeStepSeconds = 60;

const millisecondsPerDay = 86_400_000;

function createId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.slice(0, timetableLimits.idLength);
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value, fallback, maximum) {
  return (typeof value === "string" ? value : fallback).slice(0, maximum);
}

function parseIsoDay(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.trunc(time / millisecondsPerDay);
}

function formatIsoDay(day) {
  return new Date(day * millisecondsPerDay).toISOString().slice(0, 10);
}

function getTodayDay() {
  const now = new Date();
  return Math.trunc(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / millisecondsPerDay);
}

function parseTime(value) {
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatTime(minutes) {
  const safe = Math.max(0, Math.min(1_439, Math.trunc(minutes)));
  return `${String(Math.trunc(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function normalizeInterval(_value) {
  return 1;
}

function latestStartForDefaultDuration() {
  return Math.max(0, 1_439 - timetableDefaultDurationMinutes);
}

function normalizeRange(startValue, endValue, fallbackStart) {
  let start = parseTime(startValue) ?? fallbackStart;
  let end = parseTime(endValue) ?? Math.min(1_439, start + timetableDefaultDurationMinutes);
  if (end <= start) {
    const latestStart = latestStartForDefaultDuration();
    if (start > latestStart) start = latestStart;
    end = Math.min(1_439, start + timetableDefaultDurationMinutes);
  }
  return { start: formatTime(start), end: formatTime(end) };
}

function normalizeEntry(rawEntry, index, interval, seenIds) {
  const source = recordValue(rawEntry) ?? {};
  let id = stringValue(source.id, createId("entry"), timetableLimits.idLength).trim() || createId("entry");
  let suffix = 1;
  while (seenIds.has(id)) {
    id = `entry-${index + 1}-${suffix}`.slice(0, timetableLimits.idLength);
    suffix += 1;
  }
  seenIds.add(id);
  const range = normalizeRange(
    source.start,
    source.end,
    Math.min(22 * 60, 9 * 60 + index * timetableDefaultDurationMinutes)
  );
  return {
    id,
    ...range,
    title: stringValue(source.title, "", timetableLimits.entryTitleLength),
    note: stringValue(source.note, "", timetableLimits.noteLength),
    completed: source.completed === true
  };
}

function sortEntries(entries) {
  entries.sort((left, right) => {
    const startDifference = (parseTime(left.start) ?? 0) - (parseTime(right.start) ?? 0);
    if (startDifference !== 0) return startDifference;
    return (parseTime(left.end) ?? 0) - (parseTime(right.end) ?? 0);
  });
  return entries;
}

export function createDefaultTimetableData() {
  return {
    title: t("timetable.defaultTitle"),
    date: formatIsoDay(getTodayDay()),
    interval: 1,
    entries: [{
      id: createId("entry"),
      start: "09:00",
      end: "10:00",
      title: "",
      note: "",
      completed: false
    }]
  };
}

export function normalizeTimetableData(value) {
  const source = recordValue(value) ?? {};
  const fallback = createDefaultTimetableData();
  const interval = normalizeInterval(source.interval);
  const entryCollection = Array.isArray(source.entries) ? source.entries : null;
  const seenIds = new Set();
  const entries = (entryCollection?.slice(0, timetableLimits.entries) ?? [])
    .map((entry, index) => normalizeEntry(entry, index, interval, seenIds));

  return {
    title: stringValue(source.title, fallback.title, timetableLimits.titleLength),
    date: formatIsoDay(parseIsoDay(source.date) ?? getTodayDay()),
    interval,
    entries: entryCollection ? sortEntries(entries) : fallback.entries
  };
}

function makeButton(action, label, title, data = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "timetable-action-button";
  button.dataset.action = action;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  Object.entries(data).forEach(([key, value]) => {
    if (value !== null && value !== undefined) button.dataset[key] = String(value);
  });
  return button;
}

function createTimeInput(entry, field) {
  const input = document.createElement("input");
  input.type = "time";
  input.className = "timetable-input timetable-time-input";
  input.dataset.entryId = entry.id;
  input.dataset.field = field;
  input.value = entry[field];
  input.step = String(timetableTimeStepSeconds);
  input.setAttribute("aria-label", t(field === "start" ? "timetable.startTimeAria" : "timetable.endTimeAria", {
    schedule: entry.title || t("timetable.untitledEntry")
  }));
  return input;
}

function createEntryRow(entry) {
  const row = document.createElement("tr");
  row.className = "timetable-entry-row";
  row.dataset.entryId = entry.id;
  row.classList.toggle("is-complete", entry.completed);

  const completeCell = document.createElement("td");
  completeCell.className = "timetable-complete-cell";
  const complete = document.createElement("input");
  complete.type = "checkbox";
  complete.className = "timetable-complete-input";
  complete.dataset.entryId = entry.id;
  complete.checked = entry.completed;
  complete.setAttribute("aria-label", t("timetable.completedAria", {
    schedule: entry.title || t("timetable.untitledEntry")
  }));
  completeCell.append(complete);

  const timeCell = document.createElement("td");
  timeCell.className = "timetable-time-cell";
  const start = createTimeInput(entry, "start");
  const arrow = document.createElement("span");
  arrow.className = "timetable-time-arrow";
  arrow.textContent = "→";
  arrow.setAttribute("aria-hidden", "true");
  const end = createTimeInput(entry, "end");
  timeCell.append(start, arrow, end);

  const titleCell = document.createElement("td");
  const title = document.createElement("input");
  title.type = "text";
  title.className = "timetable-input timetable-entry-title";
  title.dataset.entryId = entry.id;
  title.dataset.field = "title";
  title.value = entry.title;
  title.maxLength = timetableLimits.entryTitleLength;
  title.placeholder = t("timetable.entryPlaceholder");
  title.setAttribute("aria-label", t("timetable.entryAria"));
  titleCell.append(title);

  const noteCell = document.createElement("td");
  const note = document.createElement("input");
  note.type = "text";
  note.className = "timetable-input timetable-entry-note";
  note.dataset.entryId = entry.id;
  note.dataset.field = "note";
  note.value = entry.note;
  note.maxLength = timetableLimits.noteLength;
  note.placeholder = t("timetable.notePlaceholder");
  note.setAttribute("aria-label", t("timetable.noteAria", {
    schedule: entry.title || t("timetable.untitledEntry")
  }));
  noteCell.append(note);

  const actionCell = document.createElement("td");
  actionCell.className = "timetable-row-actions";
  const remove = makeButton("timetable-delete-entry", "×", t("timetable.deleteEntry"), { entryId: entry.id });
  remove.classList.add("timetable-delete-entry");
  actionCell.append(remove);

  row.append(completeCell, timeCell, titleCell, noteCell, actionCell);
  return row;
}

function suggestedRange(timetable) {
  const lastEnd = timetable.entries.reduce((maximum, entry) => Math.max(maximum, parseTime(entry.end) ?? 0), 9 * 60);
  let start = Math.min(lastEnd, latestStartForDefaultDuration());
  if (start < 0) start = 9 * 60;
  return {
    start: formatTime(start),
    end: formatTime(Math.min(1_439, start + timetableDefaultDurationMinutes))
  };
}

function formatSelectedDate(date) {
  const day = parseIsoDay(date);
  if (day === null) return date;
  return new Intl.DateTimeFormat(getLocale(), {
    timeZone: "UTC",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(day * millisecondsPerDay));
}

export function createTimetableEditor(row, value, { onDirty = () => {} } = {}) {
  const timetable = normalizeTimetableData(value);
  const editor = document.createElement("div");
  editor.className = "timetable-block-editor";
  editor.timetableData = timetable;
  const isReadOnly = () => row?.getAttribute("aria-readonly") === "true" || row?.classList.contains("is-read-only");

  const replaceEditor = (focus = {}) => {
    const host = row.querySelector(".block-editor-host");
    if (!host) return;
    const next = createTimetableEditor(row, timetable, { onDirty });
    host.replaceChildren(next);
    onDirty();
    requestAnimationFrame(() => {
      if (focus.entryId && focus.field) {
        next.querySelector(`[data-entry-id="${CSS.escape(focus.entryId)}"][data-field="${CSS.escape(focus.field)}"]`)?.focus();
      } else if (focus.entryId) {
        next.querySelector(`.timetable-entry-row[data-entry-id="${CSS.escape(focus.entryId)}"] .timetable-entry-title`)?.focus();
      } else if (focus.title) {
        next.querySelector(".timetable-title-input")?.focus();
      } else if (focus.date) {
        next.querySelector(".timetable-date-input")?.focus();
      }
    });
  };

  const heading = document.createElement("div");
  heading.className = "timetable-heading";
  const title = document.createElement("input");
  title.type = "text";
  title.className = "timetable-title-input";
  title.value = timetable.title;
  title.maxLength = timetableLimits.titleLength;
  title.placeholder = t("timetable.titlePlaceholder");
  title.setAttribute("aria-label", t("timetable.titleAria"));
  title.addEventListener("input", () => {
    if (isReadOnly()) return;
    timetable.title = title.value.slice(0, timetableLimits.titleLength);
    onDirty();
  });
  const count = document.createElement("span");
  count.className = "timetable-entry-count";
  count.textContent = t("timetable.entryCount", { count: formatNumber(timetable.entries.length) });
  heading.append(title, count);

  const toolbar = document.createElement("div");
  toolbar.className = "timetable-toolbar";
  const viewBar = document.createElement("div");
  viewBar.className = "timetable-view-bar";
  const view = document.createElement("span");
  view.className = "timetable-view-tab is-active";
  view.setAttribute("aria-current", "true");
  const viewIcon = document.createElement("span");
  viewIcon.className = "timetable-view-icon";
  viewIcon.textContent = "▦";
  viewIcon.setAttribute("aria-hidden", "true");
  const viewLabel = document.createElement("span");
  viewLabel.textContent = t("timetable.dayView");
  view.append(viewIcon, viewLabel);
  viewBar.append(view);

  const controls = document.createElement("div");
  controls.className = "timetable-toolbar-controls";
  const previous = makeButton("timetable-previous-day", "‹", t("timetable.previousDay"));
  previous.classList.add("timetable-date-nav");
  const today = makeButton("timetable-today", t("timetable.today"), t("timetable.today"));
  today.classList.add("timetable-date-nav");
  const next = makeButton("timetable-next-day", "›", t("timetable.nextDay"));
  next.classList.add("timetable-date-nav");
  const date = document.createElement("input");
  date.type = "date";
  date.className = "timetable-date-input";
  date.value = timetable.date;
  date.title = formatSelectedDate(timetable.date);
  date.setAttribute("aria-label", t("timetable.dateAria"));
  date.addEventListener("change", () => {
    if (isReadOnly()) return;
    const day = parseIsoDay(date.value);
    if (day === null) {
      date.value = timetable.date;
      return;
    }
    timetable.date = formatIsoDay(day);
    date.title = formatSelectedDate(timetable.date);
    onDirty();
  });

  controls.append(previous, today, next, date);
  toolbar.append(viewBar, controls);

  const tableScroll = document.createElement("div");
  tableScroll.className = "timetable-table-scroll";
  tableScroll.tabIndex = 0;
  tableScroll.setAttribute("role", "region");
  tableScroll.setAttribute("aria-label", t("timetable.tableAria"));
  const table = document.createElement("table");
  table.className = "timetable-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  [t("timetable.doneColumn"), t("timetable.timeColumn"), t("timetable.scheduleColumn"), t("timetable.notesColumn"), ""].forEach((label, index) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    if (index === 0) cell.className = "timetable-complete-heading";
    if (index === 4) cell.setAttribute("aria-label", t("timetable.actionsColumn"));
    headRow.append(cell);
  });
  head.append(headRow);
  const body = document.createElement("tbody");
  if (timetable.entries.length) {
    timetable.entries.forEach((entry) => body.append(createEntryRow(entry)));
  } else {
    const emptyRow = document.createElement("tr");
    emptyRow.className = "timetable-empty-row";
    const emptyCell = document.createElement("td");
    emptyCell.colSpan = 5;
    emptyCell.textContent = t("timetable.empty");
    emptyRow.append(emptyCell);
    body.append(emptyRow);
  }
  table.append(head, body);
  tableScroll.append(table);

  const footer = document.createElement("div");
  footer.className = "timetable-footer";
  const quick = document.createElement("div");
  quick.className = "timetable-quick-add";
  const range = suggestedRange(timetable);
  const quickStart = document.createElement("input");
  quickStart.type = "time";
  quickStart.className = "timetable-quick-time";
  quickStart.value = range.start;
  quickStart.step = String(timetableTimeStepSeconds);
  quickStart.setAttribute("aria-label", t("timetable.quickStartAria"));
  const quickArrow = document.createElement("span");
  quickArrow.textContent = "→";
  quickArrow.setAttribute("aria-hidden", "true");
  const quickEnd = document.createElement("input");
  quickEnd.type = "time";
  quickEnd.className = "timetable-quick-time";
  quickEnd.value = range.end;
  quickEnd.step = String(timetableTimeStepSeconds);
  quickEnd.setAttribute("aria-label", t("timetable.quickEndAria"));
  const add = makeButton("timetable-add-entry", `＋ ${t("timetable.addSlot")}`, t("timetable.addSlot"));
  add.classList.add("timetable-add-entry");
  add.disabled = timetable.entries.length >= timetableLimits.entries;
  quick.append(quickStart, quickArrow, quickEnd, add);
  const hint = document.createElement("span");
  hint.className = "timetable-input-hint";
  hint.textContent = t("timetable.inputHint");
  footer.append(quick, hint);

  editor.append(heading, toolbar, tableScroll, footer);

  editor.addEventListener("input", (event) => {
    if (isReadOnly()) return;
    const target = event.target;
    const entryId = target?.dataset?.entryId;
    if (!entryId || !target.classList.contains("timetable-input") || target.classList.contains("timetable-time-input")) return;
    const entry = timetable.entries.find((item) => item.id === entryId);
    if (!entry) return;
    if (target.dataset.field === "title") entry.title = target.value.slice(0, timetableLimits.entryTitleLength);
    else if (target.dataset.field === "note") entry.note = target.value.slice(0, timetableLimits.noteLength);
    onDirty();
  });

  editor.addEventListener("change", (event) => {
    if (isReadOnly()) return;
    const target = event.target;
    const entryId = target?.dataset?.entryId;
    if (!entryId) return;
    const entry = timetable.entries.find((item) => item.id === entryId);
    if (!entry) return;

    if (target.classList.contains("timetable-complete-input")) {
      entry.completed = target.checked;
      target.closest(".timetable-entry-row")?.classList.toggle("is-complete", entry.completed);
      onDirty();
      return;
    }

    if (!target.classList.contains("timetable-time-input")) return;
    const requested = parseTime(target.value);
    if (requested === null) {
      target.value = entry[target.dataset.field];
      return;
    }
    const normalized = normalizeRange(
      target.dataset.field === "start" ? target.value : entry.start,
      target.dataset.field === "end" ? target.value : entry.end,
      parseTime(entry.start) ?? 9 * 60
    );
    entry.start = normalized.start;
    entry.end = normalized.end;
    sortEntries(timetable.entries);
    replaceEditor({ entryId: entry.id, field: target.dataset.field });
  });

  editor.addEventListener("click", (event) => {
    if (isReadOnly()) return;
    const button = event.target.closest("button[data-action]");
    if (!button || !editor.contains(button)) return;
    const action = button.dataset.action;

    if (action === "timetable-previous-day" || action === "timetable-next-day") {
      const current = parseIsoDay(timetable.date) ?? getTodayDay();
      timetable.date = formatIsoDay(current + (action === "timetable-previous-day" ? -1 : 1));
      replaceEditor({ date: true });
    } else if (action === "timetable-today") {
      timetable.date = formatIsoDay(getTodayDay());
      replaceEditor({ date: true });
    } else if (action === "timetable-add-entry") {
      if (timetable.entries.length >= timetableLimits.entries) return;
      const fallback = suggestedRange(timetable);
      const normalized = normalizeRange(quickStart.value, quickEnd.value, parseTime(fallback.start) ?? 9 * 60);
      const entry = {
        id: createId("entry"),
        ...normalized,
        title: "",
        note: "",
        completed: false
      };
      timetable.entries.push(entry);
      sortEntries(timetable.entries);
      replaceEditor({ entryId: entry.id, field: "title" });
    } else if (action === "timetable-delete-entry") {
      const entry = timetable.entries.find((item) => item.id === button.dataset.entryId);
      if (!entry || !window.confirm(t("timetable.confirmDeleteEntry", {
        schedule: entry.title || `${entry.start}–${entry.end}`
      }))) return;
      timetable.entries = timetable.entries.filter((item) => item.id !== entry.id);
      replaceEditor();
    }
  });

  return editor;
}

export function extractTimetableData(row) {
  return normalizeTimetableData(row?.querySelector(".timetable-block-editor")?.timetableData);
}

export function summarizeTimetableData(value) {
  const timetable = normalizeTimetableData(value);
  const lines = [timetable.title, timetable.date];
  timetable.entries.forEach((entry) => {
    lines.push(`${entry.start}-${entry.end} ${entry.completed ? "[x]" : "[ ]"} ${entry.title}`.trim(), entry.note);
  });
  return lines.filter(Boolean).join("\n").slice(0, 20_000);
}
