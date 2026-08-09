# Next Solver and Platform Research Findings

- Date: 2026-08-09
- Baseline: Rust min-E[f] with Rust phase2 fallback, `H=0.75`, `p=3`, `tau=0`
- Scope: research only; no product solver, WASM, UI, Worker protocol, or D1 schema change
- Final decision: no product candidate; retain the current solver ladder

## Conclusion

`[confirmed]` The preregistered exact, approximate, structural-compression, mathematical-relaxation,
and WASM/WebGPU candidates were evaluated in sequence. None passed every current product exactness,
capacity, quality, and performance gate.

This is not a proof that every mathematically possible algorithm is worse. It means that the
implemented candidates failed their own stop conditions. A new product study now needs at least one
new premise: a stronger proven bound, an exact representation that applies before graph expansion,
an explicit objective change, or a different deployment contract.

## Evidence Contract

- `[confirmed]` CPU f64 exact evaluation owns final product actions, probabilities, and costs.
- `[confirmed]` Raw pieces remain availability-cost denominators; compact keys use bounded uses.
- `[confirmed]` Candidates terminate with typed outcomes such as `completed`, `budget_exceeded`,
  `numeric_ambiguous`, and `device_unavailable`.
- `[confirmed]` Bulk JSON/MPS/SOL output stays under gitignored `benchmarks/results/`. Tracked files
  retain reusable contracts, oracles, verification tests, and findings.
- `[inference]` Small-fixture parity and short timing campaigns do not prove product-range
  completeness or a user latency distribution.

Campaign finalization compared the kind, version, SHA-256, and decisions of all input reports and
left product authorization at `runtimeChangeAuthorized: false`. That finalizer artifact is not a
permanent Git asset.

## Independent Exact Oracles

`compact-exact-graph.ts` builds a DAG whose total stock uses decrease by one on every transition and
canonicalizes R15 to SR5. Reverse Bellman evaluation preserves the current min-E[f] probability
gate, availability cost, and total-use tie-break.

- `[confirmed]` Exhaustive enumeration of all three deterministic policies in a four-state graph
  matched compact exact DP.
- `[confirmed]` HiGHS 1.14.0 ran a three-stage occupancy LP: maximize reachability, minimize expected
  cost, then minimize expected uses.
- `[confirmed]` `SR14e2900-balanced10` (4 states/3 edges), `SR10e2900-balanced30` (127/144), and
  `R14e900-balanced10` (21/18) matched exact DP on action, reachability, cost, and uses within the
  registered tolerance.
- `[confirmed]` The LP is an independent research oracle, not a deployable product solver.

## Final Candidate Decisions

| Candidate | Decision | Main evidence |
| --- | --- | --- |
| Complete-policy enumeration | Oracle passed | Exhaustive tiny policies matched compact exact DP |
| HiGHS occupancy LP | Oracle passed | Three lexicographic LP fixtures matched exact DP |
| Layer-streaming exact DP | `rejected` | Logical payload fell 72.46%; state/edge work and hard capacity failure did not |
| Backward-distance exact pruning | `rejected` | Collapsed zero states before the hard capacity stop |
| Strong admissible bounds | `rejected` | Depth 8 did not certify the R10 or SR0 root action |
| AO*/BRTDP | `rejected` | Available bounds failed the prerequisite root-separation gate |
| Lagrangian relaxation/columns | `rejected` | Exact pricing expanded successor closure toward the full eligible graph |
| Global monotone threshold | `rejected` | Exact internal policies contained 13,679 re-entrant action lines |
| Exact DAG abstraction | `rejected` | R10 reduction was 27.73%, below 30%, and required prior graph expansion |
| Certified approximation | `rejected` | Depth-16 cost regret remained 0.0934/0.1693 |
| Pareto/distribution compression | `rejected` | Strict-cover p95 width was about 106, above 32 |
| Adaptive H/p risk | `rejected` | Strict distribution gate failed and the current H/p study kept baseline |
| WASM SIMD | `rejected` | Bit parity passed; WASM grew 197B and both warm speed gates failed |
| WASM threads | `rejected` | No COOP/COEP or shared layout; three independent instances need about 344.8MiB |
| WebGPU integer frontier | `rejected` | Small parity passed; the hard exact graph exceeded 1.2M states |
| GPU rollout/MCTS | `rejected` | The prerequisite GPU state path failed capacity before exact CPU confirmation |

## Exact State-Space Candidates

### Layer streaming and backward pruning

- `[confirmed]` Layer streaming was bit-identical on compact fixtures and reduced logical payload
  from 11,084B to 3,052B.
- `[confirmed]` `R10-balanced300` still reached 37 layers, 1,162,033 states, 3,452,202 edges, and a
  maximum layer width of 87,690 before the next layer exceeded the 1,200,000-state ceiling.
- `[inference]` This changes storage, not required state work, so it does not resolve the hard failure.
- `[confirmed]` Backward pruning exactly collapses states whose stock cannot satisfy an optimistic
  minimum action count. It preserved small-fixture parity but collapsed zero hard-run states.

### Strong bounds and AO*/BRTDP

- `[confirmed]` The study implemented an unlimited-color finite-horizon reachability upper bound, a
  fixed-inventory schedule lower bound, an unavoidable-use cost lower bound, and a guaranteed-schedule
  upper bound.
- `[confirmed]` Hard-root success intervals closed to zero width, but depth-8 cost intervals remained
  0.3067633 wide for R10 and 0.4516169 for SR0.
- `[inference]` The bounds cannot certify an exact root action early enough to justify adding a larger
  AO*/BRTDP implementation.

### Lagrangian relaxation and reachable columns

- `[confirmed]` A shared finite penalty `lambda=1000` reproduced exact root bits on four compact
  fixtures.
- `[confirmed]` On hard R10, the phase2 closure had 10,296 states. Exact improvement sweeps expanded
  it to 83,569, 276,843, 559,854, and 890,325 states; the full eligible set was truncated at 2M.
- `[inference]` Exact omitted-action pricing continually admits successors absent from the phase2
  policy, so the proposed column method does not avoid min-E[f]-scale growth.

## Structural and Approximate Candidates

### Monotonicity and exact abstraction

- `[confirmed]` The initial 1,458-root cube had no re-entrant action pattern.
- `[confirmed]` Scanning 141,682 internal exact-policy lines in SR10/R10 graphs found 13,679
  counterexamples. One `R10-balanced100:sid741` line changes as
  `yellow, blue, blue, blue, blue, yellow, blue, blue`.
- `[inference]` Global “switch once” inventory thresholds are not valid exact-pruning contracts.
- `[confirmed]` Value-independent exact DAG partitions reduced SR10 by 0% and R10 by 27.73%.
  R10 fell from 141,555 nodes to 102,300 partitions, below the 30% gate, and partitioning starts only
  after graph expansion.

### Certified approximation and distributions

- `[confirmed]` At depth 16, certified approximation expanded 53,722 R10 states with cost-regret
  upper 0.0933914 and 59,945 SR0 states with upper 0.1692542. Success-regret upper was zero for both.
- `[confirmed]` These cost bounds exceed the 0.001 research and 0.000001 product limits.
- `[confirmed]` Exact Pareto p95 width was 184 with maximum 756. A strict 0.1-piece-per-kit epsilon
  cover still had p95 about 106 and maximum 422.
- `[inference]` A one-piece cover reaches p95 12 but changes the exact product contract. It was not
  promoted without a user-requested trade-off objective.

## Platform Candidates

### WebGPU

- `[confirmed]` Chrome 151 on AMD RDNA 2 produced exactly the same 24 expanded keys as CPU for 12
  selected inputs.
- `[confirmed]` Setup was 384.6ms; samples were 5.2/3.9/2.8/3.4/2.7ms; warm p50 was 2.8ms and p95
  was 3.9ms.
- `[confirmed]` The hard census returned `budget_exceeded` at 37 layers and 1,162,033 states in 928ms.
- `[inference]` GPU execution can accelerate this representation, but cannot reduce its state count.

The connected SM-G781N (Android 13, ARM64, Chrome 147) exposed no resolvable Chrome VIEW activity
for Android user 0. `[unverified]` Android WebGPU survival and device-loss recovery remain untested.

### SIMD and threads

- `[confirmed]` A Rust 1.97.1 `+simd128` candidate preserved semantics but grew from 99,937B to
  100,134B.
- `[confirmed]` Warm paired-median ratios were 0.9850 for R0 and 1.0083 for SR5 versus required
  `<=0.97`.
- `[confirmed]` The GitHub Pages response observed on 2026-08-09 had no COOP/COEP, and there is no
  shared-memory solver layout. Three independent Workers duplicate the memo to about 344.8MiB.
- `[inference]` Threads require a separate deployment and memo-ownership design, not a low-risk flag.

## Product Decision and Remaining Scope

- `[confirmed]` No candidate was adopted; retain Rust min-E[f] with Rust phase2 fallback.
- `[confirmed]` `public/solver_rs.wasm`, runtime backend, public API, UI, Worker, D1, and telemetry are
  unchanged.
- `[confirmed]` Complete-policy and LP code remain independent research oracles, not product logic.
- `[inference]` Remaining theoretical work now requires a concrete new proof or representation; it is
  not a ready queue of low-risk implementations.
- `[unverified]` This study does not cover low-end/32-bit Android, accessible Android Chrome WebGPU,
  or a shared-memory solver under a cross-origin-isolated deployment.

## Related Records

- Phase2 methodology and bounded candidates: [`phase2-methodology-findings.md`](./phase2-methodology-findings.md)
- Phase2 evidence ledger (Korean): [`phase2-next-research-ledger.ko.md`](./phase2-next-research-ledger.ko.md)
- H/p joint optimization: [`min-ef-hp-study-findings.md`](./min-ef-hp-study-findings.md)

## Research Asset Retention Boundary

- `[confirmed]` The compact exact graph, complete-policy enumeration, HiGHS occupancy-LP
  exporter/parser, generic candidate latency measurement, and WebGPU frontier validation remain as
  reusable research infrastructure.
- `[confirmed]` Candidate implementations, dedicated runners/finalizer, and bulk JSON/CSV/MPS/SOL
  artifacts from the rejected second-wave campaign are not Git-tracked. Product runtime does not
  depend on them.
- `[confirmed]` Candidate decisions and measured figures remain in this report and the stage ledger.
  This does not mean every deleted one-off candidate can be replayed from a clean checkout.
- `[inference]` Reconsidering a rejected direction should start from a new isolated candidate against
  the current solver contract instead of restoring stale experimental APIs and assumptions.

## Retained Reproduction Contract

```powershell
npm run test:bench
npm run bench:next-solver:lp-oracle
npm run bench:next-solver:structure
npm run bench:next-solver:webgpu-frontier
npm run bench:next-solver:webgpu-android
```

`bench:next-solver:lp-oracle` requires `HIGHS_PATH` to point to a HiGHS 1.14.0 executable. Retained
runners write raw reports under gitignored `benchmarks/results/`.
