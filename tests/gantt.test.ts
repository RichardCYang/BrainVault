import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getGanttData } from "../src/lib/gantt.js";
import { renderBlockHtml } from "../src/lib/markdown.js";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const moduleSource = readFileSync(new URL("../public/gantt-block.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../src/utils/schemas.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/028_blocks_gantt_type.sql", import.meta.url), "utf8");

describe("Gantt chart block", () => {
  it("registers the slash command and metadata-backed editor", () => {
    expect(client).toContain('{ type: "GANTT", command: "/gantt", icon: "gantt" }');
    expect(client).toContain("createGanttEditor(row, getBlockGanttData(block)");
    expect(client).toContain("metadata.gantt = gantt");
    expect(client).toContain("payload.markdown = summarizeGanttData(gantt)");
    expect(client).toContain('if (type === "GANTT") return { gantt: createDefaultGanttData() };');
    expect(schema).toContain('"GANTT"');
    expect(migration).toContain("'GANTT'");
  });

  it("supports scale changes, task progress, drag movement, and edge resizing", () => {
    expect(moduleSource).toContain('export const ganttScales = Object.freeze(["week", "month", "quarter"])');
    expect(moduleSource).toContain('range.type = "range"');
    expect(moduleSource).toContain('bar.addEventListener("pointerdown"');
    expect(moduleSource).toContain("bar.setPointerCapture?.(event.pointerId)");
    expect(moduleSource).toContain('event.target.closest?.(".gantt-resize-handle")');
    expect(moduleSource).toContain('bar.addEventListener("keydown"');
    expect(moduleSource).toContain("ensureTaskVisible(gantt, task)");
  });

  it("normalizes dates, progress, statuses, and duplicate identifiers", () => {
    const data = getGanttData({
      gantt: {
        title: "Launch",
        scale: "week",
        viewStart: "2026-08-03",
        showWeekends: false,
        tasks: [
          {
            id: "task",
            title: "Design",
            start: "2026-08-05",
            end: "2026-08-02",
            progress: 130,
            status: "unknown",
            assignee: "Mina"
          },
          {
            id: "task",
            title: "Build",
            start: "invalid",
            end: "invalid",
            progress: 42.4,
            status: "done",
            assignee: ""
          }
        ]
      }
    });

    expect(data.title).toBe("Launch");
    expect(data.scale).toBe("week");
    expect(data.showWeekends).toBe(false);
    expect(data.tasks[0].end).toBe(data.tasks[0].start);
    expect(data.tasks[0].progress).toBe(100);
    expect(data.tasks[0].status).toBe("not_started");
    expect(data.tasks[1].id).not.toBe(data.tasks[0].id);
    expect(data.tasks[1].progress).toBe(42);
    expect(getGanttData({ gantt: { tasks: [] } }).tasks).toEqual([]);
  });

  it("renders a sanitized read-only timeline with date-grid placement", () => {
    const html = renderBlockHtml("GANTT", "", false, {
      gantt: {
        title: "<script>alert(1)</script>Launch plan",
        scale: "month",
        viewStart: "2026-08-01",
        showWeekends: true,
        tasks: [{
          id: "task-1",
          title: "<img src=x onerror=alert(1)>Build",
          start: "2026-08-03",
          end: "2026-08-08",
          progress: 55,
          status: "in_progress",
          assignee: "Mina"
        }]
      }
    });

    expect(html).toContain('class="rendered-gantt rendered-gantt--month"');
    expect(html).toContain("Launch plan");
    expect(html).toContain("Build");
    expect(html).toContain("Mina");
    expect(html).toContain('style="grid-column: 3 / span 6"');
    expect(html).toContain('style="width: 55%"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("matches the existing database and board visual language and includes Korean copy", () => {
    expect(styles).toContain('.editor-block-row[data-block-type="GANTT"]');
    expect(styles).toContain(".gantt-task-panel");
    expect(styles).toContain("--gantt-canvas: var(--chrome-canvas, var(--bg));");
    expect(styles).toMatch(/\.gantt-scroll\s*\{[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(/\.gantt-task-row\s*\{[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(/\.rendered-gantt-scroll\s*\{[^}]*background:\s*transparent;/s);
    expect(styles).toContain("position: sticky");
    expect(styles).toContain(".gantt-today-line");
    expect(styles).toContain(".rendered-gantt-stage");
    expect(styles).toContain(".page-view.is-read-only .gantt-bar");
    expect(i18n).toContain('blockType: "간트 차트"');
    expect(i18n).toContain('timelineView: "타임라인"');
    expect(i18n).toContain('interactionHint: "막대를 드래그해 일정을 옮기고, 양쪽 끝을 드래그해 기간을 조정하세요."');
  });
});
