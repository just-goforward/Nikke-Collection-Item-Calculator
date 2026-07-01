# Risk QA

Risk focus: accessibility and stale-input failure paths.

## Covered Risks

- Desktop light accessibility now runs without the previous `color-contrast` exception.
- Mobile dark accessibility remains covered.
- Stock edits now clear the manual-stock lock while typing, so the mobile calculate button re-enables before blur.
- Desktop and mobile calculate buttons blur the active input on pointer down, preserving the existing blur commit path before calculate.
- Mobile stats tab no longer renders the calculation toolbar, reducing content obstruction.
- Mobile tabs now expose `aria-controls` and panels expose matching `tabpanel` ids.
- InfoTip opens on hover, focus, and click, and closes with Escape or outside pointer.
- Loading overlay exposes a polite live status with `aria-busy`.

## Proof

- `npm run test:e2e`: 41 passed.
- New smoke coverage:
  - mobile stats tab has no `모바일 작업` toolbar.
  - mobile stats tab has `aria-controls="mobile-panel-stats"`.
  - manual stock edit can re-enable calculate without blur.
  - mobile InfoTip opens on focus/click and closes on Escape/outside pointer.

## Accessibility Gate

- `e2e/accessibility.spec.ts` no longer permits `color-contrast` violations.
- Both accessibility tests passed in the full E2E run.
