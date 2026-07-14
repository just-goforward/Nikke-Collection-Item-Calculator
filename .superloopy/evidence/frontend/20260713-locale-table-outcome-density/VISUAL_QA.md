# Visual QA

## Scope

- Mobile recommendation marker follows each locale's natural text width.
- Candidate table columns allocate space by locale and keep the candidate heading aligned with body cells.
- Outcome captions use one-line height when their content fits.
- Narrow tablet outcome confirmation switches to a single-column panel so the full confirmation copy can use the panel width.

## Rendered Evidence

| Viewport | Locale | Evidence | Result |
| --- | --- | --- | --- |
| 390 x 844 | Korean | `390-ko-result.png` | Recommendation marker is adjacent to the compact Korean label; candidate table has no horizontal overflow; consumption column remains readable. |
| 390 x 844 | Japanese | `390-ja-result.png` | Recommendation marker follows the Japanese label; locale-specific table widths preserve the consumption column. |
| 768 x 900 | Japanese | `768-ja-pending.png` | Confirmation layout uses the full panel width; the caption is 18px high and remains on one visual line. |
| 1280 x 900 | Korean | `1280-ko-result.png` | Desktop table uses Korean-specific column proportions without introducing horizontal scrolling. |

## Geometry Checks

- Korean mobile recommendation width: `180.5px`; marker-to-text gap: `8px`.
- Japanese mobile recommendation width: `204.4px`; marker-to-text gap: `8px`.
- Korean mobile table columns: `61.8 / 110.5 / 55.3 / 97.5px`.
- Japanese mobile table columns: `65 / 113.8 / 55.3 / 91px`.
- Table horizontal overflow: `0px` in both mobile locales.
- Japanese tablet pending caption: `18px` high; `scrollWidth === clientWidth`.

## Review

- No new decorative language or fixed English-width alignment was introduced.
- Existing color, border, typography, and motion tokens were preserved.
- The denser caption rows remain readable and the outcome buttons keep their existing dimensions.
