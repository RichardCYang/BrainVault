import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("backup database timestamps are syntactically and calendar validated before restore", () => {
  assert.match(source, /databaseTimestampPattern = \/\^\(\\d\{4\}\).*\\d\{1,6\}/);
  assert.match(source, /function isValidMachineTimestamp/);
  assert.match(source, /year < 1000 \|\| year > 9999/);
  assert.match(source, /month < 1 \|\| month > 12/);
  assert.match(source, /second < 0 \|\| second > 59/);
  assert.match(source, /year % 400 === 0/);
  assert.match(source, /day >= 1 && day <= daysInMonth\[month - 1\]/);
  assert.match(source, /timestampSchema = z\.string\(\)\.min\(1\)\.max\(40\)[\s\S]*isValidMachineTimestamp\(value, databaseTimestampPattern\)/);
});

test("backup export metadata keeps its ISO-Z format separate from SQL DATETIME fields", () => {
  assert.match(source, /exportedAtTimestampPattern =/);
  assert.match(source, /exportedAt:\s*exportedAtTimestampSchema/);
});
