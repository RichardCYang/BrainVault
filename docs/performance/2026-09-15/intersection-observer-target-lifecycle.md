# Lazy-hydration IntersectionObserver target lifecycle hardening

Date: 2026-09-15

## Scope

A follow-up CPU/memory audit reviewed long-lived browser observers after the earlier timer, formatter, collaboration-presence, and server-latency hardening.

The W3C Intersection Observer processing model keeps an observed target registered until `unobserve(target)` or `disconnect()` is called. BrainVault reused several lazy-hydration observers but did not always clear registrations from the previous render before registering the next render's offscreen targets.

## Reproduced retention path

Two paths are directly modeled by `scripts/reproduce-intersection-observer-retention.mjs`:

- Mermaid uses one page-global observer. Offscreen diagrams from a page that was replaced could remain registered.
- Database URL previews reuse an observer keyed by the long-lived page-view root. Replacing the page contents therefore did not replace the observer; offscreen preview nodes from prior renders could remain registered.

A third equivalent lifecycle path existed for rendered AI citation links when an AI block/preview root was rerendered in place.

The pre-change deterministic model used 40 renders with 500 offscreen targets each. Both the Mermaid and database observers accumulated **20,000 registered targets** while only **500** belonged to the current render. An empty database render still left all 20,000 registrations in the model.

This is a retained-target/reference-count reproduction, not a claim that every browser assigns a fixed number of bytes per target.

## Change

- `hydrateMermaidPreviews()` disconnects prior registrations before discovering and observing the current render. This also releases registrations on an empty/eager render.
- `hydrateDatabaseUrlPreviews()` disconnects the prior root observer before the empty-render early return, then observes only current pending previews.
- `hydrateRenderedAiChatLinks()` does the same before citation relocation/preparation, so rerendered AI blocks cannot accumulate detached citation targets.

The observers themselves are still reused where appropriate. Lazy loading behavior, root margins, fetch behavior, URL validation, Mermaid sandboxing, and render output are unchanged.

## Reproduction after the change

Run:

```bash
node scripts/reproduce-intersection-observer-retention.mjs
```

Expected deterministic result for 40 × 500 targets:

- legacy accumulation model: 20,000 registered targets;
- current Mermaid observer: 500 current targets, 19,500 stale registrations avoided;
- current database URL-preview observer: 500 current targets, 19,500 stale registrations avoided;
- after an empty database render: 0 registered targets.

## Regression protection

`tests/intersection-observer-resource-lifecycle.node.test.mjs` verifies behavioral target bounds for Mermaid and database URL previews and pins the AI citation cleanup ordering. Existing Mermaid, database, AI-chat, data-loss, collaboration, authentication, and security tests remain part of the full regression comparison.

## Security and behavior invariants

No server code, authentication/authorization logic, persistence format, collaboration protocol, CSP, Mermaid sandbox attributes, dependency versions, or database schema is changed. `disconnect()` only stops visibility observation of stale/current targets immediately before the same current pending targets are registered again.

References:

- W3C Intersection Observer, lifetime and disconnect semantics: https://www.w3.org/TR/intersection-observer/#intersection-observer-lifetime
- MDN `IntersectionObserver.unobserve()`: https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver/unobserve
