# Visual QA: React Runtime Hardening

## Design Read

Reading this as a dense game calculator for repeat decisions. The existing restrained operations-console design is preserved. Design variance 3/10, motion intensity 3/10, visual density 8/10.

## Implementation

- Replaced render-time callback ref writes with React 19 Effect Events for document listeners.
- Moved asynchronous stats queue callback ref updates to the commit phase.
- Replaced the stats queue render-time ref initialization with lazy state initialization.
- Removed the `queryEnabled` render-time ref and made the callback dependency explicit.
- Removed deprecated panel-level `aria-disabled`; stale result content is now `inert` while its live status remains exposed.
- Cached locale-aware number formatters without changing output.
- Removed two confirmed unused exports.

## Browser Evidence

- `390-default.png`: mobile input layout remains unchanged.
- `768-default.png`: tablet input and empty-result layout remain unchanged.
- `1280-default.png`: desktop input and empty-result layout remain unchanged.
- Existing visual snapshots passed 8/8 without updates.

## Verification

- TypeScript typecheck: pass.
- Biome, architecture lint, and Knip: pass.
- Vitest: 158/158 pass across 26 files.
- Chromium E2E: 66/66 pass, including WCAG checks and visual snapshots.
- WebKit compatibility: 14/14 pass.
- Cloudflare Worker tests: 45/45 pass.
- Production build and bundle budgets: pass.
- Superloopy design-system compliance: pass with no violations.
- React Doctor: 82/100, zero errors, zero accessibility warnings, 27 reviewed warnings.

## Remaining React Doctor Warnings

- Sequential D1 schema setup is intentionally ordered and must not use `Promise.all`.
- The DetailPanel position callback is stable through `useCallback([])`; no repeated subscription occurs.
- Research files and one scenario export are reached through intentional dynamic imports.
- Stock text mirrors committed parent stock and must not remount via a prop-derived `key`.
- The cached `Intl.NumberFormat` warning points at the cache-miss constructor, not per-call reconstruction.
- Theme and locale `flushSync` calls preserve the existing transition and font-swap contracts.
- Cohesive stats section components remain together under the project's anti-fragmentation rule.
- Component-file utility exports affect development Fast Refresh only and are not product correctness failures.
- The benchmark JSON clone has no product runtime impact.

## Anti-Slop Pre-flight

- No visible copy or visual style changed.
- Existing color, shape, theme, and typography locks remain intact.
- Interactive, loading, stale, and error states remain available.
- No horizontal overflow or visual snapshot drift was introduced.
- No UX was removed or weakened to satisfy static analysis.
