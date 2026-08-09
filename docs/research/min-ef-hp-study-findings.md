# Rust min-E[f] Joint H/p Study

- Generated: 2026-08-05T13:14:59.246Z
- Baseline: `H0.75-p3`, tau=0
- Scope: research only; no automatic product-adoption authority

## Evidence Lineage

| Evidence | Semantics | Role in this decision |
| --- | --- | --- |
| `6dcb329` availability study | historical solver and stock contract | prior evidence only; numeric results are not pooled |
| current `min-ef-hp-study` v1 | raw pieces, current WASM, min-E[f] to phase2 ladder | sole numeric basis for the current decision |

## Baseline And Screening

- [Confirmed] Baseline equivalence: passed (raw remainder min-E[f] root is bit-identical to the current product wrapper; R0-balanced300 falls back from min-E[f] tier 21 to bit-identical phase2 tier 22; exact interactive evaluation preserves R15 to SR5 conversion)
- [Confirmed] Root screening: 5978/5978
- [Confirmed] 16 shortlisted candidates: `H1.25-pinf`, `H0.875-pinf`, `H1.25-p6`, `H1.25-p4`, `H0.875-p6`, `H0.75-pinf`, `H1-p4`, `H1.25-p3`, `H0.5-pinf`, `H0.75-p4`, `H1-p3`, `H0.75-p3`, `H0.5-p3`, `H0.75-p2`, `H0.25-p3`, `H0.75-p1`
- [Confirmed] Root-screen latency is candidate-screening evidence, not a user-experience distribution.

## Exact Interactive

- [Confirmed] Terminal records: 176/176
- [Confirmed] completed 176, solver failures 0, checkpoint pending 0
- [Confirmed] hard gates: 57 passed, 119 failed, 0 incomplete
- [Confirmed] Tail entrants: `H0.75-p3`, `H0.5-p3`

## Tail, D1, And Performance

- [Confirmed] 1 tail discovery decision(s), 0 passed, 0 confirmation record(s)
- [Confirmed] `H0.5-p3` changed `R0-balanced150` CVaR90 from 76.4861 to 85.9952 days (improvement -9.5091 days), a Holm-adjusted significant regression.
- [Confirmed] D1 snapshot (diagnostic v6, 818 events); 0 candidate replay decision(s)
- [Confirmed] 0 independent performance record(s)
- [Inference] No tail-discovery challenger passed, so candidate D1 replay and performance campaigns were skipped.
- [Inference] D1 events are repeated calculation events, not unique users or user-frequency estimates.

## Adaptive H/p Follow-Up

- [Confirmed] The next-generation solver study required a distributional state representation
  before implementing a path-dependent adaptive H/p candidate.
- [Confirmed] That prerequisite Pareto representation reached p95 frontier width 184 on the small
  exact graph, above the pre-registered cap of 32, so adaptive H/p implementation did not start.
- [Inference] This supports retaining fixed `H=0.75, p=3` under the current contract, but does not
  prove that every possible adaptive rule is inferior. See
  [`next-solver-research-findings.md`](./next-solver-research-findings.md) for details.

## Decision

- `H1.25-pinf`: rejected
- `H0.875-pinf`: rejected
- `H1.25-p6`: rejected
- `H1.25-p4`: rejected
- `H0.875-p6`: rejected
- `H0.75-pinf`: rejected
- `H1-p4`: rejected
- `H1.25-p3`: rejected
- `H0.5-pinf`: rejected
- `H0.75-p4`: rejected
- `H1-p3`: rejected
- `H0.5-p3`: rejected
- `H0.75-p2`: rejected
- `H0.25-p3`: rejected
- `H0.75-p1`: rejected

- [Inference] Final status: keep_baseline
- [Inference] Selected candidate: `H0.75-p3`
- [Confirmed] This report does not authorize a runtime-constant change.

Keep H=0.75, p=3 whenever a required gate is incomplete or no benefit is statistically distinguishable from baseline.
