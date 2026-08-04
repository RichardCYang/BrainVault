# Browser collaboration-module cache coherence audit

Date: 2026-08-04  
Scope: same-origin Yjs, lib0, and isomorphic.js browser module delivery

## Finding

The collaboration runtime was served from stable URLs such as `/vendor/yjs/yjs.mjs` with `Cache-Control: public, max-age=31536000, immutable`. The URL did not include a package version, content hash, or deployment identifier. A browser that loaded one deployment could therefore consider that module fresh for one year and skip validation after a later deployment.

This could produce a mixed deployment in which the newly revalidated application client loads a cached older collaboration dependency graph. The project already uses collaboration protocol and document-generation fences, but those guards do not make an old dependency implementation identical to the lockfile-selected implementation expected by the new client.

## Reproduction

```bash
npm run reproduce:browser-module-cache-staleness
```

The dependency-free reproducer models a deployment one day after the first module response. Under the former policy the old response remains fresh and immutable. Under the corrected policy it must be revalidated before reuse.

## Correction

The stable browser-module routes now return:

```http
Cache-Control: public, max-age=0, must-revalidate
```

The custom header is protected from Express-generated cache policy by disabling automatic `Cache-Control` generation on both `res.sendFile()` and the `express.static()` lib0 route. ETags and last-modified validators remain available, so unchanged modules can still receive efficient conditional responses while changed modules are delivered immediately.

Long-lived immutable caching can be restored later only if every collaboration-module URL carries a deployment-stable version or content fingerprint, including the complete transitive import-map graph.

## Regression coverage

`tests/browser-module-cache-policy.node.test.mjs` verifies that:

- the former one-year immutable policy reproduces stale reuse;
- the current policy is immediately stale and requires revalidation;
- the stable routes do not advertise `immutable`;
- Express does not overwrite the explicit cache policy.
