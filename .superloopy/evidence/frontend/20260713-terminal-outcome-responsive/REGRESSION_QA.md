# Regression QA

## Automated Coverage

- SR 15 attempt selection deducts the selected kit amount and applies the terminal state.
- Modal cancel keeps the stock unchanged and applies the terminal state without attempt statistics.
- Clicking the overlay outside the modal is equivalent to cancel.
- SR 14 outcome captions remain unclipped at 981, 390, and 320 px for Korean, Japanese, and English.
- Mobile outcome bar and button dimensions remain stable before and after outcome selection.
- Korean and Japanese mobile recommendation names stay on one line with the quantity when space permits.
- Candidate tables use locale-specific column widths and remain free of horizontal overflow.
- Candidate action counts share one start position based on the longest visible kit label.
- Desktop and mobile optical-alignment contracts are tested separately.

## Commands

```text
npm run typecheck
npm run lint
npm run build
npx playwright test e2e/outcome-regression.spec.ts --project=chromium
npx playwright test e2e/i18n.spec.ts --project=chromium -g "SR 14 outcome|candidate actions|optical"
npm test
npm run test:worker
npx playwright test e2e/accessibility.spec.ts e2e/i18n.spec.ts e2e/outcome-regression.spec.ts e2e/smoke.spec.ts e2e/worker-concurrency.spec.ts --project=chromium
npm run test:visual:update
npm run test:visual
```

Final results:

- App unit tests: 158 passed.
- Cloudflare Worker tests: 45 passed.
- Non-visual Chromium E2E: 61 passed.
- Windows visual snapshots: 8 passed after regenerating the three intentionally changed result baselines.

Linux visual baselines were not generated from Windows and remain a CI follow-up when a commit is requested.
