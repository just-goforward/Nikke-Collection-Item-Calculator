This fixture preserves the previously approved 24 browser inputs. `snapshot.json` contains the frozen forecast input shared by every row. `independent-physical-cohorts.json` preserves the authenticated output of the independent ordered physical dispatch enumeration, including its original source hashes. `provenance.json` records the historical input and enumeration origins.

`panel.json` is generated with the independent reduced BigInt Bellman oracle. It contains exact P/B/C, consumption by color, selected action, all optimal action bits, recurring rates, prices, original cohort priors, and independent current action-gap certificates. Candidate numerical modules are excluded from its generator. The regular validator recomputes all 24 expected rows and requires exact equality with the stored fixture. Missing or stale files fail the test; no ignored result cache is read and no data is silently regenerated.

Run from the repository root:

```sh
node scripts/generate-certified-staging-approved-panel.ts
npm test -- scripts/certified-staging-dist-validation.spec.ts --maxWorkers=1
npx playwright test e2e/certified-staging-api.spec.ts --workers=1
```

The browser command requires a completed production `dist` and all three installed Playwright browsers. It serves the actual manifest-selected numerical Worker unchanged, identifies a separately rebuilt client adapter, verifies exact HTTP response bodies against every dist asset, and records their SHA-256 hashes. It compares all approved 24 inputs in Chromium, Firefox, and WebKit, with one pinned dist inventory across the campaign. It does not build production assets itself.

Waiting/status/refusal comparisons use the separately compiled candidate source API and are reported as parity. Independent waiting and waiting-gap proof are not run here. Worker action-gap fields do not exist; the saved current gaps are independent oracle certificates. This panel does not establish a new 2,000-case current proof, full production React math proof, a population performance gate, or physical browser memory acceptance. Browser reports and provenance are written under `test-results/certified-staging-dist-*`.

`pilot-endpoints.json` preserves six complete historical pilot rows, selected in their original order. `pilot-endpoints-provenance.json` pins the unchanged original report SHA-256, the selected file SHA-256 and each row SHA-256. These rows are historical witness inputs, not new proof results. The separate endpoint integer suite reads this tracked fixture and the tracked independent physical data, retains all nine price families and 8,127 comparisons, and preserves its six-row replay limits. It writes fresh replay reports without reading ignored result caches. Its heavy calculations are a separate mandatory CI step.
