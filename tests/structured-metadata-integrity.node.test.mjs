import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getDatabaseData } from "../src/lib/database.ts";
import {
  assertStructuredBlockMetadataIntegrity,
  StructuredMetadataIntegrityError
} from "../src/lib/structured-metadata-integrity.ts";

function expectIntegrityFailure(type, metadata, expectedPath) {
  assert.throws(
    () => assertStructuredBlockMetadataIntegrity(type, metadata),
    (error) => error instanceof StructuredMetadataIntegrityError && error.path === expectedPath
  );
}

test("normalized structured metadata remains accepted at exact limits", () => {
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("TABLE", {
    table: { rows: [["x".repeat(4_000)]], headerRow: true, headerColumn: false }
  }));
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("KANBAN", {
    kanban: {
      title: "Project board",
      columns: [{
        id: "todo",
        title: "To do",
        color: "gray",
        cards: [{ id: "card-1", title: "Task", description: "", icon: "", color: "default", tags: [] }]
      }]
    }
  }));
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("DATABASE", {
    database: {
      title: "Database",
      properties: [{ id: "title", name: "Name", type: "title", options: [] }],
      rows: [{ id: "row-1", values: { title: "" } }],
      views: [{
        id: "table-view",
        name: "Table",
        type: "table",
        filters: [],
        sorts: [],
        groupPropertyId: null,
        hiddenPropertyIds: []
      }],
      activeViewId: "table-view"
    }
  }));
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("TIMETABLE", {
    timetable: {
      title: "Workday",
      date: "2026-08-01",
      interval: 1,
      entries: [{
        id: "slot-1",
        start: "09:00",
        end: "10:00",
        title: "Planning",
        note: "Bring notes",
        completed: false
      }]
    }
  }));
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("GANTT", {
    gantt: {
      title: "Project timeline",
      scale: "month",
      viewStart: "2026-08-01",
      showWeekends: true,
      tasks: [{
        id: "task-1",
        title: "Build",
        start: "2026-08-03",
        end: "2026-08-08",
        progress: 55,
        status: "in_progress",
        assignee: "Mina"
      }]
    }
  }));
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("BOOKMARK", {
    bookmark: {
      title: "Bookmarks",
      view: "gallery",
      items: [{
        id: "bookmark-1",
        url: "https://example.com/",
        title: "Example",
        description: "",
        imageUrl: "https://example.com/image.png",
        faviconUrl: "https://example.com/favicon.ico",
        siteName: "example.com"
      }]
    }
  }));
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("AI_CHAT", {
    aiChat: {
      provider: "chatgpt",
      model: "gpt-test",
      answeredAt: "2026-07-30T09:28",
      question: "q".repeat(8_000),
      answer: "a".repeat(12_000)
    }
  }));
});


test("bookmark metadata validates list column counts from one through five", () => {
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("BOOKMARK", {
    bookmark: { title: "Bookmarks", view: "list", listColumns: 1, items: [] }
  }));
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("BOOKMARK", {
    bookmark: { title: "Bookmarks", view: "list", listColumns: 5, items: [] }
  }));
  expectIntegrityFailure("BOOKMARK", {
    bookmark: { title: "Bookmarks", view: "list", listColumns: 0, items: [] }
  }, "metadata.bookmark.listColumns");
  expectIntegrityFailure("BOOKMARK", {
    bookmark: { title: "Bookmarks", view: "list", listColumns: 6, items: [] }
  }, "metadata.bookmark.listColumns");
  expectIntegrityFailure("BOOKMARK", {
    bookmark: { title: "Bookmarks", view: "list", listColumns: 2.5, items: [] }
  }, "metadata.bookmark.listColumns");
});

test("bookmark metadata validates the block title without normalizing it", () => {
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("BOOKMARK", {
    bookmark: { title: "x".repeat(120), view: "gallery", items: [] }
  }));
  expectIntegrityFailure("BOOKMARK", {
    bookmark: { title: "x".repeat(121), view: "gallery", items: [] }
  }, "metadata.bookmark.title");
  expectIntegrityFailure("BOOKMARK", {
    bookmark: { title: " leading", view: "gallery", items: [] }
  }, "metadata.bookmark.title");
});

test("bookmark metadata rejects private IP literals in stored page and asset URLs", () => {
  const item = {
    id: "bookmark-private",
    url: "https://example.com/",
    title: "Example",
    description: "",
    imageUrl: "https://example.com/image.png",
    faviconUrl: "https://example.com/favicon.ico",
    siteName: "example.com"
  };
  const metadata = (overrides) => ({ bookmark: { view: "gallery", items: [{ ...item, ...overrides }] } });

  expectIntegrityFailure("BOOKMARK", metadata({ imageUrl: "http://192.168.1.1/admin.png" }), "metadata.bookmark.items[0].imageUrl");
  expectIntegrityFailure("BOOKMARK", metadata({ faviconUrl: "http://[::1]/favicon.ico" }), "metadata.bookmark.items[0].faviconUrl");
  expectIntegrityFailure("BOOKMARK", metadata({ imageUrl: "http://[::ffff:192.168.1.1]/admin.png" }), "metadata.bookmark.items[0].imageUrl");
  expectIntegrityFailure("BOOKMARK", metadata({ url: "http://127.0.0.1/" }), "metadata.bookmark.items[0].url");
  expectIntegrityFailure("BOOKMARK", metadata({ url: "http://[fec0::1]/" }), "metadata.bookmark.items[0].url");
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("BOOKMARK", metadata({ imageUrl: "https://cdn.example.com/image.png" })));
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("BOOKMARK", metadata({ imageUrl: "http://[::ffff:808:808]/image.png" })));
});

test("JSON text metadata is decoded and serialized exactly once", () => {
  const metadata = {
    aiChat: {
      provider: "chatgpt",
      model: "gpt-test",
      answeredAt: "2026-07-30T09:28",
      question: "Question",
      answer: "Answer"
    }
  };
  const encoded = JSON.stringify(metadata);
  const validated = assertStructuredBlockMetadataIntegrity("AI_CHAT", encoded);
  assert.deepEqual(validated, metadata);
  assert.equal(JSON.stringify(validated), encoded);
  assert.notEqual(JSON.stringify(validated), JSON.stringify(encoded));
});

test("database fallback views never retain references to missing properties", () => {
  const normalized = getDatabaseData({ database: {} });
  const propertyIds = new Set(normalized.properties.map((property) => property.id));
  for (const view of normalized.views) {
    assert.ok(!view.groupPropertyId || propertyIds.has(view.groupPropertyId));
    assert.ok(view.hiddenPropertyIds.every((propertyId) => propertyIds.has(propertyId)));
  }
  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("DATABASE", { database: normalized }));
});

test("AI metadata that the old save path silently truncated is rejected atomically", () => {
  expectIntegrityFailure("AI_CHAT", {
    aiChat: { provider: "chatgpt", model: "", answeredAt: "", question: "", answer: "a".repeat(12_001) }
  }, "metadata.aiChat.answer");
});

test("collection overflows that editor normalizers would discard fail closed", () => {
  expectIntegrityFailure("TABLE", {
    table: { rows: Array.from({ length: 51 }, () => [""]), headerRow: false, headerColumn: false }
  }, "metadata.table.rows");

  expectIntegrityFailure("KANBAN", {
    kanban: {
      title: "board",
      columns: Array.from({ length: 13 }, (_, index) => ({
        id: `column-${index}`,
        title: "column",
        color: "gray",
        cards: []
      }))
    }
  }, "metadata.kanban.columns");

  expectIntegrityFailure("DATABASE", {
    database: {
      properties: [{ id: "title", name: "Name", type: "title", options: [] }],
      rows: Array.from({ length: 201 }, (_, index) => ({ id: `row-${index}`, values: { title: "" } })),
      views: []
    }
  }, "metadata.database.rows");

  expectIntegrityFailure("TIMETABLE", {
    timetable: {
      title: "Workday",
      date: "2026-08-01",
      interval: 30,
      entries: Array.from({ length: 201 }, (_, index) => ({
        id: `slot-${index}`,
        start: "09:00",
        end: "10:00",
        title: "Task",
        note: "",
        completed: false
      }))
    }
  }, "metadata.timetable.entries");

  expectIntegrityFailure("GANTT", {
    gantt: {
      title: "Timeline",
      scale: "month",
      viewStart: "2026-08-01",
      showWeekends: true,
      tasks: Array.from({ length: 201 }, (_, index) => ({
        id: `task-${index}`,
        title: "Task",
        start: "2026-08-01",
        end: "2026-08-01",
        progress: 0,
        status: "not_started",
        assignee: ""
      }))
    }
  }, "metadata.gantt.tasks");

  expectIntegrityFailure("BOOKMARK", {
    bookmark: {
      view: "gallery",
      items: Array.from({ length: 51 }, (_, index) => ({
        id: `bookmark-${index}`,
        url: `https://example.com/${index}`,
        title: `Example ${index}`,
        description: "",
        imageUrl: "",
        faviconUrl: "",
        siteName: "example.com"
      }))
    }
  }, "metadata.bookmark.items");
});


test("timetable metadata rejects invalid dates, intervals, time ranges, and duplicate IDs", () => {
  const baseEntry = {
    id: "slot-1",
    start: "09:00",
    end: "10:00",
    title: "Task",
    note: "",
    completed: false
  };
  const root = (entries, overrides = {}) => ({
    timetable: {
      title: "Workday",
      date: "2026-08-01",
      interval: 30,
      entries,
      ...overrides
    }
  });

  assert.doesNotThrow(() => assertStructuredBlockMetadataIntegrity("TIMETABLE", root([baseEntry], { interval: 15 })));
  expectIntegrityFailure("TIMETABLE", root([baseEntry], { date: "2026-02-30" }), "metadata.timetable.date");
  expectIntegrityFailure("TIMETABLE", root([baseEntry], { interval: 20 }), "metadata.timetable.interval");
  expectIntegrityFailure("TIMETABLE", root([{ ...baseEntry, start: "9:00" }]), "metadata.timetable.entries[0].start");
  expectIntegrityFailure("TIMETABLE", root([{ ...baseEntry, end: "09:00" }]), "metadata.timetable.entries[0].end");
  expectIntegrityFailure("TIMETABLE", root([baseEntry, { ...baseEntry }]), "metadata.timetable.entries");
});

test("Gantt metadata rejects invalid dates, progress, statuses, and duplicate task IDs", () => {
  const baseTask = {
    id: "task-1",
    title: "Task",
    start: "2026-08-01",
    end: "2026-08-05",
    progress: 25,
    status: "in_progress",
    assignee: ""
  };
  const root = (tasks) => ({
    gantt: {
      title: "Timeline",
      scale: "month",
      viewStart: "2026-08-01",
      showWeekends: true,
      tasks
    }
  });

  expectIntegrityFailure("GANTT", root([{ ...baseTask, start: "2026-02-30" }]), "metadata.gantt.tasks[0].start");
  expectIntegrityFailure("GANTT", root([{ ...baseTask, end: "2026-07-31" }]), "metadata.gantt.tasks[0].end");
  expectIntegrityFailure("GANTT", root([{ ...baseTask, progress: 25.5 }]), "metadata.gantt.tasks[0].progress");
  expectIntegrityFailure("GANTT", root([{ ...baseTask, status: "paused" }]), "metadata.gantt.tasks[0].status");
  expectIntegrityFailure("GANTT", root([baseTask, { ...baseTask }]), "metadata.gantt.tasks");
});

test("save routes preserve authoritative metadata instead of storing normalized projections", async () => {
  const blockRoute = (await readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const collaborationRoute = (await readFile(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

  for (const [label, source] of [["block", blockRoute], ["collaboration", collaborationRoute]]) {
    assert.doesNotMatch(source, /normalizeBookmarkMetadata\(metadata\)/, `${label} route still stores normalized bookmark metadata`);
    assert.doesNotMatch(source, /normalizeAiChatMetadata\(metadata\)/, `${label} route still stores normalized AI metadata`);
    assert.match(source, /summarizeBookmarkData\(getBookmarkData\(metadata\)\)/);
    assert.match(source, /summarizeAiChatData\(getAiChatData\(metadata\)\)/);
    assert.match(source, /assertLosslessStructuredMetadata/);
  }

  const createStart = blockRoute.indexOf('blockRouter.post("/pages/:pageId/blocks"');
  const createEnd = blockRoute.indexOf('blockRouter.patch("/blocks/:blockId"', createStart);
  const createRoute = blockRoute.slice(createStart, createEnd);
  assert.ok(
    createRoute.indexOf("assertLosslessStructuredMetadata(body.type, body.metadata)")
      < createRoute.indexOf("INSERT INTO blocks"),
    "direct-create integrity guard must run before the database insert"
  );
  assert.ok(
    blockRoute.includes('if (body.metadata !== undefined) {\n        fields.push("metadata = ?")'),
    "metadata must only be rewritten when the request supplied metadata"
  );
  assert.doesNotMatch(
    blockRoute,
    /body\.metadata !== undefined \|\| \(contentChanged && \(nextType === "BOOKMARK" \|\| nextType === "AI_CHAT"\)\)/,
    "metadata that was read as JSON text must not be serialized again during an unrelated content update"
  );

  const materializeStart = collaborationRoute.indexOf('"/pages/:pageId/collaboration/snapshot"');
  const materializeRoute = collaborationRoute.slice(materializeStart);
  assert.ok(
    materializeRoute.indexOf("assertLosslessStructuredMetadata(block.type, block.metadata)")
      < materializeRoute.indexOf("DELETE FROM blocks"),
    "collaboration integrity guard must run before destructive materialization"
  );
});
