# Collaboration presence awareness CPU hardening

Date: 2026-09-14

## Scope

This pass re-audited BrainVault for avoidable CPU consumption after the existing formatter, network-timezone, Gantt, and long-running-server performance hardening. The audit covered recurring timers, animation-frame scheduling, collaboration awareness, repeated DOM scans, and server housekeeping loops.

No unconditional busy loop or continuously self-rescheduling `requestAnimationFrame` loop was found. Recurring server timers are bounded housekeeping/heartbeat work and are `unref()`'d; the database-facing heartbeat/prune paths include overlap guards where needed. The browser page-transition lease interval is cleared in `finally`.

One additional browser hot path was reproduced in real-time collaboration presence handling.

## Reproduced problem

`public/collaboration.js` coalesces local awareness transmission with an 80 ms delay. Incoming awareness changes ultimately call the `onPresence` callback in `public/app.js`.

Before this change, every presence emission called `renderCollaborationChrome()`, which called `renderCollaborationPresence()`. That function:

1. rebuilt the collaboration avatar strip;
2. queried every rendered `.editor-block-row`;
3. removed remote-editor classes, inline caret-color state, and labels from every row;
4. rebuilt the labels for the few blocks actually edited remotely;
5. then scheduled the remote caret render.

Selection, field, and control changes do not alter the avatar strip or block-level remote-editor labels. A collaborator moving a caret within the same block could therefore make CPU cost scale with the total rendered block count even though only the caret geometry changed.

## Change

`public/collaboration-caret.js` now exports `hasRemotePresenceDecorationChanges(previousClients, nextClients)`. It reports a decoration change only when data used by the avatar/block-label chrome changes:

- connection membership/order;
- user id, username, display name, or avatar data;
- active block id.

`public/app.js` now stores every presence update as before, but it rebuilds the full collaboration chrome only for those semantic decoration changes. Selection/control/field-only updates schedule only the remote caret render.

The collaboration protocol, awareness payload, authentication/authorization, persistence, recovery, database schema, dependencies, and runtime floor are unchanged.

## Reproduction benchmark

Run:

```bash
node scripts/reproduce-collaboration-presence-cpu.mjs
```

The benchmark models 4 remote editors across 4,000 rendered blocks and 2,400 awareness updates. Most updates move a selection/control within the same block; every 240 updates changes a remote editor's active block. It verifies after every update that the optimized cached decoration state exactly equals the direct decoration state and performs seven timed samples after warm-up.

Five independent process runs in this sandbox produced:

| Run | Legacy full-scan median | Optimized median | Isolated speedup |
| ---: | ---: | ---: | ---: |
| 1 | 200.24 ms | 1.02 ms | 195.8× |
| 2 | 201.14 ms | 1.31 ms | 153.3× |
| 3 | 189.93 ms | 1.02 ms | 185.4× |
| 4 | 189.22 ms | 1.04 ms | 182.9× |
| 5 | 186.11 ms | 1.07 ms | 173.5× |

Median of the five run medians: **189.93 ms legacy vs 1.03 ms optimized**, with a median isolated speedup of **182.9×**. The speedup range was **153.3×–195.8×**.

The deterministic work-count result is more important than wall-clock timing: the scenario requires 2,401 legacy full presence renders (initial + updates) but only 10 optimized full renders (initial + 9 semantic block changes), avoiding **2,391 / 2,401 = 99.5835%** of full block-list scans.

This is an isolated scaling benchmark of the collaboration presence-decoration path, not a claim that the complete application is 182.9× faster.

## Regression protection

Focused tests:

```bash
node --test tests/collaboration-caret.node.test.mjs tests/collaboration-presence-render.node.test.mjs
```

Result: **5/5 passed**.

Focused authentication/collaboration/passkey security regression set:

```bash
node --test tests/account-security-auth-boundary.node.test.mjs tests/collaboration-http-auth-boundary.node.test.mjs tests/passkey-direct-login-security.node.test.mjs
```

Result: **10/10 passed**.

The collaboration-focused tests verify that:

- selection/control/field-only awareness changes do not request a full decoration rebuild;
- connection, identity/avatar/name, and block changes still request one;
- `public/app.js` actually gates the full chrome render and retains the caret-only path.

All browser JavaScript/ESM files under `public`, `scripts`, and `tests` were syntax-checked with `node --check`: **405/405 passed**.

Full dependency-free Node test comparison with `.git` present in both copied trees:

- original archive: **911 tests, 855 passed, 56 failed**;
- modified tree: **914 tests, 858 passed, 56 failed**;
- the **56 failure descriptions are exactly identical** between original and modified;
- the three added regression tests account for the three additional passes.

Portable lockfile registry validation also passes in both trees: **352 resolved URLs use approved portable registry hosts**.

The project's broader data-loss/security verification command cannot complete in this sandbox because `node_modules` is absent and `tsx` is unavailable. It fails the same way before and after the patch. The modified code does not touch server, authentication, authorization, persistence, package, or lockfile files.

## Environment limitation

The sandbox has Node.js **v22.16.0**, while BrainVault declares `^22.23.2 || ^24.18.1 || >=26.5.1` with `engine-strict=true`, and the archive contains no `node_modules`. Network package installation is unavailable in this environment, so the runtime/dependency floor was not bypassed merely to force the TypeScript/Vitest suites to execute.

The installed Chromium binary also fails to terminate headlessly even for a blank `data:` page in this container, so no browser trace result is claimed. The included benchmark, source-path tests, syntax checks, and original-versus-modified Node test comparison are the reproducible evidence used for this patch.

## `.git` preservation

The project `.git` tree is copied with filesystem metadata preservation and is not edited by the patch. Final packaging verification compares a manifest of every `.git` path, type, mode, size, timestamp, symlink target (where applicable), and file SHA-256 against the freshly extracted original archive.
