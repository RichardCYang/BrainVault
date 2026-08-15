# Emoji picker search-data lazy loading

Date: 2026-08-15

## Optimization target

The main workspace statically imported `public/emoji-data.js`, a generated Unicode Emoji 17 dataset containing 3,944 records with Korean/English labels and search keywords. That made the full localized search payload and its derived search indexes part of the initial browser module graph even when the emoji/icon picker was never opened.

## Change

- `public/emoji-values.js` keeps only the authoritative emoji values needed by normal workspace icon validation/rendering.
- `public/emoji-data-loader.js` loads the larger localized search dataset with dynamic `import()` only when the picker is opened for the first time.
- The loader memoizes the in-flight/completed load and rebuilds the same search index and lookup maps that were previously created at startup.
- Picker opening has a generation fence. Closing or replacing the picker invalidates an in-flight load so late completion cannot reopen or render into stale picker intent.
- A failed dynamic import closes the picker and reports the error instead of leaving controls in a permanently busy state.

No API, database schema, persistence format, collaboration state, authentication, authorization, security headers, upload handling, backup/restore path, or `.git` content is changed.

## Reproducible checks

`tests/emoji-data-lazy-load.node.test.mjs` verifies that:

- the compact value list exactly matches all 3,944 authoritative emoji values;
- lazy-loaded records, category definitions, search text, and lookup indexes preserve the original semantics;
- `public/app.js` no longer statically imports the large searchable dataset;
- picker-close/replacement generation fencing remains wired around async completion.

The existing icon-picker operation-scope and accordion regression tests remain part of the focused regression set.

## Measured result

Using the same recursive static-import graph calculation from `public/app.js`:

- before: 34 static modules, 2,055,562 bytes;
- after: 35 static modules, 1,337,331 bytes;
- initial static JavaScript reduction: 718,231 bytes (34.94%).

The extra static module is the compact `emoji-values.js` path; the 774,867-byte localized `emoji-data.js` payload is no longer in the initial graph and is fetched only on first picker use.

## Regression evidence in the provided sandbox

The sandbox runtime is Node.js 22.16.0, below BrainVault's declared security floor (`^22.23.2 || ^24.18.1 || >=26.5.1`). The project's `engine-strict=true` correctly refused `npm ci`, and the sandbox could not download a supported Node binary or missing npm packages. The runtime floor was not weakened or bypassed in project files.

Tests that do not require installing dependencies were compared under the same sandbox runtime:

- focused optimized path: 11/11 passed (3 new lazy-load integrity tests plus 8 existing icon-picker/accordion regression tests);
- all `tests/*.node.test.mjs`, original: 299 tests, 294 passed, 5 failed;
- all `tests/*.node.test.mjs`, optimized: 302 tests, 297 passed, 5 failed;
- the same five pre-existing failures remained in both runs; no new failure name appeared;
- lockfile portable-registry verification passed;
- icon-picker stale-operation reproduction continued to reject cross-page writes, superseded reads, and stale close completion.

Because dependencies could not be installed in this sandbox, TypeScript compilation, Vitest-based tests, and the aggregate `npm run check` command could not be executed here. This limitation is environmental; no dependency, engine, security, or install policy was changed to force them to run.
