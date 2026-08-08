# Rust Phase2 Methodology Findings

Korean documentation:
[`phase2-methodology-findings.ko.md`](./phase2-methodology-findings.ko.md)

Date: 2026-08-08  
Baseline commit: `6251db3` plus the uncommitted research changes  
Scope: research-only Rust/WASM ABI, TypeScript evaluators, benchmarks, and notebook

## Decision

[Confirmed] No Rust phase2 methodology candidate is currently eligible for product adoption. The
product runtime, UI, Worker protocol, D1 schema, and solver policy version remain unchanged.

- A cap-offset state extension was rejected because it restores no mathematically distinct state.
- Changing min-E[f] action traversal order changed node counts by only tens and did not move any
  completion boundary.
- A success-gated CVaR one-step policy changed two of 122 roots, but neither survived the joint
  exact-interactive product gate.
- Sparse constrained policy iteration improved user-flow resource metrics on some fallback inputs.
  The current TypeScript implementation is nevertheless about 3.85 to 28.58 times slower than
  phase2 at warm p95 and is not a product candidate.

[Confirmed] The isolated Rust/WASM priority implementation was also tested. It matched min-E[f]
semantics on small completed fixtures, but the exact R10 closure exceeded the 1.2-million-state
budget. The bounded four-pass candidate had a 1.515x warm-p95 ratio to phase2, and the candidate
WASM was 131,426 bytes against a 115KB budget. The pre-registered stop conditions therefore ended
the study before exact-interactive evaluation or product wiring.

## Candidate Audit

| Candidate | Research question | Confirmed result | Decision |
| --- | --- | --- | --- |
| A. Phase2 cap offset | Does preserving clipped stock as an offset restore useful phase2 information? | An independent recurrence matched `capStockForState` for every nonterminal state across 960 encoded states and three kits | Rejected |
| B. Sparse constrained PI | Can exact improvement of only necessary phase2 states cover min-E[f] fallback inputs? | The TypeScript candidate showed quality signal but was slow; the prioritized Rust candidate failed exact R10 capacity, bounded latency, and WASM-size gates | Rejected |
| C. min-E[f] action order | Can traversal order reduce `MEMO_FULL` outcomes? | Six permutations preserved action, success bits, and cost bits; node deltas were 6 to 56 with no outcome change | Rejected |
| D. Gate-aware CVaR | Can a tail objective preserve the product's success and resource constraints? | Two of 122 roots changed; both failed the exact-interactive joint gate | Rejected |

## A. Cap Offset

[Confirmed] A TypeScript test independent of the Rust cap implementation evaluated:

```text
M(s, target) = max_action(
  I(action = target) + max(M(successor_success), M(successor_failure))
)
```

For every nonterminal state, `M` exactly equals the existing state-specific cap. Stock above that
cap cannot encode an additional phase2 action. Adding an offset to the memo key would increase the
state dimension and memory use without distinguishing a new optimal policy. Terminal cap no-op
behavior is protected separately as part of the existing contract.

## C. Action Traversal Order

[Confirmed] All six kit permutations produced bit-identical first actions, success values, and
expected costs. Per-fixture node-count ranges were 6 to 56. `R0-balanced250` was `MEMO_FULL` for
every order at tier 21 and completed for every order at tier 22. Traversal order therefore has a
measurable but operationally negligible effect on the tested capacity boundary.

## D. Gate-Aware CVaR

[Confirmed] The CVaR candidate was restricted to actions inside the phase2 maximum-success gate.
Only `R10-balanced300` and `SR5-observedPurpleHigh` changed root action in the 122-root screen.

| Fixture | Interactive P delta | Interactive F delta | Total-use delta | Rejection reason |
| --- | ---: | ---: | ---: | --- |
| R10-balanced300 | 0 | +0.0009873 | +2.2575 | Burden and total consumption regressed |
| SR5-observedPurpleHigh | about +1 ulp | -0.005313 | -8.8477 | Blue exhaustion probability increased by 0.004558 |

This rejects the tested eta grid and one-step policy under the joint product gate. It does not
prove that every possible tail-risk objective is useless.

## Sparse Constrained Policy Iteration

The initial policy is phase2. The evaluator computes exact raw-stock terminal cost under the
current policy, expands the successor closure of alternative actions within the phase2
maximum-success gate, and replaces only states with a strict cost improvement. Exact ties preserve
the existing action. Iteration, state, and time limits produce typed outcomes.

[Confirmed] On four small semantic fixtures, converged sparse PI matched Rust min-E[f] in action,
success probability, cost, and the three-axis expected-consumption vector. A one-iteration unstable
policy reports `iteration_budget_exceeded`, not `completed`.

### Root Screen

| Fixture | Iterations | Root cost delta | Expected-use delta | Maximum evaluated states |
| --- | ---: | ---: | ---: | ---: |
| R0-balanced300 | 21 | -0.0122992 | -2.19453 | 951,465 |
| R10-balanced300 | 28 | -0.00828439 | +0.088421 | 276,843 |
| SR0-balanced300 | 24 | -0.00827429 | -0.691422 | 455,492 |
| R0-observedBalanced | 26 | -0.0165700 | +0.356003 | 217,093 |
| SR0-observedPurpleHigh | 21 | -0.0423141 | -7.12296 | 361,239 |

Lower fixed-policy root cost is not sufficient evidence of a better interactive policy, so exact
replanning remains the product-quality judge.

[Confirmed] Successor-closure size is strongly input dependent.

| Fixture | Phase2 policy states | Sweep 1 | Sweep 2 | Sweep 3 | Sweep 4 | Full eligible closure |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| R14e900-yellow30 | 353 | 507 | 622 | 709 | 743 | 750 |
| R10-balanced300 | 10,296 | 83,569 | 276,843 | 559,854 | 890,325 | over 2,000,000 |

The alternative-action successor closure grows rapidly on R10. Current latency therefore reflects
both TypeScript/WASM boundary overhead and a genuinely large repeatedly evaluated state set.

### Exact Interactive Results

The candidate follows the product ladder: a completed min-E[f] result is retained, and sparse PI
is invoked only where min-E[f] fails.

| Fixture | Sparse mode | P delta | Interactive F delta | Total-use delta | Exhaustion delta | Expected manual-entry delta |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| R10-balanced300 | converged | -1.11e-16 | -0.0000195441 | -0.00737312 | blue -0.0000925147 | -0.0401802 |
| R0-observedBalanced | converged | 0 | 0 | 0 | all zero | 0 |
| SR0-observedPurpleHigh | converged | 0 | 0 | 0 | all zero | 0 |
| SR0-balanced300 | four sweeps | -1.11e-16 | -0.00312231 | -0.302357 | blue -0.00349444 | +0.533577 |

Within the `1e-12` success-probability tolerance, R10 improves F, total consumption, blue
exhaustion, and manual-entry burden. The four-sweep SR0 policy improves resource metrics but is not
converged and increases expected manual entries.

### Performance Screening

Warm p95 is nearest-rank over four samples after discarding the first measurement from the same
WASM instance. This small campaign is a rejection screen, not a user-latency estimate.

| Variant | Fixture | Phase2 warm p95 | Sparse warm p95 | Ratio |
| --- | --- | ---: | ---: | ---: |
| converged | R10-balanced300 | 243.0 ms | 6,944.7 ms | 28.58x |
| converged | SR0-balanced300 | 1,245.2 ms | 14,722.6 ms | 11.82x |
| four sweeps | R10-balanced300 | 247.1 ms | 2,270.7 ms | 9.19x |
| four sweeps | SR0-balanced300 | 1,213.9 ms | 4,673.9 ms | 3.85x |

[Confirmed] Every record exceeds the existing `max(+15%, +50ms)` screen by a wide margin. The
current TypeScript sparse PI implementation is therefore rejected for product use regardless of
its quality signal.

### Rust-Native Prioritized Follow-Up

The Rust candidate is isolated behind Cargo feature `research-sparse-pi` and is absent from the
product build. It inspects states in descending maximum discovered root-path probability and
applies a fixed number of strict improvements per pass. This score is a traversal heuristic, not
summed occupancy. `completed` requires no remaining strict improvement in the recursively
discovered eligible closure.

[Confirmed] With `maxUpdatesPerPass=1,000,000` and a 1.2-million-state budget, four small fixtures
completed and matched min-E[f] action, success, expected cost, and all vector axes within the fixed
tolerances. Probability gap was zero in every record.

| Fixture | Outcome | Peak states | Node elapsed |
| --- | --- | ---: | ---: |
| R0 / 60-120-900 | completed | 482,775 | 6,546.1 ms |
| R14e900 / 100-100-30 | completed | 750 | 80.7 ms |
| SR5 / 30-100-100 | completed | 2,628 | 109.2 ms |
| SR10 / 100-100-10 | completed | 87 | 47.3 ms |

[Confirmed] Exact closure evaluation on R10 / 300-300-300 reached 1,200,000 states and returned
`state_budget_exceeded`. The budget was not raised after observing the result, so this candidate
does not establish an exact replacement for the phase2 fallback.

[Confirmed] For bounded `4 passes x 256 updates`, nearest-rank p95 over four warm samples from the
same instance was 216.12ms for phase2 and 327.47ms for the candidate, a 1.515x ratio. This is much
lower than the TypeScript four-sweep ratio of 9.19x, but it fails both the pre-registered 1.5x
continuation screen and the product `max(+15%, +50ms)` gate. The small campaign is a rejection
screen, not a user-latency estimate.

The first exploratory latency run was discarded because it created a fresh instance for every
repeat but still removed only the first sample as if the remainder were warm. The values above are
from the corrected protocol, which reuses one baseline instance and one candidate instance and
discards each instance's first allocation.

[Confirmed] The isolated candidate WASM was 131,426 bytes; the product WASM from the same checkout
was 99,937 bytes. The candidate exceeds the 115,000-byte product budget. Because exact capacity,
bounded latency, and size failed independently, the study stopped without selecting favorable
exact-interactive outcomes. The product artifact and runtime wiring remain unchanged.

## Unverified Scope

- [Unverified] Exact candidate evaluation for `R0-balanced300` did not complete within this study;
  its baseline alone takes about 812 seconds in the exhaustive evaluator.
- [Unverified] Fully converged exact-interactive evaluation for `SR0-balanced300` exceeded the
  five-minute budget. The four-sweep result is an approximate policy, not a converged value.
- [Unverified] Performance screening used one Windows/Node environment and five measurements per
  candidate. Browser, Android, and tail campaigns were not run because the candidate failed the
  first performance screen.
- [Unverified] Synthetic and historically aggregated scenario definitions are not user-frequency
  estimates.
- Exact evaluator elapsed time is exhaustive research cost, not one user solve latency.

## Reproduction

The analysis notebook and candidate WASM are generated under local `output/` and are not included
in the public repository. The runners and decision documents below are the public reproduction
contract.

```powershell
npm run test:bench
npm run bench:phase2:action-order
npm run bench:phase2:gated-cvar:screen
npm run bench:phase2:gated-cvar:interactive
npm run bench:phase2:successor-closure
npm run bench:phase2:sparse-pi
npm run bench:phase2:sparse-pi:interactive
npm run bench:phase2:sparse-pi:performance
npm run build:solver-wasm:sparse-pi
npm run bench:phase2:sparse-pi:rust
```

Large JSON outputs are generated under `benchmarks/results/`; analysis notebooks and candidate WASM
artifacts are generated under `output/`. Both locations are gitignored. The values in this report
were checked against local artifacts regenerated from the current code.
