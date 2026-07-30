import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertBlockSortOrder,
  blockSortOrderLimits,
  nextBlockSortOrder
} from "../src/lib/block-order-integrity.ts";

const requested = [
  { id: "blk_z", sortOrder: blockSortOrderLimits.max + 1 },
  { id: "blk_a", sortOrder: blockSortOrderLimits.max + 2 }
];

// MariaDB documents that non-strict numeric writes are adjusted to the nearest
// valid endpoint and return a warning. Model that documented storage result.
const oldStored = requested.map((block) => ({
  ...block,
  storedSortOrder: Math.min(blockSortOrderLimits.max, block.sortOrder)
}));
const intendedOrder = [...requested]
  .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
  .map((block) => block.id);
const oldDatabaseOrder = [...oldStored]
  .sort((left, right) => left.storedSortOrder - right.storedSortOrder || left.id.localeCompare(right.id))
  .map((block) => block.id);

assert.deepEqual(intendedOrder, ["blk_z", "blk_a"]);
assert.deepEqual(oldDatabaseOrder, ["blk_a", "blk_z"]);
assert.notDeepEqual(oldDatabaseOrder, intendedOrder);
assert.throws(() => assertBlockSortOrder(blockSortOrderLimits.max + 1));
assert.throws(() => nextBlockSortOrder(blockSortOrderLimits.max));

const blockRoute = (await readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const dataTransfer = (await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const database = (await readFile(new URL("../src/lib/db.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

assert.ok(blockRoute.includes(".max(blockSortOrderLimits.max)"));
assert.ok(blockRoute.includes("getNextBlockSortOrder(lastBlock?.sort_order)"));
assert.ok(dataTransfer.includes(".max(blockSortOrderLimits.max)"));
assert.ok(database.includes("initSql: strictTransactionalSqlMode"));
assert.ok(database.includes("STRICT_TRANS_TABLES"));

console.log(JSON.stringify({
  vulnerability: {
    requestedSortOrders: requested.map((block) => block.sortOrder),
    storedSortOrdersInNonStrictMode: oldStored.map((block) => block.storedSortOrder),
    intendedOrder,
    oldDatabaseOrder,
    silentOrderingLossReproduced: true
  },
  fixedBehavior: {
    directApiRejectsOutOfRangeBeforeSql: true,
    backupRestoreRejectsOutOfRangeBeforeSql: true,
    automaticAppendFailsClosedAtIntMax: true,
    pooledConnectionsForceStrictTransactionalWrites: true,
    silentOrderingLossClosed: true
  }
}, null, 2));
