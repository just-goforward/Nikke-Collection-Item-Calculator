# Regression QA

## Commands

All required validation commands passed:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run test:worker`
- `npm run test:e2e`
- `npm run test:visual`

Additional checks:

- `npm run build`
- `npm run test:visual:update` regenerated the intended mobile stats snapshots.
- Superloopy design-system compliance check passed for touched UI files.

## Snapshot Updates

Updated visual snapshots:

- `e2e/visual.spec.ts-snapshots/mobile-dark-sr-stats-chromium-win32.png`
- `e2e/visual.spec.ts-snapshots/mobile-dark-sr-interval-tooltip-chromium-win32.png`

Reason: the mobile stats tab intentionally hides the calculation action row, shortening the full-page screenshot and reducing content obstruction.
