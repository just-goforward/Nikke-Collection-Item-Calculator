# Conditional Solver Portfolio Study

- Run date: 2026-08-11
- Baseline commit: `7e3d07130568e6312590b825dfcd1d2213dcbab3`
- Product baseline: `rust-min-ef` tier 21, then `rust-phase2` tier 22 on capacity failure
- Scope: research only; no product runtime, WASM, UI, Worker protocol, or D1 schema change

## Decision

Selecting a solver from the initial collection/stock state, or inserting another exact solve after a
min-E[f] capacity failure, did **not** pass the product gates for the candidates and rules fixed in
this study. The current dynamic ladder remains in place.

- `[confirmed]` Branch-and-bound B2 exactly rescued 24 of 25 capacity-failing roots.
- `[confirmed]` On held-out validation, however, the full tier-21-failure-to-B2 route passed the
  latency gate on 0 of 9 roots.
- `[confirmed]` A static rule that selected tier-22 min-E[f] directly completed 7 of 8 matches and
  passed latency on 7 of 8 in the current provenance run.
- `[confirmed]` Worst combined WASM memory growth was 425.375MiB for direct tier 22 and 540.25MiB
  when tier 21 was attempted first.
- `[decision]` Exact-interactive, browser, and Android gates were not run because no finalist passed
  the root completion, latency, and memory prerequisites.

This is not a proof that conditional solver selection is mathematically impossible. It shows that a
simple rule based on grade, level, EXP, and stock did not generalize at held-out boundaries.

## Candidates

| Candidate | Application point | Goal |
| --- | --- | --- |
| Grade-based exact rescue | After tier-21 capacity failure | Tier-22 min-E[f] for R; B2 for SR |
| Conditional tier-22 rescue | After tier-21 capacity failure | Retry exact only on selected R states |
| Direct tier 22 | Before the first solve | Avoid the known failed tier-21 attempt |
| B2 exact rescue | After every capacity failure | Rescue roots that ordinary min-E[f] cannot finish |
| Bounded prioritized phase2 | After SR capacity failure | Improve phase2 with bounded policy updates |

The exploratory static rule was:

```text
grade R
level <= 7
total stock >= 600 pieces
and either:
  - maximum kit stock <= 220 pieces
  - minimum stock * 2 <= maximum stock
```

Because this rule was derived from discovery and confirmation, it was judged only on a new 24-case
validation set spanning R2/R6/R8 and the 205/225, half/near-half, and 599/601 boundaries.

## Evidence Sets

| Cohort | Scenarios | Tier-21 capacity failures | Role |
| --- | ---: | ---: | --- |
| Discovery | 122 | 5 | Existing fixed, supplemental, and product-observed roots |
| Confirmation | 48 | 11 | Pre-registered intermediate R/SR states and new stocks |
| Routing validation | 24 | 9 | Held-out rule boundaries and direct routing |

- `[confirmed]` Ordinary tier-22 min-E[f] and B2 were bit-identical on all 10 common exact
  completions in discovery plus confirmation.
- `[confirmed]` They were also bit-identical on 2 of 2 common validation completions.
- `[confirmed]` B2 reported zero maximum-success prepass mismatches.
- `[confirmed]` Direct tier 22 matched completed tier 21 bit-for-bit on all 5 common validation
  cases. A larger tier does not itself change policy semantics.

## Root Results

### Discovery and confirmation

| Metric | Result |
| --- | ---: |
| Root scenarios | 170 |
| Tier-21 capacity failures | 16 |
| Grade-based exact rescues | 12/16 |
| Grade-route full-latency passes | 5/16 |
| B2 completions | 15/16 |

Grade alone did not generalize as a routing rule. B2 improved completion, but not at uniformly
acceptable cost.

### Held-out routing validation

| Route | Completion | Root latency passes | Maximum memory growth |
| --- | ---: | ---: | ---: |
| Current ladder on 9 capacity failures | 9/9 | Baseline | 311.375MiB |
| Conditional tier 22 after failure | 2/3 | 2/3 | 540.25MiB |
| Direct conditional tier 22 | 7/8 | 7/8 | 425.375MiB |
| B2 after failure | 9/9 | 0/9 | 407.75MiB |

These route timings are single-run screening measurements. The direct route passed 6 of 8 latency
checks in the preceding provenance run and 7 of 8 in the current rerun, so they are not estimates of
the user latency distribution. The one exact-completion failure and the large memory growth already
fail the product prerequisite gate independently of that timing variation.

`R2 / 360,300,180` matched the rule but tier-22 min-E[f] also reached `MEMO_FULL`, so phase2 ran
after it. The direct route was about 21% slower than the current ladder and increased memory growth
from roughly 311MiB to 425MiB.

On `R6 / 301,150,150`, tier 21 already completed. Direct tier 22 produced the same policy but was
about 2% slower in the current single screening run and doubled min-E[f] memory growth from about 115MiB
to 229MiB. False-positive routing therefore has a real mobile memory and latency cost even when
semantics are unchanged.

`[inference]` Even if the failed tier-21 attempt is counterfactually removed and only B2 solve time
is counted, B2 passed the validation latency limit on 3 of 9 cases. A perfect capacity predictor
would not make the current B2 implementation a universal exact fallback.

## Independent Candidate Evidence

The existing 31-repeat ABBA allocation-warm B2 campaign used the same current artifact:

- Small semantic fixture: parity, B2 p95 `139.61ms`, product p95 `199.81ms`.
- `R0 / 250,250,250`, tier 22: parity, but B2 p95 `3042.48ms` versus product p95 `1576.39ms` and
  an allowed limit of `1812.85ms`.

The independently studied bounded prioritized phase2 candidate also remained blocked:

- `R10-balanced300` exact interactive quality regressed in interactive F, total uses, and blue-kit
  exhaustion probability.
- Repeated latency gates failed on R10 and SR0.
- Candidate WASM was `133089B`, above the `115000B` product budget.

## Why Android Was Not Run

The connected Android 13 ADB device was available, but mobile testing was registered as a final
survivability and ARM64-cost gate after Node root, quality, and performance gates. Every candidate
failed earlier. Running a rejected candidate on that device would not change adoption and would not
represent low-memory or 32-bit Android hardware.

## Product Meaning

The site remains unchanged. The current ladder uses exact min-E[f] for ordinary inputs and falls
back to phase2 at capacity boundaries. Conditional exact routing improved some roots, but held-out
cases also reproduced large latency and memory penalties.

Future work needs at least one new enabling result rather than another stock threshold:

- a cheap, verifiable tier-21 capacity predictor;
- a grow-and-resume memo design that does not discard tier-21 work; or
- a stronger, cheaper admissible bound that reduces B2 hard-state p95.

## Reproduction

```powershell
npm run build:solver-wasm:branch-bound
npm run build:solver-wasm:sparse-pi
npm run bench:solver-portfolio
npm run bench:solver-portfolio-routing
npm run bench:solver-portfolio-finalize
```

Large JSON and candidate WASM outputs remain gitignored under `benchmarks/results/` and `output/`.
Tracked assets are the contracts, scenarios, runners, verification code, and these findings. The
finalizer stops if measured source or artifact hashes no longer match the current files.
