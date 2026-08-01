# Structured block save queue recovery

## Symptom

After a table, database, Gantt, or another metadata-backed block produced
`BLOCK_METADATA_WOULD_TRUNCATE`, every later save continued to fail with the same message.
Reloading the application (often as a side effect of restarting the development server) made saving work again.

## Root cause

The server correctly returns a definitive 4xx response before writing when structured metadata would not round-trip losslessly. The browser's latest-write queue did not distinguish that response from an ambiguous transport or 5xx failure.

Every writer error was copied into `retryTask`. Because retry tasks have priority over newer coalesced edits, the rejected payload was replayed forever:

1. an older structured snapshot is sent;
2. the server rejects it with `400 BLOCK_METADATA_WOULD_TRUNCATE`;
3. the queue retains that exact snapshot as `retryTask`;
4. every flush or newer save retries the rejected snapshot first;
5. the newer canonical payload never reaches the server.

The queue is in browser memory, so a reload clears the poisoned retry slot. This explains why a server restart appeared to repair storage even though no database capacity changed.

The default table, database, and Gantt payloads are within the server's structured metadata limits. The persistent failure was queue state, not cumulative page storage.

## Fix

`createLatestWriteQueue` now accepts two policies:

- `shouldRetry(error, task)` retains only failures whose commit outcome is ambiguous;
- `canSupersede(error, task, pendingTask)` allows a newer queued snapshot to replace a definitively rejected stale snapshot.

Block and page-title queues retain network/5xx failures only. For
`BLOCK_METADATA_WOULD_TRUNCATE`, a newer canonical block payload is allowed to continue in the same drain. A lone invalid payload still reports its validation error and remains in the durable local draft, but it no longer occupies the retry slot or blocks unrelated work.

## Regression coverage

- definitive 400 failures leave the queue idle and permit the next save;
- a newer canonical structured payload supersedes an older rejected snapshot;
- ambiguous failures still retry in order before newer edits;
- authentication-boundary discard behavior remains unchanged.
