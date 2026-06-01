# A Baseline Feasibility Findings

Korean documentation: [`BASELINE_FINDINGS.ko.md`](./BASELINE_FINDINGS.ko.md)

Date: 2026-05-27

## Decision Status

The required exact interactive-replan feasibility gate for baseline model A has completed. All
five mandatory sentinels satisfy the existing probability gate with zero internal and boundary
violations. Candidate models B and C may now be implemented and evaluated as research models;
this does not authorize a product policy replacement.

The evaluator intentionally performs no approximation: after each observable outcome, it solves
again from the remaining physical stock. Zero-probability branches are skipped because they have
no contribution to the exact result.

## Verified Locally

The explicit benchmark tests currently cover:

- The 96-scenario safety grid shape and mandatory sentinel identifiers.
- Exact interactive-replan completion for the low-cost sentinel `R14e900-yellow30`.
- Explicit `verification_incomplete` reporting on exhausted evaluator budgets.
- Root-policy probability gate auditing across all 96 A scenarios.
- Deterministic interactive trajectory collection and tail summary primitives.
- Paired bootstrap and Holm-Bonferroni tail-statistics primitives.

Run:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run test:bench
```

## Completed Feasibility Gate

The supported live-output runner evaluates mandatory sentinels in high-cost-first order:

```powershell
$env:A_FEASIBILITY_BUDGET_MS = "40000"
& "C:\Program Files\nodejs\npm.cmd" run bench:a-feasibility
Remove-Item Env:A_FEASIBILITY_BUDGET_MS
```

The evaluator now also supports serialized exact checkpoints. Use a resumable 30-second slice to
continue the same computation across command invocations:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run bench:a-feasibility:slice
```

Its checkpoint is written under ignored `benchmarks/results/`; it contains solved boundary
policies and completed descendant values, not an approximate result.

The resumable exact runner completed all required sentinels within its 60-minute aggregate
budget:

| Scenario | Active Compute | Boundary Solves | Success Probability | Interactive F | Gate Violations |
| --- | ---: | ---: | ---: | ---: | ---: |
| `R0-balanced300` | 609,777 ms | 39,564 | 0.9999999999999998 | 0.024659813280066945 | 0 |
| `SR0-balanced300` | 135,848 ms | 14,672 | 0.9999999999999998 | 0.026706662774961247 | 0 |
| `R0-balanced100` | 18,919 ms | 2,516 | 0.9078240851567179 | 0.35691614548825096 | 0 |
| `SR0-balanced100` | 3,126 ms | 937 | 0.8691509913512931 | 0.38639717112739064 | 0 |
| `R14e900-yellow30` | 197 ms | 111 | 0.5814477455800285 | 0.452573837916863 | 0 |

Total active compute: 767,867 ms. The completed manifest is generated under ignored
`benchmarks/results/a-feasibility.checkpoint.json`; raw checkpoint data is not committed.

Before checkpoint support was introduced, a 40-second probe and an earlier exploratory ten-minute
run were incomplete. They established the need for resumable exact execution and are superseded
by the completed result above.

## Proceed Condition

B/C research implementation may proceed. Any later replacement decision still requires exact
interactive-replan comparison against A, probability gate violations of zero, and the remaining
tail-risk and performance acceptance checks.
