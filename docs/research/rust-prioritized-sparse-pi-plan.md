# Rust Prioritized Sparse Policy Iteration Research Contract

Pre-execution baseline: 2026-08-08, the then-uncommitted research work on commit `6251db3`

> **Status: completed and rejected for product use.** This document preserves the pre-registered
> research contract. The actual run exceeded the 1.2-million-state R10 exact-closure budget, and the
> bounded candidate did not jointly pass latency, WASM-size, and quality gates. The current decision
> is owned by [`phase2-methodology-findings.md`](./phase2-methodology-findings.md) and the Korean
> [`phase2-next-research-ledger.ko.md`](./phase2-next-research-ledger.ko.md).

## Question And Hypotheses

The TypeScript sparse PI candidate improved exact-interactive resource metrics on some phase2
fallback inputs, but was 3.85 to 28.58 times slower than phase2. This candidate evaluates the same
raw-stock terminal objective and probability gate inside Rust/WASM and prioritizes states by the
largest discovered root-path probability.

- [Hypothesis] On small min-E[f]-completed fixtures, a `completed` policy that exhausts the eligible
  successor closure matches min-E[f] action, probability, cost, and expected-consumption vector.
- [Hypothesis] On the R10 fallback, a small update batch materially reduces the four-pass screening
  time by avoiding TypeScript/WASM traffic and repeated whole-set improvement scans.
- [Hypothesis] Priority changes traversal only. `completed` is allowed only after no strict
  improvement remains in the discovered closure. Pass/state budget outcomes are approximate and are
  not product candidates.

The priority score is the maximum discovered root-path probability, not exact occupancy. Converging
path masses are not summed, so the score is a traversal heuristic rather than a quality guarantee.

## Pre-Registered Gates

### Correctness

- Require `completed` on four min-E[f]-completed fixtures.
- First action must match; success/cost must agree within `1e-12`, and all vector axes within `1e-10`.
- Probability gap must not exceed `1e-12`.
- Existing min-E[f] semantic bits, node-count golden, and phase2 parity remain mandatory.

### Capacity And Performance

- The research state budget is `1,200,000` and is not raised after seeing results.
- Product latency gate: warm p95 no worse than `max(+15%, +50ms)` relative to phase2.
- Continue to exact-interactive screening only if R10 `4 passes x 256 updates` stays within 1.5 times
  phase2 and has no typed failure.
- A candidate over the product raw WASM budget of `115KB` is not adopted as-is.

### Quality

- A bounded non-`completed` policy is evaluated only as `research_tradeoff` evidence.
- Exact-interactive success probability must not fall by more than `1e-12`.
- Interactive F and total expected uses must both be non-worse for product candidacy.
- Any per-kit exhaustion or manual-entry regression is reported as a trade-off alongside gains.

## Isolation And Stop Conditions

The candidate is built only with Cargo feature `research-sparse-pi`; it does not replace
`public/solver_rs.wasm`. Product research stops on any of the following:

1. min-E[f] semantic mismatch on a small completed fixture
2. R10 exact closure exceeding the fixed state budget
3. R10 screening latency failure
4. exact-interactive joint quality-gate failure
5. raw WASM budget failure without enough performance and quality evidence to justify size work

On stop, no product runtime wiring is added. Reusable evaluators, fixtures, typed outcomes, and the
findings remain tracked; bulk JSON and candidate WASM artifacts remain under ignored result/output
paths.
