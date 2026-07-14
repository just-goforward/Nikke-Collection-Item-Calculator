# Visual QA

## Scope

- SR 15 terminal Super Success attempt modal
- Long outcome captions across Korean, Japanese, and English
- Responsive recommendation kit labels
- Locale-specific candidate table columns and action count alignment
- Mobile status level optical alignment

## Viewports

| Viewport | Evidence | Result |
| --- | --- | --- |
| 390 x 844 | `390-sr14-result.png` | Mobile recommendation, candidate table, captions, and bottom action bar fit without horizontal overflow or clipping. |
| 768 x 900 | `768-sr14-result.png` | Tablet outcome controls and candidate table remain readable without overlap. |
| 1280 x 900 | `1280-sr14-result.png` | Desktop result hierarchy and outcome controls remain balanced. |
| 390 x 844 | `390-sr15-attempt-modal.png` | Terminal attempt modal renders as a bottom sheet with a clear cancel action. |

## Pixel Check

The mobile status-level label was captured as a 48 x 24 PNG and compared against its light background. A color-distance threshold of 45 identified the rendered glyph rows.

- No offset: top whitespace 5 px, bottom whitespace 5 px.
- Previous 1 px downward offset: top whitespace 6 px, bottom whitespace 4 px.
- Decision: remove the mobile-only 1 px offset. Desktop result-strip labels retain their measured 1 px correction.

Locale comparison before the final decision:

| Locale | No offset | 1 px downward |
| --- | --- | --- |
| Korean | 5 px / 5 px | 6 px / 4 px |
| Japanese | 6 px / 5 px | 7 px / 4 px |
| English | 6 px / 7 px | 7 px / 6 px |

## Design Compliance

- Existing quiet operational palette, border radius, typography, and yellow outcome emphasis were preserved.
- No new decorative effects or nested cards were introduced.
- Mobile content remains readable above the fixed action and tab bars.
- Compact Korean and Japanese recommendation labels are used only when the full label would add an unnecessary line.
- English keeps its full label until the available width requires natural wrapping.
- Candidate count alignment is based on the longest currently visible locale label, not a fixed English width.

## Notes

The first automated capture targeted the hidden desktop calculate button at the mobile viewport and stopped without changing product state. The final capture uses the visible mobile toolbar action and waits for the loading overlay to detach before recording evidence.
