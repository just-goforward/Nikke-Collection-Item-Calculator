# Visual QA

## Scope

- Candidate table horizontal padding uses only the minimum separation needed for a dense data table.
- Desktop and tablet column ratios reserve content space by locale instead of keeping oversized action columns.
- Long table headings switch to their compact variants based on table width, not viewport width.
- Text still wraps naturally when the full localized value genuinely cannot fit.

## Target Reproduction

- Locale: Korean
- State: R 8
- Stock: 200 / 100 / 50
- Viewports: 981px, 992px, 1003px

Before the change, the 981px layout produced a 450px table. Four cells consumed 96px in horizontal padding, leaving 120px for a breakdown that needed about 140.30px in test Chromium.

After the change:

- Cell padding: 4px per side, leaving 8px between adjacent column content.
- Korean 981px columns: 72 / 148.5 / 76.5 / 153px.
- Korean 981px and 1003px breakdown rows: 1 / 1 / 1 lines.
- Horizontal overflow: 0px.
- Narrow two-column desktop table headings: `후보 / 첫 행동 / 도달률 / 소모량`.

## Rendered Evidence

| Viewport | Locale | Evidence | Result |
| --- | --- | --- | --- |
| 390 x 844 | Korean | `390-ko-r8.png` | Existing mobile proportions remain intact; genuine narrow-space wrapping is preserved. |
| 768 x 1000 | Japanese | `768-ja-r8.png` | Full Japanese headings and all three breakdowns remain on one line without overflow. |
| 981 x 1100 | Korean | `981-ko-r8.png` | Exact reported condition; headings and all three breakdowns remain on one line. |
| 1003 x 1100 | Korean | `1003-ko-r8.png` | Exact upper-bound condition; no excessive spacing or wrapping. |
| 1280 x 1000 | English | `1280-en-r8.png` | Long English action labels retain sufficient width while expected-use rows remain on one line. |

## Review

- No font-size reduction, negative letter spacing, forced no-wrap overflow, or horizontal scrolling was introduced.
- Existing table typography, row dividers, colors, and vertical density were preserved.
- Compact labels are selected by the component's actual inline size, so split desktop layouts no longer inherit inappropriate wide-screen copy.
