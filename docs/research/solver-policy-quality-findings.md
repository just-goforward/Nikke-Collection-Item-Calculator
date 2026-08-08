# Rust Solver Policy Quality Findings

Korean documentation:
[`solver-policy-quality-findings.ko.md`](./solver-policy-quality-findings.ko.md)

Date: 2026-08-05

## Decision

No researched mean-objective candidate is eligible for product adoption.

A per-scenario `product_candidate` label means only that the fixture-level quality gate passed.
Product adoption requires reading `selectedScenarioGrades` together with `decisionScope`; this
report does not authorize product adoption.

- The active product runtime, Worker protocol, solver version, and UI remain unchanged.
- The historical phase2 rerank runtime wiring was removed in commit `52a59c3`; only the
  research implementation and benchmark path remain.
- Exact one-step rerank can improve a static root evaluation, but it did not satisfy the exact
  interactive-replan quality and latency gates on min-E[f] fallback scenarios.
- A probability-constrained whole-policy prototype regressed a completed fixture and reached its
  memo limit on a fallback fixture. The prototype was removed after screening.
- At the time of this report, the CVaR ABI produced an interesting sampled tail signal but could
  not be graded because it lacked the success-probability gate and recorded-policy actions. A
  follow-up study closed both gaps but still rejected the candidate under the joint product gate.

## Evaluation Contract

The exact evaluator now records:

- SR15 success probability
- expected consumption by kit and in total
- interactive availability cost
- per-kit exhaustion probability
- minimum reachable remaining stock
- solve calls, cached nodes, elapsed time, and gate violations
- typed incomplete and policy-solver failure outcomes

It preserves raw stock remainders, sequential multi-use transitions, R15 to SR5 conversion, and
re-solves after every observed result. A hand-enumerated two-use fixture protects the branching,
consumption, exhaustion, and minimum-stock calculations.

## Static Root Audit

The current grid contains 122 synthetic scenarios from fixed, supplemental, and historically
aggregated scenario definitions. The aggregated scenarios are not user-frequency estimates.

With 512 MC runs:

| Result | Count |
| --- | ---: |
| Phase2 completed | 121 |
| Exact one-step rerank evaluated | 121 |
| Exact root action changed | 13 |
| Exact static root cost improved | 13 |
| Exact static root cost regressed | 0 |
| min-E[f] completed | 117 |
| min-E[f] memo full | 5 |

Across all 117 min-E[f]-completed scenarios, exact one-step cost was lower than min-E[f] in zero
cases, equal within `1e-12` in 15, and higher in 102. No optimality inversion was found in the
completed region; different first actions can still represent equal objective values.

All 121 MC/exact delta comparisons were within the nominal 1.96-standard-error band. This is
calibration evidence for this grid and run count, not proof that a particular seed caused or
eliminated every disagreement.

The five min-E[f] capacity cases were:

- `R0-balanced300`
- `R10-balanced300`
- `SR0-balanced300`
- `R0-observedBalanced`
- `SR0-observedPurpleHigh`

## Exact Interactive Fallback Gate

The two fallback-relevant completed phase2 scenarios below were evaluated with a 120-second exact
budget and five root-latency repetitions.

| Scenario | Candidate | Delta P | Delta interactive F | Delta total uses | Warm p95 | Grade |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `R10-balanced300` | MC rerank | 0 | +0.000385782 | +1.6391 | 138.77 ms | rejected |
| `R10-balanced300` | exact one-step | +1.1e-16 | +0.000261342 | -0.7384 | 573.46 ms | rejected |
| `SR0-balanced300` | MC rerank | -1.1e-16 | +0.001684126 | +3.0888 | 832.12 ms | rejected |
| `SR0-balanced300` | exact one-step | +1.1e-16 | +0.001979388 | +3.2440 | 3351.11 ms | rejected |

Lower interactive F and lower total uses are better. [Confirmed] The exact candidate reduced
expected total uses by about 0.7384 in `R10-balanced300`, but worsened interactive F and had no
strict success-probability or F benefit. The current classifier therefore rejects it on quality
alone; it also independently exceeded the latency gate (`max(+15%, +50ms)`). Static first-action
improvement did not establish an interactive product improvement.

Warm p95 is nearest-rank p95 over four samples after discarding one cold sample. At this sample
size it equals the observed maximum and is screening evidence, not a user-latency distribution.

## Conditional Whole-Policy Screening

[Unverified and not reproducible from current HEAD] A research-only probability-constrained
exact-policy prototype was screened because one-step rerank did not pass. The prototype has been
removed, so the historical numbers below cannot be reproduced by an identical current execution.

- On `R14e900-yellow30`, interactive F increased from `0.3279638107` to `0.3303792873`, and
  expected total consumption increased by about `0.3291` pieces.
- On `R10-balanced300`, the candidate reached its fixed memo limit instead of completing.

This fails both the completed-fixture equivalence gate and the fallback-completion gate. The Rust
prototype and its WASM exports were removed rather than leaving a rejected abstraction in the
product artifact.

## CVaR ABI Audit

The sampled audit used `alpha=0.9` and eta values
`0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6`.

For `R14e900-yellow30`, the best sampled point was eta `0.8`:

| Metric | Phase2 policy | Recorded CVaR policy | Delta |
| --- | ---: | ---: | ---: |
| Mean cost | 0.7247767680 | 0.7054249217 | -0.0193518463 |
| Sampled CVaR90 | 1.0144857929 | 0.9895445060 | -0.0249412869 |

The raw-pieces audit also changed stock from `100/100/30` to `101/101/31`. Uses were unchanged,
while mean cost changed by `-0.0074593649`, confirming that the ABI preserves raw stock
denominators.

This remains [Incomplete] `verification_incomplete` for product use:

- the optimizer admits every stock-valid action instead of the product probability gate
- the recorded action table is not exposed to the exact interactive evaluator
- the eta grid samples rather than proves the continuous dual optimum

The follow-up study added the success-probability gate and recorded-policy action export, then
screened 122 roots. Both changed roots violated at least one exact-interactive constraint across
mean burden, total consumption, and per-kit exhaustion. The current decision is recorded in
[`phase2-methodology-findings.md`](./phase2-methodology-findings.md).

## Next Decision

Do not reconnect rerank or CVaR to production.

The follow-up study implemented the probability gate and research action export, but no candidate
passed the product criteria. The current min-E[f] plus phase2 fallback remains the product policy.

## Artifact Roles

- `benchmarks/rerank-quality.ts` owns the classification execution contract.
- Benchmark specs protect representative behavioral regressions.
- The runner owns campaign execution and serialization.
- This document is the tracked research interpretation.
- Ignored JSON under `benchmarks/results/` is reproducible raw evidence for a specific run.
