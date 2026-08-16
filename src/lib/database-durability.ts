export type MariaDbVariableRow = {
  Variable_name: string;
  Value: string;
};

export function assertMariaDbCrashDurabilityVariables(rows: readonly MariaDbVariableRow[]) {
  const variables = new Map(
    rows.map((row) => [String(row.Variable_name).toLowerCase(), String(row.Value)])
  );

  const flushAtCommit = Number(variables.get("innodb_flush_log_at_trx_commit"));
  if (flushAtCommit !== 1) {
    throw new Error(
      "Unsafe MariaDB durability configuration: "
      + `innodb_flush_log_at_trx_commit=${variables.get("innodb_flush_log_at_trx_commit") ?? "missing"}; `
      + "BrainVault requires 1 so an acknowledged transaction is flushed at commit"
    );
  }

  const logBin = (variables.get("log_bin") ?? "OFF").toUpperCase();
  const binaryLoggingEnabled = logBin === "ON" || logBin === "1";
  const binlogStorageEngine = (variables.get("binlog_storage_engine") ?? "traditional").toLowerCase();
  if (binaryLoggingEnabled && binlogStorageEngine !== "innodb") {
    const syncBinlog = Number(variables.get("sync_binlog"));
    if (syncBinlog !== 1) {
      throw new Error(
        "Unsafe MariaDB binary-log durability configuration: "
        + `sync_binlog=${variables.get("sync_binlog") ?? "missing"}; `
        + "BrainVault requires 1 when traditional binary logging is enabled"
      );
    }
  }
}
