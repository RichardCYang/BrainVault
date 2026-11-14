/**
 * Upper bound on automatic snapshots kept for being recent. It stops a burst
 * of restores from filling the disk, while still covering a person who tries
 * many backups in a row looking for the right one.
 */
export const automaticSnapshotRecentHardMaxCount = 20;

export type AutomaticSnapshotRetentionRow = {
  id: string;
  /** 1/true when the snapshot is younger than SNAPSHOT_AUTO_RETENTION_HOURS. */
  recent: number | boolean | string | null;
};

/**
 * Chooses which automatic ("Before restore") snapshots to remove. Rows must be
 * ordered newest first.
 *
 * The newest `maxCount` are always kept, and so is every recent snapshot, up
 * to `recentHardMaxCount` in all. Without the age rule, trying a few backups in
 * a row would prune the one copy of the workspace as it was before the first
 * attempt. `keepIds` (the safety copy just taken, the snapshot that was
 * restored) are never removed and count toward both limits first.
 */
export function selectAutomaticSnapshotsToPrune(
  rows: readonly AutomaticSnapshotRetentionRow[],
  keepIds: Iterable<string>,
  { maxCount, recentHardMaxCount = automaticSnapshotRecentHardMaxCount }: {
    maxCount: number;
    recentHardMaxCount?: number;
  }
) {
  const keep = new Set(keepIds);
  const recentCeiling = Math.max(maxCount, recentHardMaxCount);
  let kept = rows.filter((row) => keep.has(row.id)).length;
  const prune: string[] = [];
  for (const row of rows) {
    if (keep.has(row.id)) continue;
    const recent = row.recent === true || Number(row.recent) === 1;
    if (kept < maxCount || (recent && kept < recentCeiling)) {
      kept += 1;
      continue;
    }
    prune.push(row.id);
  }
  return prune;
}
