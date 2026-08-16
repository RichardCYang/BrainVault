import assert from "node:assert/strict";
import test from "node:test";
import { assertMariaDbCrashDurabilityVariables } from "../src/lib/database-durability.ts";

const row = (Variable_name, Value) => ({ Variable_name, Value });

test("accepts fully durable traditional binary logging", () => {
  assert.doesNotThrow(() => assertMariaDbCrashDurabilityVariables([
    row("innodb_flush_log_at_trx_commit", "1"),
    row("log_bin", "ON"),
    row("sync_binlog", "1")
  ]));
});

test("rejects non-durable InnoDB commit flushing", () => {
  assert.throws(() => assertMariaDbCrashDurabilityVariables([
    row("innodb_flush_log_at_trx_commit", "2"),
    row("log_bin", "OFF"),
    row("sync_binlog", "0")
  ]), /innodb_flush_log_at_trx_commit=2/);
});

test("rejects traditional binary logging without sync_binlog=1", () => {
  assert.throws(() => assertMariaDbCrashDurabilityVariables([
    row("innodb_flush_log_at_trx_commit", "1"),
    row("log_bin", "ON"),
    row("sync_binlog", "0")
  ]), /sync_binlog=0/);
});

test("does not require sync_binlog for InnoDB-based binary logging", () => {
  assert.doesNotThrow(() => assertMariaDbCrashDurabilityVariables([
    row("innodb_flush_log_at_trx_commit", "1"),
    row("log_bin", "ON"),
    row("sync_binlog", "0"),
    row("binlog_storage_engine", "InnoDB")
  ]));
});
