import { formatNumber, getLocale, t } from "./i18n.js";

export const ganttLimits = Object.freeze({
  titleLength: 120,
  tasks: 200,
  taskTitleLength: 160,
  assigneeLength: 80,
  idLength: 64
});

export const ganttScales = Object.freeze(["week", "month", "quarter"]);
export const ganttStatuses = Object.freeze(["not_started", "in_progress", "review", "done", "blocked"]);

const millisecondsPerDay = 86_400_000;
const scaleSettings = Object.freeze({
  week: { days: 21, dayWidth: 42, shift: 7 },
  month: { days: 42, dayWidth: 28, shift: 28 },
  quarter: { days: 98, dayWidth: 18, shift: 84 }
});

function createId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.slice(0, ganttLimits.idLength);
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value, fallback, maxLength) {
  return (typeof value === "string" ? value : fallback).slice(0, maxLength);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
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

function startOfWeek(day) {
  const weekDay = new Date(day * millisecondsPerDay).getUTCDay();
  const mondayOffset = weekDay === 0 ? -6 : 1 - weekDay;
  return day + mondayOffset;
}

function normalizeScale(value) {
  return ganttScales.includes(value) ? value : "month";
}

function normalizeStatus(value) {
  return ganttStatuses.includes(value) ? value : "not_started";
}

function normalizeProgress(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(clamp(number, 0, 100)) : 0;
}

function normalizeTask(rawTask, index, seenIds, fallbackDay) {
  const source = recordValue(rawTask) ?? {};
  let id = stringValue(source.id, createId("task"), ganttLimits.idLength).trim() || createId("task");
  let suffix = 1;
  while (seenIds.has(id)) {
    id = `task-${index + 1}-${suffix}`.slice(0, ganttLimits.idLength);
    suffix += 1;
  }
  seenIds.add(id);

  const requestedStart = parseIsoDay(source.start);
  const requestedEnd = parseIsoDay(source.end);
  const startDay = requestedStart ?? fallbackDay + index * 2;
  const endDay = Math.max(startDay, requestedEnd ?? startDay + 4);

  return {
    id,
    title: stringValue(source.title, t("gantt.untitledTask"), ganttLimits.taskTitleLength),
    start: formatIsoDay(startDay),
    end: formatIsoDay(endDay),
    progress: normalizeProgress(source.progress),
    status: normalizeStatus(source.status),
    assignee: stringValue(source.assignee, "", ganttLimits.assigneeLength)
  };
}

export function createDefaultGanttData() {
  const today = getTodayDay();
  return {
    title: t("gantt.defaultTitle"),
    scale: "month",
    viewStart: formatIsoDay(startOfWeek(today) - 7),
    showWeekends: true,
    tasks: [
      {
        id: createId("task"),
        title: t("gantt.defaultTaskPlanning"),
        start: formatIsoDay(today - 2),
        end: formatIsoDay(today + 3),
        progress: 65,
        status: "in_progress",
        assignee: ""
      },
      {
        id: createId("task"),
        title: t("gantt.defaultTaskDelivery"),
        start: formatIsoDay(today + 2),
        end: formatIsoDay(today + 9),
        progress: 20,
        status: "review",
        assignee: ""
      }
    ]
  };
}

export function normalizeGanttData(value) {
  const source = recordValue(value) ?? {};
  const fallback = createDefaultGanttData();
  const scale = normalizeScale(source.scale);
  const today = getTodayDay();
  const requestedViewStart = parseIsoDay(source.viewStart);
  const viewStart = requestedViewStart ?? startOfWeek(today) - 7;
  const taskCollection = Array.isArray(source.tasks) ? source.tasks : null;
  const taskSources = taskCollection?.slice(0, ganttLimits.tasks) ?? [];
  const seenIds = new Set();
  const tasks = taskSources.map((task, index) => normalizeTask(task, index, seenIds, today));

  return {
    title: stringValue(source.title, fallback.title, ganttLimits.titleLength),
    scale,
    viewStart: formatIsoDay(viewStart),
    showWeekends: source.showWeekends !== false,
    tasks: taskCollection ? tasks : fallback.tasks
  };
}

function getScaleSetting(scale) {
  return scaleSettings[normalizeScale(scale)];
}

function statusLabel(status) {
  return t(`gantt.status.${normalizeStatus(status)}`);
}

function scaleLabel(scale) {
  return t(`gantt.scale.${normalizeScale(scale)}`);
}

function dateFormatter(options) {
  return new Intl.DateTimeFormat(getLocale(), { timeZone: "UTC", ...options });
}

function formatDateLabel(day) {
  return dateFormatter({ month: "short", day: "numeric" }).format(new Date(day * millisecondsPerDay));
}

function formatDayHeader(day, compact = false) {
  const date = new Date(day * millisecondsPerDay);
  return dateFormatter(compact
    ? { day: "numeric" }
    : { weekday: "narrow", day: "numeric" }).format(date);
}

function buildMonthGroups(startDay, count) {
  const groups = [];
  for (let index = 0; index < count; index += 1) {
    const day = startDay + index;
    const date = new Date(day * millisecondsPerDay);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    const current = groups.at(-1);
    if (current?.key === key) current.count += 1;
    else groups.push({
      key,
      count: 1,
      label: dateFormatter({ month: "long", year: "numeric" }).format(date)
    });
  }
  return groups;
}

function isWeekend(day) {
  const value = new Date(day * millisecondsPerDay).getUTCDay();
  return value === 0 || value === 6;
}

function taskDuration(task) {
  const start = parseIsoDay(task.start) ?? getTodayDay();
  const end = Math.max(start, parseIsoDay(task.end) ?? start);
  return end - start + 1;
}

function makeButton(action, label, title, data = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gantt-action-button";
  button.dataset.action = action;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  Object.entries(data).forEach(([key, value]) => {
    if (value !== null && value !== undefined) button.dataset[key] = String(value);
  });
  return button;
}

function makeStatusSelect(task) {
  const select = document.createElement("select");
  select.className = "gantt-status-select";
  select.dataset.taskId = task.id;
  select.dataset.field = "status";
  select.setAttribute("aria-label", t("gantt.statusAria", { task: task.title || t("gantt.untitledTask") }));
  ganttStatuses.forEach((status) => {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = statusLabel(status);
    select.append(option);
  });
  select.value = task.status;
  select.dataset.status = task.status;
  return select;
}

function updateTaskBar(editor, task) {
  const bar = editor.querySelector(`.gantt-bar[data-task-id="${CSS.escape(task.id)}"]`);
  if (!bar) return;
  bar.dataset.status = task.status;
  const label = bar.querySelector(".gantt-bar-label");
  if (label) label.textContent = task.title || t("gantt.untitledTask");
  const progress = bar.querySelector(".gantt-bar-progress");
  if (progress) progress.style.width = `${task.progress}%`;
  const progressLabel = bar.querySelector(".gantt-bar-progress-label");
  if (progressLabel) progressLabel.textContent = `${task.progress}%`;
  bar.setAttribute("aria-label", t("gantt.barAria", {
    task: task.title || t("gantt.untitledTask"),
    start: task.start,
    end: task.end,
    progress: task.progress
  }));
}

function positionTaskBar(bar, task, viewStartDay, dayWidth) {
  const startDay = parseIsoDay(task.start) ?? viewStartDay;
  const endDay = Math.max(startDay, parseIsoDay(task.end) ?? startDay);
  bar.style.left = `${(startDay - viewStartDay) * dayWidth + 3}px`;
  bar.style.width = `${Math.max(18, (endDay - startDay + 1) * dayWidth - 6)}px`;
}

function updateTaskDateInputs(editor, task) {
  for (const field of ["start", "end"]) {
    const input = editor.querySelector(`.gantt-task-input[data-task-id="${CSS.escape(task.id)}"][data-field="${field}"]`);
    if (input) input.value = task[field];
  }
}

function updateTaskProgressControls(editor, task) {
  const range = editor.querySelector(`.gantt-progress-input[data-task-id="${CSS.escape(task.id)}"]`);
  const output = editor.querySelector(`.gantt-progress-output[data-task-id="${CSS.escape(task.id)}"]`);
  if (range) range.value = String(task.progress);
  if (output) output.value = `${task.progress}%`;
}

function createTaskEditorRow(task) {
  const taskRow = document.createElement("div");
  taskRow.className = "gantt-task-row";
  taskRow.dataset.taskId = task.id;

  const main = document.createElement("div");
  main.className = "gantt-task-main";

  const status = makeStatusSelect(task);
  const title = document.createElement("input");
  title.type = "text";
  title.className = "gantt-task-input gantt-task-title";
  title.dataset.taskId = task.id;
  title.dataset.field = "title";
  title.value = task.title;
  title.maxLength = ganttLimits.taskTitleLength;
  title.placeholder = t("gantt.taskTitlePlaceholder");
  title.setAttribute("aria-label", t("gantt.taskTitleAria"));

  const assignee = document.createElement("input");
  assignee.type = "text";
  assignee.className = "gantt-task-input gantt-task-assignee";
  assignee.dataset.taskId = task.id;
  assignee.dataset.field = "assignee";
  assignee.value = task.assignee;
  assignee.maxLength = ganttLimits.assigneeLength;
  assignee.placeholder = t("gantt.assigneePlaceholder");
  assignee.setAttribute("aria-label", t("gantt.assigneeAria", { task: task.title || t("gantt.untitledTask") }));

  const remove = makeButton("gantt-delete-task", "×", t("gantt.deleteTask"), { taskId: task.id });
  remove.classList.add("gantt-delete-task");
  main.append(status, title, assignee, remove);

  const meta = document.createElement("div");
  meta.className = "gantt-task-meta";
  const start = document.createElement("input");
  start.type = "date";
  start.className = "gantt-task-input gantt-date-input";
  start.dataset.taskId = task.id;
  start.dataset.field = "start";
  start.value = task.start;
  start.setAttribute("aria-label", t("gantt.startDateAria", { task: task.title || t("gantt.untitledTask") }));

  const dateArrow = document.createElement("span");
  dateArrow.className = "gantt-date-arrow";
  dateArrow.textContent = "→";
  dateArrow.setAttribute("aria-hidden", "true");

  const end = document.createElement("input");
  end.type = "date";
  end.className = "gantt-task-input gantt-date-input";
  end.dataset.taskId = task.id;
  end.dataset.field = "end";
  end.value = task.end;
  end.setAttribute("aria-label", t("gantt.endDateAria", { task: task.title || t("gantt.untitledTask") }));

  const progressWrap = document.createElement("label");
  progressWrap.className = "gantt-progress-control";
  progressWrap.title = t("gantt.progressAria", { task: task.title || t("gantt.untitledTask") });
  const range = document.createElement("input");
  range.type = "range";
  range.className = "gantt-progress-input";
  range.dataset.taskId = task.id;
  range.min = "0";
  range.max = "100";
  range.step = "5";
  range.value = String(task.progress);
  range.setAttribute("aria-label", t("gantt.progressAria", { task: task.title || t("gantt.untitledTask") }));
  const output = document.createElement("output");
  output.className = "gantt-progress-output";
  output.dataset.taskId = task.id;
  output.value = `${task.progress}%`;
  output.textContent = `${task.progress}%`;
  progressWrap.append(range, output);
  meta.append(start, dateArrow, end, progressWrap);

  taskRow.append(main, meta);
  return taskRow;
}

function createTimelineHeader(viewStartDay, setting, showWeekends) {
  const header = document.createElement("div");
  header.className = "gantt-timeline-header";
  header.style.width = `${setting.days * setting.dayWidth}px`;

  const monthRow = document.createElement("div");
  monthRow.className = "gantt-month-row";
  buildMonthGroups(viewStartDay, setting.days).forEach((group) => {
    const cell = document.createElement("div");
    cell.className = "gantt-month-cell";
    cell.style.width = `${group.count * setting.dayWidth}px`;
    cell.textContent = group.label;
    monthRow.append(cell);
  });

  const dayRow = document.createElement("div");
  dayRow.className = "gantt-day-row";
  for (let index = 0; index < setting.days; index += 1) {
    const day = viewStartDay + index;
    const cell = document.createElement("div");
    cell.className = "gantt-day-cell";
    if (showWeekends && isWeekend(day)) cell.classList.add("is-weekend");
    if (day === getTodayDay()) cell.classList.add("is-today");
    cell.style.width = `${setting.dayWidth}px`;
    cell.textContent = formatDayHeader(day, setting.dayWidth < 24);
    cell.title = formatDateLabel(day);
    dayRow.append(cell);
  }

  header.append(monthRow, dayRow);
  return header;
}

function createTimelineRow(editor, row, task, gantt, viewStartDay, setting, onDirty) {
  const timelineRow = document.createElement("div");
  timelineRow.className = "gantt-timeline-row";
  timelineRow.style.width = `${setting.days * setting.dayWidth}px`;
  timelineRow.style.setProperty("--gantt-day-width", `${setting.dayWidth}px`);
  timelineRow.dataset.taskId = task.id;

  if (gantt.showWeekends) {
    for (let index = 0; index < setting.days; index += 1) {
      const day = viewStartDay + index;
      if (!isWeekend(day)) continue;
      const shade = document.createElement("span");
      shade.className = "gantt-weekend-shade";
      shade.style.left = `${index * setting.dayWidth}px`;
      shade.style.width = `${setting.dayWidth}px`;
      shade.setAttribute("aria-hidden", "true");
      timelineRow.append(shade);
    }
  }

  const today = getTodayDay();
  if (today >= viewStartDay && today < viewStartDay + setting.days) {
    const line = document.createElement("span");
    line.className = "gantt-today-line";
    line.style.left = `${(today - viewStartDay) * setting.dayWidth + setting.dayWidth / 2}px`;
    line.setAttribute("aria-hidden", "true");
    timelineRow.append(line);
  }

  const bar = document.createElement("div");
  bar.className = "gantt-bar";
  bar.dataset.taskId = task.id;
  bar.dataset.status = task.status;
  bar.tabIndex = 0;
  bar.setAttribute("role", "button");
  bar.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight");
  bar.setAttribute("aria-label", t("gantt.barAria", {
    task: task.title || t("gantt.untitledTask"),
    start: task.start,
    end: task.end,
    progress: task.progress
  }));
  positionTaskBar(bar, task, viewStartDay, setting.dayWidth);

  const progress = document.createElement("span");
  progress.className = "gantt-bar-progress";
  progress.style.width = `${task.progress}%`;
  progress.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "gantt-bar-label";
  label.textContent = task.title || t("gantt.untitledTask");

  const progressLabel = document.createElement("span");
  progressLabel.className = "gantt-bar-progress-label";
  progressLabel.textContent = `${task.progress}%`;

  const startHandle = document.createElement("span");
  startHandle.className = "gantt-resize-handle gantt-resize-handle--start";
  startHandle.dataset.edge = "start";
  startHandle.title = t("gantt.resizeStart");
  startHandle.setAttribute("aria-hidden", "true");

  const endHandle = document.createElement("span");
  endHandle.className = "gantt-resize-handle gantt-resize-handle--end";
  endHandle.dataset.edge = "end";
  endHandle.title = t("gantt.resizeEnd");
  endHandle.setAttribute("aria-hidden", "true");

  bar.append(progress, startHandle, label, progressLabel, endHandle);
  timelineRow.append(bar);

  const isReadOnly = () => row?.getAttribute("aria-readonly") === "true" || row?.classList.contains("is-read-only");
  let drag = null;

  const applyPreview = (nextStartDay, nextEndDay) => {
    const preview = { ...task, start: formatIsoDay(nextStartDay), end: formatIsoDay(nextEndDay) };
    positionTaskBar(bar, preview, viewStartDay, setting.dayWidth);
    bar.dataset.previewStart = preview.start;
    bar.dataset.previewEnd = preview.end;
  };

  const finishDrag = (commit) => {
    if (!drag) return;
    const current = drag;
    drag = null;
    bar.classList.remove("is-dragging");
    if (bar.hasPointerCapture?.(current.pointerId)) bar.releasePointerCapture(current.pointerId);
    if (!commit || current.nextStartDay === current.startDay && current.nextEndDay === current.endDay) {
      positionTaskBar(bar, task, viewStartDay, setting.dayWidth);
      delete bar.dataset.previewStart;
      delete bar.dataset.previewEnd;
      return;
    }
    task.start = formatIsoDay(current.nextStartDay);
    task.end = formatIsoDay(current.nextEndDay);
    delete bar.dataset.previewStart;
    delete bar.dataset.previewEnd;
    updateTaskDateInputs(editor, task);
    updateTaskBar(editor, task);
    onDirty();
  };

  bar.addEventListener("pointerdown", (event) => {
    if (isReadOnly() || event.button !== 0) return;
    const startDay = parseIsoDay(task.start) ?? getTodayDay();
    const endDay = Math.max(startDay, parseIsoDay(task.end) ?? startDay);
    const edge = event.target.closest?.(".gantt-resize-handle")?.dataset.edge ?? "move";
    drag = {
      pointerId: event.pointerId,
      originX: event.clientX,
      startDay,
      endDay,
      nextStartDay: startDay,
      nextEndDay: endDay,
      edge
    };
    bar.classList.add("is-dragging");
    bar.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  bar.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaDays = Math.round((event.clientX - drag.originX) / setting.dayWidth);
    if (drag.edge === "start") {
      drag.nextStartDay = Math.min(drag.endDay, drag.startDay + deltaDays);
      drag.nextEndDay = drag.endDay;
    } else if (drag.edge === "end") {
      drag.nextStartDay = drag.startDay;
      drag.nextEndDay = Math.max(drag.startDay, drag.endDay + deltaDays);
    } else {
      drag.nextStartDay = drag.startDay + deltaDays;
      drag.nextEndDay = drag.endDay + deltaDays;
    }
    applyPreview(drag.nextStartDay, drag.nextEndDay);
  });

  bar.addEventListener("pointerup", (event) => {
    if (drag?.pointerId === event.pointerId) finishDrag(true);
  });
  bar.addEventListener("pointercancel", () => finishDrag(false));

  bar.addEventListener("keydown", (event) => {
    if (isReadOnly() || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const startDay = parseIsoDay(task.start) ?? getTodayDay();
    const endDay = Math.max(startDay, parseIsoDay(task.end) ?? startDay);
    if (event.shiftKey) {
      task.end = formatIsoDay(Math.max(startDay, endDay + delta));
    } else {
      task.start = formatIsoDay(startDay + delta);
      task.end = formatIsoDay(endDay + delta);
    }
    positionTaskBar(bar, task, viewStartDay, setting.dayWidth);
    updateTaskDateInputs(editor, task);
    updateTaskBar(editor, task);
    onDirty();
    event.preventDefault();
  });

  return timelineRow;
}

function ensureTaskVisible(gantt, task) {
  const setting = getScaleSetting(gantt.scale);
  const currentStart = parseIsoDay(gantt.viewStart) ?? getTodayDay();
  const taskStart = parseIsoDay(task.start) ?? currentStart;
  const taskEnd = Math.max(taskStart, parseIsoDay(task.end) ?? taskStart);
  const currentEnd = currentStart + setting.days - 1;
  if (taskStart < currentStart || taskEnd > currentEnd) {
    const padding = Math.max(2, Math.round(setting.days * 0.15));
    gantt.viewStart = formatIsoDay(startOfWeek(taskStart - padding));
  }
}

export function createGanttEditor(row, value, { onDirty = () => {} } = {}) {
  const gantt = normalizeGanttData(value);
  const editor = document.createElement("div");
  editor.className = "gantt-block-editor";
  editor.ganttData = gantt;
  const isReadOnly = () => row?.getAttribute("aria-readonly") === "true" || row?.classList.contains("is-read-only");

  const replaceEditor = (focus = {}) => {
    const host = row.querySelector(".block-editor-host");
    if (!host) return;
    const next = createGanttEditor(row, gantt, { onDirty });
    host.replaceChildren(next);
    onDirty();
    requestAnimationFrame(() => {
      if (focus.taskId && focus.field) {
        next.querySelector(`[data-task-id="${CSS.escape(focus.taskId)}"][data-field="${CSS.escape(focus.field)}"]`)?.focus();
      } else if (focus.taskId) {
        next.querySelector(`.gantt-bar[data-task-id="${CSS.escape(focus.taskId)}"]`)?.focus();
      } else if (focus.title) {
        next.querySelector(".gantt-title-input")?.focus();
      }
    });
  };

  const heading = document.createElement("div");
  heading.className = "gantt-heading";
  const title = document.createElement("input");
  title.type = "text";
  title.className = "gantt-title-input";
  title.value = gantt.title;
  title.maxLength = ganttLimits.titleLength;
  title.placeholder = t("gantt.titlePlaceholder");
  title.setAttribute("aria-label", t("gantt.titleAria"));
  title.addEventListener("input", () => {
    if (isReadOnly()) return;
    gantt.title = title.value.slice(0, ganttLimits.titleLength);
    onDirty();
  });

  const count = document.createElement("span");
  count.className = "gantt-task-count";
  count.textContent = t("gantt.taskCount", { count: formatNumber(gantt.tasks.length) });
  heading.append(title, count);

  const toolbar = document.createElement("div");
  toolbar.className = "gantt-toolbar";
  const viewBar = document.createElement("div");
  viewBar.className = "gantt-view-bar";
  const tab = document.createElement("span");
  tab.className = "gantt-view-tab is-active";
  tab.setAttribute("aria-current", "true");
  const tabIcon = document.createElement("span");
  tabIcon.className = "gantt-view-tab-icon";
  tabIcon.textContent = "▥";
  tabIcon.setAttribute("aria-hidden", "true");
  const tabLabel = document.createElement("span");
  tabLabel.textContent = t("gantt.timelineView");
  tab.append(tabIcon, tabLabel);
  viewBar.append(tab);

  const controls = document.createElement("div");
  controls.className = "gantt-toolbar-controls";
  const scale = document.createElement("select");
  scale.className = "gantt-scale-select";
  scale.setAttribute("aria-label", t("gantt.scaleAria"));
  ganttScales.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = scaleLabel(value);
    scale.append(option);
  });
  scale.value = gantt.scale;
  scale.addEventListener("change", () => {
    if (isReadOnly()) return;
    gantt.scale = normalizeScale(scale.value);
    replaceEditor();
  });

  const weekends = document.createElement("label");
  weekends.className = "gantt-weekend-toggle";
  weekends.title = t("gantt.showWeekends");
  const weekendCheckbox = document.createElement("input");
  weekendCheckbox.type = "checkbox";
  weekendCheckbox.checked = gantt.showWeekends;
  weekendCheckbox.setAttribute("aria-label", t("gantt.showWeekends"));
  weekendCheckbox.addEventListener("change", () => {
    if (isReadOnly()) return;
    gantt.showWeekends = weekendCheckbox.checked;
    replaceEditor();
  });
  const weekendLabel = document.createElement("span");
  weekendLabel.textContent = t("gantt.weekends");
  weekends.append(weekendCheckbox, weekendLabel);

  const previous = makeButton("gantt-previous", "‹", t("gantt.previousRange"));
  const today = makeButton("gantt-today", t("gantt.today"), t("gantt.today"));
  const next = makeButton("gantt-next", "›", t("gantt.nextRange"));
  controls.append(scale, weekends, previous, today, next);
  toolbar.append(viewBar, controls);

  const setting = getScaleSetting(gantt.scale);
  const viewStartDay = parseIsoDay(gantt.viewStart) ?? startOfWeek(getTodayDay()) - 7;
  const scroll = document.createElement("div");
  scroll.className = "gantt-scroll";
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", t("gantt.timelineAria"));

  const stage = document.createElement("div");
  stage.className = "gantt-stage";
  stage.style.setProperty("--gantt-day-width", `${setting.dayWidth}px`);
  stage.style.setProperty("--gantt-timeline-width", `${setting.days * setting.dayWidth}px`);

  const taskPanel = document.createElement("div");
  taskPanel.className = "gantt-task-panel";
  const taskHeader = document.createElement("div");
  taskHeader.className = "gantt-task-header";
  taskHeader.innerHTML = `<strong>${t("gantt.taskColumn")}</strong><span>${t("gantt.scheduleColumn")}</span>`;
  const taskRows = document.createElement("div");
  taskRows.className = "gantt-task-rows";
  gantt.tasks.forEach((task) => taskRows.append(createTaskEditorRow(task)));
  taskPanel.append(taskHeader, taskRows);

  const timelinePanel = document.createElement("div");
  timelinePanel.className = "gantt-timeline-panel";
  timelinePanel.append(createTimelineHeader(viewStartDay, setting, gantt.showWeekends));
  const timelineRows = document.createElement("div");
  timelineRows.className = "gantt-timeline-rows";
  gantt.tasks.forEach((task) => timelineRows.append(createTimelineRow(editor, row, task, gantt, viewStartDay, setting, onDirty)));
  timelinePanel.append(timelineRows);

  stage.append(taskPanel, timelinePanel);
  scroll.append(stage);

  const footer = document.createElement("div");
  footer.className = "gantt-footer";
  const addTask = makeButton("gantt-add-task", `＋ ${t("gantt.addTask")}`, t("gantt.addTask"));
  addTask.classList.add("gantt-add-task");
  addTask.disabled = gantt.tasks.length >= ganttLimits.tasks;
  const hint = document.createElement("span");
  hint.className = "gantt-interaction-hint";
  hint.textContent = t("gantt.interactionHint");
  footer.append(addTask, hint);

  editor.append(heading, toolbar, scroll, footer);

  editor.addEventListener("input", (event) => {
    if (isReadOnly()) return;
    const target = event.target;
    const taskId = target?.dataset?.taskId;
    if (!taskId) return;
    const task = gantt.tasks.find((item) => item.id === taskId);
    if (!task) return;

    if (target.classList.contains("gantt-progress-input")) {
      task.progress = normalizeProgress(target.value);
      updateTaskProgressControls(editor, task);
      updateTaskBar(editor, task);
      onDirty();
      return;
    }

    if (!target.classList.contains("gantt-task-input")) return;
    if (target.dataset.field === "title") {
      task.title = target.value.slice(0, ganttLimits.taskTitleLength);
      updateTaskBar(editor, task);
      onDirty();
    } else if (target.dataset.field === "assignee") {
      task.assignee = target.value.slice(0, ganttLimits.assigneeLength);
      onDirty();
    }
  });

  editor.addEventListener("change", (event) => {
    if (isReadOnly()) return;
    const target = event.target;
    const taskId = target?.dataset?.taskId;
    if (!taskId) return;
    const task = gantt.tasks.find((item) => item.id === taskId);
    if (!task) return;

    if (target.classList.contains("gantt-status-select")) {
      task.status = normalizeStatus(target.value);
      target.dataset.status = task.status;
      updateTaskBar(editor, task);
      onDirty();
      return;
    }

    if (!target.classList.contains("gantt-date-input")) return;
    const valueDay = parseIsoDay(target.value);
    if (valueDay === null) {
      target.value = task[target.dataset.field];
      return;
    }
    const startDay = parseIsoDay(task.start) ?? valueDay;
    const endDay = parseIsoDay(task.end) ?? startDay;
    if (target.dataset.field === "start") {
      task.start = formatIsoDay(valueDay);
      if (valueDay > endDay) task.end = formatIsoDay(valueDay);
    } else {
      task.end = formatIsoDay(Math.max(startDay, valueDay));
    }
    ensureTaskVisible(gantt, task);
    replaceEditor({ taskId: task.id, field: target.dataset.field });
  });

  editor.addEventListener("click", (event) => {
    if (isReadOnly()) return;
    const button = event.target.closest("button[data-action]");
    if (!button || !editor.contains(button)) return;
    const action = button.dataset.action;
    const currentStart = parseIsoDay(gantt.viewStart) ?? viewStartDay;

    if (action === "gantt-previous" || action === "gantt-next") {
      const direction = action === "gantt-previous" ? -1 : 1;
      gantt.viewStart = formatIsoDay(currentStart + getScaleSetting(gantt.scale).shift * direction);
      replaceEditor();
    } else if (action === "gantt-today") {
      gantt.viewStart = formatIsoDay(startOfWeek(getTodayDay()) - Math.max(2, Math.round(setting.days * 0.15)));
      replaceEditor();
    } else if (action === "gantt-add-task") {
      if (gantt.tasks.length >= ganttLimits.tasks) return;
      const lastTask = gantt.tasks.at(-1);
      const baseDay = lastTask ? (parseIsoDay(lastTask.end) ?? getTodayDay()) + 1 : getTodayDay();
      const task = {
        id: createId("task"),
        title: t("gantt.untitledTask"),
        start: formatIsoDay(baseDay),
        end: formatIsoDay(baseDay + 4),
        progress: 0,
        status: "not_started",
        assignee: ""
      };
      gantt.tasks.push(task);
      ensureTaskVisible(gantt, task);
      replaceEditor({ taskId: task.id, field: "title" });
    } else if (action === "gantt-delete-task") {
      const task = gantt.tasks.find((item) => item.id === button.dataset.taskId);
      if (!task || !window.confirm(t("gantt.confirmDeleteTask", { task: task.title || t("gantt.untitledTask") }))) return;
      gantt.tasks = gantt.tasks.filter((item) => item.id !== task.id);
      replaceEditor();
    }
  });

  return editor;
}

export function extractGanttData(row) {
  return normalizeGanttData(row?.querySelector(".gantt-block-editor")?.ganttData);
}

export function summarizeGanttData(value) {
  const gantt = normalizeGanttData(value);
  const lines = [gantt.title];
  gantt.tasks.forEach((task) => {
    lines.push(
      task.title,
      statusLabel(task.status),
      task.assignee,
      `${task.start} ${task.end}`,
      `${task.progress}%`
    );
  });
  return lines.filter(Boolean).join("\n").slice(0, 20_000);
}
