# Locale content-fit implementation visual QA

## Scope

- Candidate table label and header variants selected from measured rendered fit.
- Outcome decision panel stacks only when the current localized copy overflows.
- Tablet stock panel uses intrinsic localized label width.
- Stats grid and theme control density vary only when localized content requires it.

## Browser evidence

| Capture | Locale | Viewport | Result |
| --- | --- | --- | --- |
| `390-ko-result.png` | Korean | 390 x 844 | Full Korean candidate name retained, compact headers used, no table overflow. |
| `768-ja-result.png` | Japanese | 768 x 900 | Stock panel remains narrow, outcome panel stays inline, candidate labels remain full. |
| `1280-en-result.png` | English | 1280 x 900 | Full labels and headers fit without forced wrapping or horizontal scrolling. |

All three captures were generated with Chromium from the production Vite build. The measured candidate overflow was `0px` in every capture. Direct image inspection found no clipped labels, overlapping controls, incoherent empty space, or horizontal scrolling.

## Behavioral coverage

- At 390px the candidate variant is `full` for Korean and `panel` for Japanese and English when their longer text requires it.
- At 768px the stats grid uses two columns for Korean and Japanese and one column for English.
- At 661px the Korean theme segmented control remains visible while Japanese and English use the compact menu.
- At 768px the stock panel widths measured 225px Korean, 239px Japanese, and 249px English, leaving all remaining width to the collection-state panel.

## Verification

- `npm run typecheck`
- `npm run lint`
- `npm test` - 158 tests passed
- `npm run test:worker` - 45 tests passed
- `npx playwright test e2e/i18n.spec.ts` - 13 tests passed
- Relevant smoke/outcome tests passed after updating the obsolete fixed-label assertion.
