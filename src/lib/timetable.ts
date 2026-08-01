export const timetableLimits = {
  titleLength: 120,
  entries: 200,
  entryTitleLength: 160,
  noteLength: 500,
  idLength: 64
} as const;

export const timetableIntervals = [1] as const;
export type TimetableInterval = (typeof timetableIntervals)[number];
export const timetableDefaultDurationMinutes = 30;

export type TimetableEntry = {
  id: string;
  start: string;
  end: string;
  title: string;
  note: string;
  completed: boolean;
};

export type TimetableData = {
  title: string;
  date: string;
  interval: TimetableInterval;
  entries: TimetableEntry[];
};

const millisecondsPerDay = 86_400_000;

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

function parseTime(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatTime(minutes: number) {
  const safe = Math.max(0, Math.min(1_439, Math.trunc(minutes)));
  return `${String(Math.trunc(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function normalizeInterval(_value: unknown): TimetableInterval {
  return 1;
}

function latestStartForDefaultDuration() {
  return Math.max(0, 1_439 - timetableDefaultDurationMinutes);
}

function uniqueId(requested: string, seen: Set<string>, fallback: string) {
  let value = requested.trim().slice(0, timetableLimits.idLength) || fallback;
  let attempt = 1;
  while (seen.has(value)) {
    value = `${fallback}-${attempt}`.slice(0, timetableLimits.idLength);
    attempt += 1;
  }
  seen.add(value);
  return value;
}

function normalizeEntry(
  source: Record<string, unknown>,
  index: number,
  _interval: TimetableInterval,
  seenIds: Set<string>
): TimetableEntry {
  const fallbackStart = Math.min(22 * 60, 9 * 60 + index * timetableDefaultDurationMinutes);
  let start = parseTime(source.start) ?? fallbackStart;
  let end = parseTime(source.end) ?? Math.min(1_439, start + timetableDefaultDurationMinutes);
  if (end <= start) {
    const latestStart = latestStartForDefaultDuration();
    if (start > latestStart) start = latestStart;
    end = Math.min(1_439, start + timetableDefaultDurationMinutes);
  }

  return {
    id: uniqueId(stringValue(source.id, `entry-${index + 1}`, timetableLimits.idLength), seenIds, `entry-${index + 1}`),
    start: formatTime(start),
    end: formatTime(end),
    title: stringValue(source.title, "", timetableLimits.entryTitleLength),
    note: stringValue(source.note, "", timetableLimits.noteLength),
    completed: source.completed === true
  };
}

function sortEntries(entries: TimetableEntry[]) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const startDifference = (parseTime(left.entry.start) ?? 0) - (parseTime(right.entry.start) ?? 0);
      if (startDifference !== 0) return startDifference;
      const endDifference = (parseTime(left.entry.end) ?? 0) - (parseTime(right.entry.end) ?? 0);
      return endDifference !== 0 ? endDifference : left.index - right.index;
    })
    .map(({ entry }) => entry);
}

export function createDefaultTimetableData(): TimetableData {
  return {
    title: "Daily timetable",
    date: formatIsoDay(getTodayDay()),
    interval: 1,
    entries: [{
      id: "entry-1",
      start: "09:00",
      end: "10:00",
      title: "",
      note: "",
      completed: false
    }]
  };
}

export function getTimetableData(metadata: unknown): TimetableData {
  const value = parseMetadata(metadata)?.timetable;
  if (!value || typeof value !== "object" || Array.isArray(value)) return createDefaultTimetableData();
  const source = value as Record<string, unknown>;
  const fallback = createDefaultTimetableData();
  const interval = normalizeInterval(source.interval);
  const entryCollection = Array.isArray(source.entries) ? source.entries : null;
  const seenIds = new Set<string>();
  const entries = (entryCollection?.slice(0, timetableLimits.entries) ?? [])
    .map(recordValue)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry, index) => normalizeEntry(entry, index, interval, seenIds));

  return {
    title: stringValue(source.title, fallback.title, timetableLimits.titleLength),
    date: formatIsoDay(parseIsoDay(source.date) ?? getTodayDay()),
    interval,
    entries: entryCollection ? sortEntries(entries) : fallback.entries
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

export function renderTimetableHtml(metadata: unknown) {
  const timetable = getTimetableData(metadata);
  const rows = timetable.entries.length
    ? timetable.entries.map((entry) => {
        const rowClass = entry.completed ? ' class="is-complete"' : "";
        const title = escapeHtml(entry.title || "Untitled schedule");
        const note = entry.note ? `<span>${escapeHtml(entry.note)}</span>` : '<span class="rendered-timetable-empty-note">—</span>';
        const marker = entry.completed ? "✓" : "○";
        return `<tr${rowClass}><td class="rendered-timetable-check" aria-label="${entry.completed ? "Completed" : "Not completed"}">${marker}</td><td class="rendered-timetable-time"><time datetime="${escapeHtml(`${timetable.date}T${entry.start}`)}">${escapeHtml(entry.start)}</time><span aria-hidden="true">→</span><time datetime="${escapeHtml(`${timetable.date}T${entry.end}`)}">${escapeHtml(entry.end)}</time></td><td><strong>${title}</strong></td><td>${note}</td></tr>`;
      }).join("")
    : '<tr><td class="rendered-timetable-empty" colspan="4">No time slots yet.</td></tr>';

  return `<section class="rendered-timetable"><header><div><h3>${escapeHtml(timetable.title)}</h3><span>Timetable · ${timetable.entries.length} slots</span></div><time datetime="${escapeHtml(timetable.date)}">${escapeHtml(timetable.date)}</time></header><div class="rendered-timetable-scroll"><table class="rendered-timetable-table"><thead><tr><th scope="col"><span class="visually-hidden">Done</span></th><th scope="col">Time</th><th scope="col">Schedule</th><th scope="col">Notes</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
