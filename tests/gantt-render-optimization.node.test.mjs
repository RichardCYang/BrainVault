import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrl = new URL("../src/lib/gantt.ts", import.meta.url);

function quarterFixture(taskCount = 200) {
  return {
    gantt: {
      title: "Release <plan>",
      scale: "quarter",
      viewStart: "2026-07-06",
      showWeekends: true,
      tasks: Array.from({ length: taskCount }, (_, index) => ({
        id: `task-${index + 1}`,
        title: `Task ${index + 1} <safe>`,
        start: `2026-07-${String((index % 20) + 1).padStart(2, "0")}`,
        end: `2026-08-${String((index % 20) + 1).padStart(2, "0")}`,
        progress: (index * 7) % 101,
        status: ["not_started", "in_progress", "review", "done", "blocked"][index % 5],
        assignee: `User ${index % 8}`
      }))
    }
  };
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

test("Gantt server rendering reuses the three fixed UTC date formatters", async () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  let constructorCalls = 0;

  function CountingDateTimeFormat(...args) {
    constructorCalls += 1;
    return new OriginalDateTimeFormat(...args);
  }
  Object.setPrototypeOf(CountingDateTimeFormat, OriginalDateTimeFormat);
  CountingDateTimeFormat.prototype = OriginalDateTimeFormat.prototype;
  Intl.DateTimeFormat = CountingDateTimeFormat;

  try {
    const { renderGanttHtml } = await import(`${moduleUrl.href}?formatter-reuse=${Date.now()}`);
    const fixture = quarterFixture(200);
    const first = renderGanttHtml(fixture);
    const second = renderGanttHtml(fixture);

    assert.equal(first, second);
    assert.equal(constructorCalls, 3);
    assert.doesNotMatch(first, /<script|onerror/i);
  } finally {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }
});

test("Gantt task-invariant timeline decorations are computed outside the task loop without changing rendered multiplicity", async () => {
  const source = await readFile(moduleUrl, "utf8");
  const mapOffset = source.indexOf("const timelineRows = gantt.tasks.map");
  const weekendOffset = source.indexOf("const weekendCells = gantt.showWeekends");
  const todayOffset = source.indexOf("const todayLine = today >= startDay");
  assert.ok(weekendOffset >= 0 && weekendOffset < mapOffset);
  assert.ok(todayOffset >= 0 && todayOffset < mapOffset);

  const { renderGanttHtml } = await import(`${moduleUrl.href}?decoration-reuse=${Date.now()}`);
  const taskCount = 12;
  const html = renderGanttHtml(quarterFixture(taskCount));
  const start = new Date("2026-07-06T00:00:00.000Z");
  let weekendDays = 0;
  for (let index = 0; index < 98; index += 1) {
    const day = new Date(start.getTime() + index * 86_400_000).getUTCDay();
    if (day === 0 || day === 6) weekendDays += 1;
  }
  assert.equal(countOccurrences(html, 'class="rendered-gantt-weekend"'), weekendDays * taskCount);
});
