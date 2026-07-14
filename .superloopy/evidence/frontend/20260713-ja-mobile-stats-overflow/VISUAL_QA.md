# Visual QA: Japanese Overall Stats Overflow

## Design Read

Reading this as a dense game calculator statistics surface for repeat users, using the existing restrained operations-console language. Design variance 3/10, motion intensity 3/10, visual density 8/10.

## Root Cause

Japanese aggregate strings contain no spaces. The nested CSS Grid tracks preserved a roughly 402px intrinsic minimum width while the mobile stats section shrank to 255-325px. This caused the section title, aggregate metadata, metric cards, and help text to paint beyond the right edge.

## Implementation

- Constrained the stats section and nested overall-stat grids with `minmax(0, 1fr)` tracks.
- Added `min-width: 0` to shrinkable text and grid boundaries.
- Allowed emergency wrapping for aggregate metadata and help text without reducing type size or hiding content.
- Added a Playwright assertion that checks every descendant of the overall stats section against its actual section bounds.

## Browser Evidence

- `390-ja-stats.png`: mobile Japanese stats, no clipped or overflowing content.
- `768-ja-stats.png`: tablet Japanese stats, compact single-column layout preserved.
- `1280-ja-stats.png`: desktop Japanese stats, existing two-column layout preserved.

## Verification

- TypeScript typecheck: pass.
- Biome, architecture lint, and Knip: pass.
- Vitest: 155/155 pass.
- Japanese and English responsive overflow E2E at 320, 390, 768, and 1365px: pass.
- Existing Playwright visual snapshots: 8/8 pass without updates.
- Production build: pass.
- Superloopy design-system compliance: pass with no violations.
- The initial repo-wide React Doctor audit found 7 render-time ref mutation errors. The follow-up runtime hardening pass removed all 7 errors and raised the score from 71/100 to 82/100.

## Anti-Slop Pre-flight

- No visible copy changed.
- No new colors, shadows, gradients, typography, radii, or decorative elements.
- Existing color, shape, and theme locks remain intact.
- Interactive, loading, and error states are unchanged.
- No horizontal overflow at the tested mobile, tablet, and desktop widths.
- No UX was removed or weakened to satisfy the check.
