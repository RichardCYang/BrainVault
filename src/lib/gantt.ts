export const ganttLimits = {
  titleLength: 120,
  tasks: 200,
  taskTitleLength: 160,
  assigneeLength: 80,
  idLength: 64
} as const;

export const ganttScales = ["week", "month", "quarter"] as const;
export type GanttScale = (typeof ganttScales)[number];

export const ganttStatuses = ["not_started", "in_progress", "review", "done", "blocked"] as const;
export type GanttStatus = (typeof ganttStatuses)[number];

export type GanttTask = {
  id: string;
  title: string;
  start: string;
  end: string;
  progress: number;
  status: GanttStatus;
  assignee: string;
};

export type GanttData = {
  title: string;
  scale: GanttScale;
  viewStart: string;
  showWeekends: boolean;
  tasks: GanttTask[];
};

const millisecondsPerDay = 86_400_000;
const scaleSettings = {
  week: { days: 21 },
  month: { days: 42 },
  quarter: { days: 98 }
} as const;

function parseMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown, fallback: string, maximum: number) {
  return (typeof value === "string" ? value : fallback).slice(0, maximum);
}

function parseIsoDay(value: unknown) {
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

function formatIsoDay(day: number) {
  return new Date(day * millisecondsPerDay).toISOString().slice(0, 10);
}

function getTodayDay() {
  const now = new Date();
  return Math.trunc(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / millisecondsPerDay);
}

function startOfWeek(day: number) {
  const weekDay = new Date(day * millisecondsPerDay).getUTCDay();
  return day + (weekDay === 0 ? -6 : 1 - weekDay);
}

function normalizeScale(value: unknown): GanttScale {
  return ganttScales.includes(value as GanttScale) ? value as GanttScale : "month";
}

function normalizeStatus(value: unknown): GanttStatus {
  return ganttStatuses.includes(value as GanttStatus) ? value as GanttStatus : "not_started";
}

function normalizeProgress(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(0, Math.min(100, number)));
}

function uniqueId(requested: string, seen: Set<string>, fallback: string) {
  let value = requested.trim().slice(0, ganttLimits.idLength) || fallback;
  let attempt = 1;
  while (seen.has(value)) {
    value = `${fallback}-${attempt}`.slice(0, ganttLimits.idLength);
    attempt += 1;
  }
  seen.add(value);
  return value;
}

export function createDefaultGanttData(): GanttData {
  const today = getTodayDay();
  return {
    title: "Project timeline",
    scale: "month",
    viewStart: formatIsoDay(startOfWeek(today) - 7),
    showWeekends: true,
    tasks: [
      {
        id: "task-1",
        title: "Project planning",
        start: formatIsoDay(today - 2),
        end: formatIsoDay(today + 3),
        progress: 65,
        status: "in_progress",
        assignee: ""
      },
      {
        id: "task-2",
        title: "Delivery",
        start: formatIsoDay(today + 2),
        end: formatIsoDay(today + 9),
        progress: 20,
        status: "review",
        assignee: ""
      }
    ]
  };
}

export function getGanttData(metadata: unknown): GanttData {
  const value = parseMetadata(metadata)?.gantt;
  if (!value || typeof value !== "object" || Array.isArray(value)) return createDefaultGanttData();
  const source = value as Record<string, unknown>;
  const fallback = createDefaultGanttData();
  const today = getTodayDay();
  const taskCollection = Array.isArray(source.tasks) ? source.tasks : null;
  const taskSources = taskCollection?.slice(0, ganttLimits.tasks) ?? [];
  const seenIds = new Set<string>();
  const tasks = taskSources
    .map(recordValue)
    .filter((task): task is Record<string, unknown> => Boolean(task))
    .map((task, index) => {
      const startDay = parseIsoDay(task.start) ?? today + index * 2;
      const endDay = Math.max(startDay, parseIsoDay(task.end) ?? startDay + 4);
      return {
        id: uniqueId(stringValue(task.id, `task-${index + 1}`, ganttLimits.idLength), seenIds, `task-${index + 1}`),
        title: stringValue(task.title, "Untitled task", ganttLimits.taskTitleLength),
        start: formatIsoDay(startDay),
        end: formatIsoDay(endDay),
        progress: normalizeProgress(task.progress),
        status: normalizeStatus(task.status),
        assignee: stringValue(task.assignee, "", ganttLimits.assigneeLength)
      };
    });
  const viewStartDay = parseIsoDay(source.viewStart) ?? startOfWeek(today) - 7;
  return {
    title: stringValue(source.title, fallback.title, ganttLimits.titleLength),
    scale: normalizeScale(source.scale),
    viewStart: formatIsoDay(viewStartDay),
    showWeekends: source.showWeekends !== false,
    tasks: taskCollection ? tasks : fallback.tasks
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isWeekend(day: number) {
  const weekDay = new Date(day * millisecondsPerDay).getUTCDay();
  return weekDay === 0 || weekDay === 6;
}

function dayLabel(day: number, compact: boolean) {
  const date = new Date(day * millisecondsPerDay);
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    ...(compact ? { day: "numeric" } : { weekday: "narrow", day: "numeric" })
  }).format(date);
}

function monthGroups(startDay: number, days: number) {
  const groups: Array<{ key: string; label: string; start: number; count: number }> = [];
  for (let index = 0; index < days; index += 1) {
    const date = new Date((startDay + index) * millisecondsPerDay);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    const current = groups.at(-1);
    if (current?.key === key) current.count += 1;
    else groups.push({
      key,
      label: new Intl.DateTimeFormat("en", { timeZone: "UTC", month: "long", year: "numeric" }).format(date),
      start: index + 1,
      count: 1
    });
  }
  return groups;
}

function statusLabel(status: GanttStatus) {
  return ({
    not_started: "Not started",
    in_progress: "In progress",
    review: "Review",
    done: "Done",
    blocked: "Blocked"
  } as const)[status];
}

export function renderGanttHtml(metadata: unknown) {
  const gantt = getGanttData(metadata);
  const setting = scaleSettings[gantt.scale];
  const startDay = parseIsoDay(gantt.viewStart) ?? startOfWeek(getTodayDay()) - 7;
  const today = getTodayDay();

  const monthHeader = monthGroups(startDay, setting.days)
    .map((group) => `<span class="rendered-gantt-month" style="grid-column: ${group.start} / span ${group.count}">${escapeHtml(group.label)}</span>`)
    .join("");
  const dayHeader = Array.from({ length: setting.days }, (_, index) => {
    const day = startDay + index;
    const classes = ["rendered-gantt-day"];
    if (gantt.showWeekends && isWeekend(day)) classes.push("is-weekend");
    if (day === today) classes.push("is-today");
    return `<span class="${classes.join(" ")}">${escapeHtml(dayLabel(day, gantt.scale === "quarter"))}</span>`;
  }).join("");

  const taskRows = gantt.tasks.map((task) => {
    const owner = task.assignee ? `<small>${escapeHtml(task.assignee)}</small>` : "";
    return `<div class="rendered-gantt-task-row"><div><span class="rendered-gantt-status rendered-gantt-status--${task.status}">${escapeHtml(statusLabel(task.status))}</span><strong>${escapeHtml(task.title || "Untitled task")}</strong>${owner}</div><span>${escapeHtml(task.start)} → ${escapeHtml(task.end)}</span><span>${task.progress}%</span></div>`;
  }).join("");

  const timelineRows = gantt.tasks.map((task) => {
    const taskStart = parseIsoDay(task.start) ?? startDay;
    const taskEnd = Math.max(taskStart, parseIsoDay(task.end) ?? taskStart);
    const visibleStart = Math.max(taskStart, startDay);
    const visibleEnd = Math.min(taskEnd, startDay + setting.days - 1);
    const weekendCells = gantt.showWeekends
      ? Array.from({ length: setting.days }, (_, index) => isWeekend(startDay + index)
        ? `<span class="rendered-gantt-weekend" style="grid-column: ${index + 1}"></span>`
        : "").join("")
      : "";
    const todayLine = today >= startDay && today < startDay + setting.days
      ? `<span class="rendered-gantt-today-line" style="grid-column: ${today - startDay + 1}"></span>`
      : "";
    const bar = visibleStart <= visibleEnd
      ? `<span class="rendered-gantt-bar rendered-gantt-bar--${task.status}" style="grid-column: ${visibleStart - startDay + 1} / span ${visibleEnd - visibleStart + 1}"><span class="rendered-gantt-progress" style="width: ${task.progress}%"></span><strong>${escapeHtml(task.title || "Untitled task")}</strong></span>`
      : "";
    return `<div class="rendered-gantt-timeline-row">${weekendCells}${todayLine}${bar}</div>`;
  }).join("");

  return `<section class="rendered-gantt rendered-gantt--${gantt.scale}"><header><h3>${escapeHtml(gantt.title)}</h3><span>Timeline · ${gantt.tasks.length} tasks</span></header><div class="rendered-gantt-scroll"><div class="rendered-gantt-stage"><div class="rendered-gantt-task-panel"><div class="rendered-gantt-task-header"><strong>Task</strong><span>Schedule</span><span>Progress</span></div>${taskRows}</div><div class="rendered-gantt-timeline-panel"><div class="rendered-gantt-month-row">${monthHeader}</div><div class="rendered-gantt-day-row">${dayHeader}</div>${timelineRows}</div></div></div></section>`;
}
