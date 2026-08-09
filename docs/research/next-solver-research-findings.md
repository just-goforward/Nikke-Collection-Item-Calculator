# Next Solver and WebGPU Research Findings

- Date: 2026-08-09
- Baseline: `H=0.75`, `p=3`, `tau=0`
- Scope: research only; no product solver, UI, Worker protocol, or D1 schema change
- Final decision: adopt no candidate and retain the current Rust min-E[f]/phase2 ladder

## Research Contract

This study does not claim that no better algorithm can exist. It evaluates each candidate under the
same correctness, quality, and performance contract and stops dependent work when a prerequisite
gate fails.

- `[confirmed]` CPU f64 exact evaluation owns every final product action, probability, and cost.
- `[confirmed]` WebGPU performs only integer state expansion and deduplication. It does not evaluate
  probabilities or costs.
- `[confirmed]` Raw pieces remain the availability-cost denominator; bounded uses are used only in
  compact keys.
- `[confirmed]` A tiny complete-policy oracle and real Rust WASM parity tests protect the compact DP.
- `[inference]` Passing a tiny fixture does not prove product-range completeness or performance.

## Shared Exact Foundation

`compact-exact-graph.ts` builds a DAG whose stock-use rank decreases by exactly one on every edge.
It canonicalizes R15 to SR5 and records every valid action's success and failure edges. Reverse
Bellman evaluation preserves the current min-E[f] probability gate, cost, and total-use tie-break.

- `[confirmed]` On `SR10e2900 / 30·30·30`, the compact DP and product Rust WASM agree on action,
  success probability, maximum success probability, expected cost, and all three vector axes.
- `[confirmed]` Exhaustively enumerating all three deterministic policies of a four-state tiny graph
  also matches the compact DP root.
- `[confirmed]` Graph budget exhaustion, uncertifiable numeric intervals, and unavailable devices
  fail closed with typed outcomes.

## Candidate Results

| Candidate | Execution | Decision | Main evidence |
| --- | --- | --- | --- |
| Complete policy enumeration | Completed | Research oracle passed | Four states and three policies matched exact DP; not a product candidate |
| LP/column-generation oracle | Incomplete | `verification_incomplete` | Emitted a 4-state occupancy MPS, but no HiGHS executable was configured |
| WebGPU compact exact hybrid | Completed | `rejected` | Small key-set parity passed; R10 exceeded the 1.2M exact-state ceiling |
| Certified limited depth | Completed | `rejected` | Depths 1/2/4/8 did not certify the R10 or SR0 root action |
| AO*/BRTDP | Prerequisite stop | `rejected` | Representative roots were not separated by the admissible intervals |
| Pareto-frontier DP | Completed | `rejected` | p95 frontier width was 184 on a small graph, above the limit of 32 |
| Monotonicity/threshold proof | Sampled | `verification_incomplete` | No sampled counterexample, but no global proof |
| Symbolic decision diagram | Completed | `rejected` | 127 states remained 127 exact partitions, for 0% reduction |
| GPU rollout MCTS | Prerequisite stop | `rejected` | The exact WebGPU path failed its state-capacity gate |
| Distributional chance constraint | Prerequisite stop | `rejected` | The Pareto representation failed its width gate |
| Adaptive H/p robust risk | Prerequisite stop | `rejected` | Its distributional prerequisite did not pass |

Passing `complete_policy_enumeration` means that it can serve as a research oracle. It does not mean
that the oracle is deployable product logic. The report therefore records product grade separately
from `prerequisitePassed`.

## WebGPU Measurements

The desktop run used real Chrome 151 on an AMD RDNA 2 adapter.

- `[confirmed]` CPU and GPU expansion of 12 selected keys from the 127-state/144-edge fixture
  produced the same sorted set of 24 output keys.
- `[confirmed]` Setup was 395.7ms; allocation-warm p50 was 2.5ms and p95 was 3.5ms.
- `[confirmed]` The `R10-balanced300` census reached 37 layers, 1,162,033 accumulated states, and a
  maximum frontier of 87,690. The next layer would exceed the preregistered 1,200,000-state ceiling,
  so the run returned `budget_exceeded`.
- `[confirmed]` The census took 937.0ms.
- `[inference]` GPU expansion works, but this exact graph representation cannot reach the CPU f64
  Bellman stage within the registered capacity. The ceiling was not raised after seeing the result.
- `[unverified]` These timings are screening measurements from one PC, not a user latency distribution.

The Android runner was implemented, but the installed Chrome 147 package on Android user 0 of the
connected SM-G781N had no resolvable VIEW activity. Samsung Internet was not substituted as Chrome
evidence. Android WebGPU key-set and device-loss validation therefore remain unavailable.

## Limited-Depth and Structural Screens

### Certified limited depth

- `[confirmed]` Near-terminal `SR14e2900 / 10·10·10` was certified from depth 1.
- `[confirmed]` `R10-balanced300` remained `numeric_ambiguous` after 2,640 expanded states at depth 8.
- `[confirmed]` `SR0-balanced300` remained `numeric_ambiguous` after 2,662 expanded states at depth 8.
- `[inference]` The current conservative intervals are too loose to justify an AO*/BRTDP product
  implementation on representative fallback roots.

### Pareto, monotonicity, and symbolic compression

- `[confirmed]` The 127-state fixture produced 3,883 Pareto vectors, p50 width 1, p95 width 184, and
  maximum/root width 756. The preregistered p95 limit was 32.
- `[confirmed]` Sampled inventory lines for `SR14e2900` and `R14e900` varied each kit from 0 to 12 uses
  while fixing the other kits at 4 uses. They contained no success-monotonicity violation or
  re-entrant action pattern.
- `[unverified]` The sampled result is not a threshold proof over every state and inventory.
- `[confirmed]` Exact transition-and-value partitioning produced 127 partitions for 127 states: 0%
  reduction and zero exact-value mismatches.

## Product Decision

- `[confirmed]` No candidate was adopted.
- `[confirmed]` Product runtime, `public/solver_rs.wasm`, public API, UI, Worker, D1, and telemetry are
  unchanged.
- `[inference]` This does not show that WebGPU can never accelerate the solver. It shows that this
  exact graph contract did not expand the product range under the 1.2M-state ceiling.
- `[inference]` AO*/BRTDP, MCTS, distributional, and adaptive H/p were stopped by preregistered
  prerequisites; they were not silently omitted.
- `[unverified]` Stronger admissible bounds, a different exact state representation, an accessible
  Android Chrome target, and an external HiGHS solver require a new protocol.

## Related Records

- Phase2 methodology and bounded candidates: [`phase2-methodology-findings.md`](./phase2-methodology-findings.md)
- Phase2 evidence ledger (Korean): [`phase2-next-research-ledger.ko.md`](./phase2-next-research-ledger.ko.md)
- H/p joint-optimization results: [`min-ef-hp-study-findings.md`](./min-ef-hp-study-findings.md)

## Reproduction

```powershell
npm run test:bench
npm run bench:next-solver:lp-oracle
npm run bench:next-solver:webgpu-frontier
npm run bench:next-solver:webgpu-android
npm run bench:next-solver:limited-depth
npm run bench:next-solver:structure
npm run bench:next-solver:finalize
```

Raw reports are generated under the gitignored `benchmarks/results/` directory. Tracked files retain
the candidate contract, runners, verification tests, and these findings.
