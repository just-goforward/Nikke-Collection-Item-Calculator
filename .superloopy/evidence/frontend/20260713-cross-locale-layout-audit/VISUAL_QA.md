# Cross-locale layout audit

Date: 2026-07-13

## Scope

- Locales: Korean, Japanese, English
- Viewports: 320, 390, 430, 660, 661, 684, 768, 980, 981, 1003, 1100, 1200, 1365 px
- Surfaces: initial input, result, outcome selection, detail metrics, candidate table, validation chart, stats, top bar, tablet input split, mobile chrome, success-attempt modal
- Scenarios: R14 with stock 100/20/20, SR10 validation with yellow stock 100, demo stats

## Confirmed shared-geometry pressure

1. The desktop/tablet outcome panel switches to one column at a 720 px container width for every locale. Korean and Japanese still fit a compact two-column layout at narrow desktop widths where English requires more wrapping. The same cutoff is also generally conservative on the full-width tablet result panel.
2. Candidate action names use shared 720 px and 500 px variant breakpoints. Full or panel labels fit at several widths where every locale is already forced to a shorter variant. Korean is affected most around 390 px and 981-1003 px.
3. Mobile detail metric labels reserve 2.5 em for every locale. Korean and Japanese labels remain one line, while English needs two lines at narrower widths.
4. The stats layout becomes one column below the tablet breakpoint for every locale. Korean and Japanese technically fit two columns substantially below that point; English section metadata is the limiting content.
5. Mobile stats section headers become stacked for every locale. Korean and Japanese section title/meta pairs fit inline at 320-430 px, while English does not consistently fit.
6. The tablet stock panel has a shared 286 px minimum. Measured one-line minima were approximately 226 px for Korean, 246 px for Japanese, and 256 px for English, before adding a small safety margin.
7. The segmented theme control becomes a dropdown below 684 px for every locale. Korean still fits at 661 px; Japanese and English do not.

## Correct locale-aware or justified shared behavior

- Candidate table column ratios and action-name alignment already vary by locale.
- The mobile recommendation uses locale-appropriate short labels for Korean/Japanese while English wraps naturally.
- Validation chart geometry did not overflow at 320/390 px; Korean/Japanese stayed at 112 px while English grew naturally to 134 px.
- Mobile outcome button/caption minimums stabilize the bottom bar and are an intentional interaction contract, not an English-driven distortion.
- The success-attempt modal stacks controls on mobile for touch ergonomics, not translation length.
- State controls, status strip, mobile tabs, footer, tooltips, and numeric progress UI showed no locale-driven clipping in the tested matrix.

## Verification

- `npm run build`: passed
- `npx playwright test e2e/i18n.spec.ts --project=chromium`: 12 passed
- Cross-locale screenshots: 18 result/stats captures in this directory
- Browser measurements: `metrics.json`
- Static responsive-rule inventory: `static-layout-search.txt`

No product source was changed by this audit.
