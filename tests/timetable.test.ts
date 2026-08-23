import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTimetableData } from "../src/lib/timetable.js";
import { renderBlockHtml } from "../src/lib/markdown.js";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const moduleSource = readFileSync(new URL("../public/timetable-block.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../src/utils/schemas.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/029_blocks_timetable_type.sql", import.meta.url), "utf8");

describe("Timetable block", () => {
  it("registers the slash command and metadata-backed editor", () => {
    expect(client).toContain('{ type: "TIMETABLE", command: "/timetable", icon: "timetable" }');
    expect(client).toContain("createTimetableEditor(row, getBlockTimetableData(block)");
    expect(client).toContain("metadata.timetable = timetable");
    expect(client).toContain("payload.markdown = summarizeTimetableData(timetable)");
    expect(client).toContain('if (type === "TIMETABLE") return { timetable: createDefaultTimetableData() };');
    expect(schema).toContain('"TIMETABLE"');
    expect(migration).toContain("'TIMETABLE'");
  });

  it("uses native date and free one-minute time controls with quick entry", () => {
    expect(moduleSource).toContain('date.type = "date"');
    expect(moduleSource).toContain('input.type = "time"');
    expect(moduleSource).toContain('quickStart.type = "time"');
    expect(moduleSource).toContain('quickEnd.type = "time"');
    expect(moduleSource).toContain("timetableTimeStepSeconds = 60");
    expect(moduleSource).toContain("input.step = String(timetableTimeStepSeconds)");
    expect(moduleSource).toContain("quickStart.step = String(timetableTimeStepSeconds)");
    expect(moduleSource).toContain("quickEnd.step = String(timetableTimeStepSeconds)");
    expect(moduleSource).toContain("Object.freeze([1])");
    expect(moduleSource).not.toContain("timetable-interval-select");
    expect(moduleSource).toContain('makeButton("timetable-add-entry"');
    expect(moduleSource).toContain('makeButton("timetable-previous-day"');
    expect(moduleSource).toContain('makeButton("timetable-today"');
    expect(moduleSource).toContain('makeButton("timetable-next-day"');
  });

  it("keeps every editable timetable column on the same row height", () => {
    expect(moduleSource).toContain('timeFields.className = "timetable-time-fields"');
    expect(moduleSource).toContain("timeFields.append(start, arrow, end)");
    expect(moduleSource).toContain("timeCell.append(timeFields)");
    expect(styles).toMatch(/\.timetable-time-cell\s*\{[^}]*min-width:\s*13\.2rem;[^}]*padding-inline:\s*0\.18rem\s*!important;[^}]*\}/s);
    expect(styles).not.toMatch(/\.timetable-time-cell\s*\{[^}]*display:\s*grid;/s);
    expect(styles).toMatch(/\.timetable-time-fields\s*\{[^}]*display:\s*grid;[^}]*min-height:\s*2\.55rem;[^}]*align-items:\s*stretch;/s);
    expect(styles).toMatch(/\.timetable-time-input\s*\{[^}]*min-height:\s*2\.55rem;/s);
  });

  it("normalizes invalid ranges, duplicate IDs, and chronological order", () => {
    const data = getTimetableData({
      timetable: {
        title: "Workday",
        date: "2026-08-01",
        interval: 15,
        entries: [
          { id: "same", start: "10:00", end: "09:00", title: "Later", note: "", completed: false },
          { id: "same", start: "08:00", end: "08:30", title: "Earlier", note: "", completed: true }
        ]
      }
    });

    expect(data.date).toBe("2026-08-01");
    expect(data.interval).toBe(1);
    expect(data.entries.map((entry) => entry.start)).toEqual(["08:00", "10:00"]);
    expect(data.entries.map((entry) => entry.end)).toEqual(["08:30", "10:30"]);
    expect(new Set(data.entries.map((entry) => entry.id)).size).toBe(2);
    expect(data.entries[0].completed).toBe(true);
  });

  it("preserves an intentionally empty schedule", () => {
    const data = getTimetableData({
      timetable: { title: "Empty day", date: "2026-08-01", interval: 30, entries: [] }
    });
    expect(data.entries).toEqual([]);
  });

  it("renders sanitized read-only timetable HTML with semantic dates and times", () => {
    const html = renderBlockHtml("TIMETABLE", "", false, {
      timetable: {
        title: "Saturday plan <script>alert(1)</script>",
        date: "2026-08-01",
        interval: 30,
        entries: [{
          id: "slot-1",
          start: "09:00",
          end: "10:00",
          title: "Morning review",
          note: '<img src=x onerror="alert(1)"> notes',
          completed: true
        }]
      }
    });

    expect(html).toContain('class="rendered-timetable"');
    expect(html).toContain('datetime="2026-08-01"');
    expect(html).toContain('datetime="2026-08-01T09:00"');
    expect(html).toContain('datetime="2026-08-01T10:00"');
    expect(html).toContain("Morning review");
    expect(html).toContain('class="is-complete"');
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<script\b/i);
  });

  it("matches the borderless database-style surface and Korean copy", () => {
    expect(styles).toContain('.editor-block-row[data-block-type="TIMETABLE"]');
    expect(styles).toMatch(/\.timetable-block-editor\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(/\.timetable-table\s*\{[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(/\.rendered-timetable-scroll\s*\{[^}]*background:\s*transparent;/s);
    expect(styles).toContain(".page-view.is-read-only .timetable-date-nav");
    expect(i18n).toContain('blockType: "타임테이블"');
    expect(i18n).toContain('dayView: "하루 일정"');
    expect(i18n).toContain('addSlot: "시간대 추가"');
    expect(i18n).toContain('inputHint: "시작·종료 시간은 1분 단위로 자유롭게 입력할 수 있어요."');
  });
});
