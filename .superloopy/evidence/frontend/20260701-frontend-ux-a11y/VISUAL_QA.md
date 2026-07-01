# Visual QA

Task: frontend core UX/A11y improvement.

## Design Contract

- `DESIGN.md` exists before UI edits.
- `DESIGN_TOKENS.md` captured the token gate for this session.
- Design read: Korean calculator tool, restrained operational UI, dense utility/dashboard direction.

## Browser Screenshots

Captured from production preview with Playwright:

- `390-stats.png`: 390 x 844, demo stats, mobile stats tab.
- `768-default.png`: 768 x 900, demo stats, default screen.
- `1280-default.png`: 1280 x 900, demo stats, default desktop screen.

Observed:

- 390px: calculation action row is hidden on stats tab; bottom tab navigation remains.
- 768px: single-column tablet flow has no clipping.
- 1280px: desktop input grid and stats columns render normally.

## Horizontal Scroll Check

Measured through a real browser:

```json
[
  { "width": 390, "innerWidth": 390, "scrollWidth": 375, "bodyScrollWidth": 375, "ok": true },
  { "width": 768, "innerWidth": 768, "scrollWidth": 753, "bodyScrollWidth": 753, "ok": true },
  { "width": 1280, "innerWidth": 1280, "scrollWidth": 1265, "bodyScrollWidth": 1265, "ok": true }
]
```

## Anti-Slop Pre-Flight

- Zero visible em dashes: pass. Source search also found none after CSS comment cleanup.
- Eyebrow count: pass. This app uses section headings, not tracked uppercase eyebrows.
- No AI-purple/glow default: pass. Purple is an SR/kit semantic token only.
- Non-default deliberate font stack: pass. Pretendard Variable Korean-first stack.
- No beige/brass palette: pass.
- Color, shape, theme consistency locks: pass.
- Layout-family requirement: not applicable to this dense single-screen tool; layout remains panel grid, tabbed mobile, stat bars, tables.
- No div fake screenshots or fake logos: pass. No screenshot/logo surfaces are part of this UI.
- Copy self-audit: pass. No banned AI marketing cliches or fake-perfect stats were added.
- Motion: existing transform/opacity/filter/state motion only; reduced-motion handling remains.
- Token trace: pass. Design-system compliance returned `ok: true` for touched UI files.
- Interactive states: pass. Mobile tabs, calculate buttons, InfoTip, loading, empty/error states covered by existing and new tests.
- No horizontal scroll at 390/768/1280: pass.

## Design Compliance Command

The Superloopy compliance module was executed via exported `checkFiles` because direct-main detection produced no stdout on Windows paths.

Result:

```json
{
  "ok": true,
  "design": "DESIGN.md",
  "base": 1,
  "declaredColors": 77,
  "counts": {},
  "violations": []
}
```
