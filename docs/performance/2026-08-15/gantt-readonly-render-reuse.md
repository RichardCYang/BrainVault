# Gantt read-only render reuse

Date: 2026-08-15

## Optimization target

Server-side read-only Gantt rendering creates the day and month headers used by Markdown/read-only/PDF output. The locale, time zone, and formatting options are fixed, but the renderer previously constructed a new `Intl.DateTimeFormat` for every visible day and every month boundary. A quarter view can contain 98 visible days. The renderer also rebuilt the identical weekend-cell overlay and today-line markup inside every task-row iteration, up to the existing 200-task limit.

## Change

- Reuse three module-scoped `Intl.DateTimeFormat` instances for compact day labels, full weekday/day labels, and month/year labels. Their locale (`en`), time zone (`UTC`), and options are unchanged.
- Compute task-invariant weekend overlay markup and the today-line markup once per Gantt render, then reuse those immutable strings for each task row.

No API contract, Gantt metadata, date parsing, task normalization, HTML escaping, database query, persistence path, collaboration state, authentication/authorization behavior, dependency, runtime requirement, or `.git` content is changed.

## Reproducible regression protection

`tests/gantt-render-optimization.node.test.mjs` uses only Node built-ins and verifies that:

- repeated quarter-view renders are byte-for-byte identical;
- only the three fixed `Intl.DateTimeFormat` instances are constructed across repeated renders;
- sanitized rendering remains enforced for hostile fixture text;
- weekend overlay multiplicity in final HTML is unchanged even though its source markup is computed outside the task loop;
- source placement keeps the task-invariant weekend/today decorations outside the task mapping loop.

The optimization was additionally checked by hashing the exact rendered HTML from the same deterministic 40-task quarter fixture before and after the change.

## Measured result

A five-run microbenchmark rendered the same deterministic 40-task quarter-view fixture 300 times in a fresh Node process per run after a 20-render warm-up. The final HTML stayed exactly identical at 104,106 bytes with SHA-256 `0fc36ec11b997f142a728481b4a7f320fcb2de1f04acd8c09591e53170de7a52` before and after the change.

- original median: **1,542.73 ms**
- optimized median: **111.93 ms**
- median speedup: **13.78×**
- elapsed-time reduction: **92.74%**

This benchmark isolates server-side Gantt HTML generation and is not a claim that the whole application becomes 13.78× faster.

## Regression evidence in this sandbox

The provided sandbox runtime is Node.js 22.16.0, below BrainVault's declared runtime/security floor (`^22.23.2 || ^24.18.1 || >=26.5.1`). The project requirement was not changed. The official Node.js 24.18.1 release and checksum were verified online, but the sandbox could not download the executable archive and could not complete `npm ci`, so dependency-backed Vitest/full-project build checks could not be executed here.

Under the same sandbox runtime for original and optimized trees:

- original built-in Node suite: **309 tests, 304 passed, 5 failed**;
- optimized tree running only the original suite: **309 tests, 304 passed, 5 failed**;
- the same five pre-existing failure names remained, with **no new failure**;
- optimized tree including the two new Gantt optimization regressions: **311 tests, 306 passed, 5 failed**;
- lockfile portable-registry verification passed in both trees;
- data-loss, collaboration, and security-hardening verification scripts produced the same pre-existing failure conditions in both trees (after normalizing process IDs and tree paths);
- focused TypeScript strict compilation of `src/lib/gantt.ts` passed with TypeScript 5.8.3;
- the final modified `.git` tree matches the clean uploaded archive byte-for-byte and mode-for-mode.
