import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  assertYjsDeleteSetBudget,
  maxYjsDeleteSetClients,
  maxYjsDeleteSetRanges
} from "../src/lib/yjs-delete-set-budget.ts";

function uint(value) {
  const result = [];
  do {
    const digit = value % 128;
    value = Math.floor(value / 128);
    result.push(digit | (value ? 128 : 0));
  } while (value);
  return result;
}
function check(bytes) {
  const cursor = { arr: Uint8Array.from(bytes), pos: 0 };
  const ranges = assertYjsDeleteSetBudget(cursor);
  assert.equal(cursor.pos, cursor.arr.length);
  return ranges;
}
function section(client, ranges, start = 0) {
  const data = [...uint(client), ...uint(ranges)];
  for (let i = 0; i < ranges; i += 1) data.push(...uint(start + 2 * i), 1);
  return data;
}

test("delete-set preflight accepts an empty delete set and ordinary ranges", () => {
  assert.equal(check([0]), 0);
  assert.equal(check([1, ...section(0, 3)]), 3);
  assert.equal(check([2, ...section(17, 2), ...section(99, 3, 100)]), 5);
});

test("delete-set preflight rejects an oversized declared count before requiring range bytes", () => {
  const cursor = { arr: Uint8Array.from([1, 1, ...uint(2_500_000)]), pos: 0 };
  assert.throws(() => assertYjsDeleteSetBudget(cursor), /range count exceeds/);
  assert.ok(cursor.pos <= cursor.arr.length);
  assert.throws(() => check(uint(maxYjsDeleteSetClients + 1)), /client count exceeds/);
});

test("delete-range budgets are aggregate across clients, not per client", () => {
  assert.equal(check([2, ...section(1, 60_000), ...section(2, 40_000)]), maxYjsDeleteSetRanges);
  assert.throws(() => check([2, ...section(1, 60_000), 2, ...uint(40_001)]), /range count exceeds/);
});

test("many empty client sections cannot bypass the client budget", () => {
  const bytes = [...uint(maxYjsDeleteSetClients)];
  for (let i = 0; i < maxYjsDeleteSetClients; i += 1) bytes.push(...uint(i), 0);
  assert.equal(check(bytes), 0);
});

test("delete-set integers, nonempty ranges, and exact consumption fail closed", () => {
  for (const bytes of [[], [128], [1], [1, 1], [1, 1, 1], [1, 1, 1, 0], [0, 0]]) {
    assert.throws(() => check(bytes), RangeError);
  }
  assert.throws(() => check([1, 1, 1, 0, 0]), /empty range/);
  assert.throws(() => check([1, 1, 1, ...uint(Number.MAX_SAFE_INTEGER), 1]), /range end/);
  assert.throws(() => check([1, ...uint(Number.MAX_SAFE_INTEGER + 1), 0]), /client id/);
  assert.throws(() => check(Array(9).fill(128)), /malformed integer/);
  assert.equal(check([1, ...uint(Number.MAX_SAFE_INTEGER), 1, ...uint(Number.MAX_SAFE_INTEGER - 1), 1]), 1);
});

test("delete-set preflight respects the cursor after real struct bytes", () => {
  const cursor = { arr: Uint8Array.of(7, 8, 9, 1, 42, 1, 10, 3), pos: 3 };
  assert.equal(assertYjsDeleteSetBudget(cursor), 1);
  assert.equal(cursor.pos, cursor.arr.length);
});

test("Yjs update, canonical state, incremental row, and pending-history paths use the guard", () => {
  const source = readFileSync(new URL("../src/lib/yjs-validation.ts", import.meta.url), "utf8");
  assert.match(source, /Y\.parseUpdateMetaV2\(update, PreflightDecoderV1\)/);
  assert.match(source, /assertYjsDeleteSetBudget\(decoderHolder\.value\.restDecoder\)/);
  assert.match(source, /assertUpdatePreflight\(update, maxStateBytes\);\s*Y\.applyUpdate\(document, update\)/);
  assert.match(source, /document\.store\.pendingDs !== null\) encodeBoundedState\(document, maxStateBytes\)/);
  assert.match(source, /assertUpdatePreflight\(stateUpdate, maxStateBytes\)/);
  assert.match(source, /assertUpdatePreflight\(incrementalUpdate, maxStateBytes\)/);
});
