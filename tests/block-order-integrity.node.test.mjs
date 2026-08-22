import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertBlockSortOrder,
  BlockSortOrderIntegrityError,
  blockSortOrderLimits,
  nextBlockSortOrder
} from "../src/lib/block-order-integrity.ts";

test("block sort-order boundaries match MariaDB signed INT storage", () => {
  assert.equal(assertBlockSortOrder(0), 0);
  assert.equal(assertBlockSortOrder(blockSortOrderLimits.max), 2_147_483_647);
  for (const value of [-1, 1.5, blockSortOrderLimits.max + 1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => assertBlockSortOrder(value),
      (error) => error instanceof BlockSortOrderIntegrityError
        && error.code === "BLOCK_SORT_ORDER_INVALID"
    );
  }
});

test("automatic append fails closed instead of overflowing INT", () => {
  assert.equal(nextBlockSortOrder(null), 0);
  assert.equal(nextBlockSortOrder(41), 42);
  assert.throws(
    () => nextBlockSortOrder(blockSortOrderLimits.max),
    (error) => error instanceof BlockSortOrderIntegrityError
      && error.code === "BLOCK_SORT_ORDER_EXHAUSTED"
  );
});

test("non-strict endpoint coercion can erase intended block order", () => {
  const requested = [
    { id: "blk_z", sortOrder: blockSortOrderLimits.max + 1 },
    { id: "blk_a", sortOrder: blockSortOrderLimits.max + 2 }
  ];
  const stored = requested.map((block) => ({
    ...block,
    sortOrder: Math.min(blockSortOrderLimits.max, block.sortOrder)
  }));
  const intended = [...requested]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    .map((block) => block.id);
  const observed = [...stored]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    .map((block) => block.id);
  assert.deepEqual(intended, ["blk_z", "blk_a"]);
  assert.deepEqual(observed, ["blk_a", "blk_z"]);
});

test("every block-order write surface shares the bounded contract", async () => {
  const blockRoute = (await readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const dataTransfer = (await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const database = (await readFile(new URL("../src/lib/db.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  assert.match(blockRoute, /const blockSortOrderSchema = z\.number\(\)\.int\(\)[\s\S]*?\.max\(blockSortOrderLimits\.max\)/);
  assert.equal((blockRoute.match(/sortOrder: blockSortOrderSchema/g) ?? []).length, 3);
  assert.match(blockRoute, /sortOrder: z\.preprocess\([\s\S]*?blockSortOrderSchema\.optional\(\)/);
  assert.equal((blockRoute.match(/getNextBlockSortOrder\(lastBlock\?\.sort_order\)/g) ?? []).length, 1);
  assert.equal((blockRoute.match(/const createSortOrder = await getCollisionFreeBlockCreateSortOrder\(/g) ?? []).length, 2);
  assert.match(dataTransfer, /sort_order: z\.number\(\)\.int\(\)[\s\S]*?\.max\(blockSortOrderLimits\.max\)/);
  assert.match(database, /initSql: strictTransactionalSqlMode/);
  assert.match(database, /STRICT_TRANS_TABLES/);
});
