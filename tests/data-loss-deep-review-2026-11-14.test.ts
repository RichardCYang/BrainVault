import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fitPageVersionsToBackupBudget } from "../src/lib/data-transfer.js";
import {
  mergeCoalescedBlockUpdate,
  pageVersionCoalesceMaxRemovedCharacters,
  pageVersionMaxBytesPerPage,
  pageVersionMaxDeletionBytesPerPage,
  prunePageVersionHistory
} from "../src/lib/page-version-history.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

function markdownUpdate(before: string, after: string) {
  return [{
    kind: "block-updated" as const,
    blockId: "blk_note",
    blockType: "MARKDOWN" as const,
    fields: [{ field: "markdown", before, after }]
  }];
}

describe("version history keeps deleted blocks and grouped text", () => {
  it("prunes deletion entries and other entries against separate byte budgets", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      execute: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { affectedRows: 0 }; },
      queryOne: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return sql.includes("total_bytes") ? { cutoff_revision: 40 } : undefined;
      }
    };
    await prunePageVersionHistory(client as never, "pag_note", 100);
    const scans = calls.filter((call) => call.sql.includes("total_bytes"));
    expect(scans).toHaveLength(2);
    // Busy editing can no longer push out the only copy of a deleted block:
    // deletion entries are measured only against their own share.
    expect(scans[0].sql).toMatch(/AND COALESCE\(CAST\(JSON_VALUE\(change_summary, '\$\.blocksDeleted'\) AS UNSIGNED\), 0\) > 0/);
    expect(scans[0].params).toEqual(["pag_note", pageVersionMaxDeletionBytesPerPage]);
    expect(scans[1].sql).toMatch(/AND NOT \(COALESCE/);
    expect(scans[1].params).toEqual(["pag_note", pageVersionMaxBytesPerPage - pageVersionMaxDeletionBytesPerPage]);
    const deletes = calls.filter((call) => call.sql.startsWith("DELETE FROM page_versions WHERE page_id = ? AND revision <= ? AND"));
    expect(deletes.map((call) => /AND NOT \(/.test(call.sql))).toEqual([false, true]);
  });

  it("stops grouping once the saves in one entry removed too much text in total", () => {
    const chunk = "x".repeat(40);
    // Text typed and then deleted 40 characters at a time inside one group was
    // in neither the oldest "before" nor the newest "after".
    const first = mergeCoalescedBlockUpdate(
      markdownUpdate("", `${chunk}${chunk}`),
      markdownUpdate(`${chunk}${chunk}`, chunk)
    );
    expect(first).not.toBeNull();
    expect(first![0].kind === "block-updated" && first![0].fields[0].removedInGroup).toBe(40);
    const second = mergeCoalescedBlockUpdate(first!, markdownUpdate(chunk, ""));
    expect(second).toBeNull();
    expect(40 + 40).toBeGreaterThan(pageVersionCoalesceMaxRemovedCharacters);
    // Plain typing still groups.
    expect(mergeCoalescedBlockUpdate(markdownUpdate("", "a"), markdownUpdate("a", "ab"))).not.toBeNull();
  });
});

describe("a large workspace can still be backed up", () => {
  const entry = (revision: number, createdAt: string, deleted = 0, size = 10) => ({
    page_id: "pag_note",
    revision,
    page_edit_version: 1,
    page_content_version: 1,
    actors: "[]",
    source: "BLOCK_UPDATE",
    change_count: 1,
    change_summary: JSON.stringify({ blocksDeleted: deleted }),
    changes: "x".repeat(size),
    created_at: createdAt
  });

  it("leaves out the oldest ordinary history first, deleted-block entries last", () => {
    const versions = [
      entry(1, "2026-01-01 00:00:00.000000", 1),
      entry(2, "2026-01-02 00:00:00.000000"),
      entry(3, "2026-01-03 00:00:00.000000"),
      entry(4, "2026-01-04 00:00:00.000000")
    ];
    const { kept, omitted } = fitPageVersionsToBackupBudget(versions, { maxCount: 2, maxBytes: null });
    expect(omitted).toBe(2);
    expect(kept.map((version) => version.revision)).toEqual([1, 4]);
  });

  it("fits history into a byte budget and keeps it untouched when it fits", () => {
    const versions = [entry(1, "2026-01-01 00:00:00.000000", 0, 1000), entry(2, "2026-01-02 00:00:00.000000", 0, 10)];
    const oneSize = Buffer.byteLength(JSON.stringify(versions[1]), "utf8") + 1;
    expect(fitPageVersionsToBackupBudget(versions, { maxCount: 10, maxBytes: oneSize }).kept.map((v) => v.revision)).toEqual([2]);
    const unchanged = fitPageVersionsToBackupBudget(versions, { maxCount: 10, maxBytes: null });
    expect(unchanged).toEqual({ kept: versions, omitted: 0 });
  });

  it("no longer exports rendered HTML a restore never reads, and reports omitted history", () => {
    const transfer = read("src/lib/data-transfer.ts");
    expect(transfer).toMatch(/b\.markdown, NULL AS html_cache, b\.checked/);
    expect(transfer).toMatch(/const htmlCache = renderBlockHtml\(block\.type, block\.markdown/);
    expect(transfer).not.toMatch(/assertExportCount\("page version history entries"/);
    const routes = read("src/routes/data.routes.ts");
    expect(routes).toMatch(/X-Backup-History-Entries-Omitted/);
  });
});

describe("deleting many pages at once can be undone", () => {
  const routes = read("src/routes/page.routes.ts");
  const deleteRoute = routes.slice(routes.indexOf('pageRouter.delete(\n  "/:pageId"'));

  it("saves a snapshot before a collection or nested pages are permanently deleted", () => {
    const snapshot = deleteRoute.indexOf("createPreDeleteSafetySnapshot(user.id, authScope)");
    const transactionStart = deleteRoute.indexOf("const deletion = await transaction(");
    expect(snapshot).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(transactionStart);
    expect(deleteRoute).toMatch(/pageOwnerHint\?\.owner_id === user\.id/);
    expect(deleteRoute).toMatch(/req\.header\(deleteSafetySnapshotSkipHeader\) !== "1"/);
    const helper = routes.slice(routes.indexOf("async function needsPreDeleteSafetySnapshot("));
    expect(helper).toMatch(/FROM page_delete_mutations WHERE actor_id = \? AND mutation_id = \?/);
    expect(helper).toMatch(/Boolean\(target\.is_collection\) \|\| getPageSubtreeRows\(pageId, rows\)\.length > 1/);
  });

  it("prunes pre-delete snapshots like pre-restore ones", () => {
    expect(read("migrations/087_workspace_snapshot_pre_delete_kind.sql"))
      .toMatch(/ENUM\('MANUAL', 'PRE_RESTORE', 'PRE_DELETE'\)/);
    expect(read("src/lib/workspace-snapshots.ts")).toMatch(/kind IN \('PRE_RESTORE', 'PRE_DELETE'\)/);
  });

  it("asks before deleting without the safety copy", () => {
    const app = read("public/app.js");
    expect(app).toMatch(/error\?\.code === "DELETE_SAFETY_SNAPSHOT_FAILED" && !task\.skipSafetySnapshot/);
    expect(app).toMatch(/task\.skipSafetySnapshot \? \{ "X-Delete-Skip-Safety-Snapshot": "1" \}/);
  });
});

describe("a deleted comment can be brought back", () => {
  const routes = read("src/routes/collaboration.routes.ts");

  it("keeps a copy before deleting and restores it with its author and time", () => {
    const deleteRoute = routes.slice(routes.indexOf('collaborationRouter.delete(\n  "/pages/:pageId/comments/:commentId"'));
    const copy = deleteRoute.indexOf("INSERT INTO page_comment_deletions");
    const removal = deleteRoute.indexOf("DELETE FROM page_comments WHERE page_id = ? AND id = ? AND edit_version = ?");
    expect(copy).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(removal);
    const restoreRoute = routes.slice(routes.indexOf('"/pages/:pageId/comments/:commentId/restore"'));
    expect(restoreRoute).toMatch(/INSERT INTO page_comments \(id, page_id, user_id, body, edit_version, created_at, updated_at\)/);
    expect(restoreRoute).toMatch(/deleted\.deleted_by !== user\.id && !isAdministrator/);
    expect(restoreRoute).toMatch(/Number\(deleted\.edit_version\) \+ 1/);
  });
});
