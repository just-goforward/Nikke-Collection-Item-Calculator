# Rust Phase2 Methodology Findings

Korean documentation:
[`phase2-methodology-findings.ko.md`](./phase2-methodology-findings.ko.md)

Date: 2026-08-09

Research baseline: `45fc4175c332cb5d9656d86ae3f30fe6e4c5e527`

Phase2 result checkpoint: `99331dbf00632e2ac83b6930c6213766908e895a`

Scope: research-only Rust/WASM ABI, TypeScript evaluators, benchmarks, and decision records

## Decision

[Confirmed] No Rust phase2 methodology candidate is currently eligible for product adoption. The
product runtime, UI, Worker protocol, D1 schema, and solver policy version remain unchanged.

- A cap-offset state extension was rejected because it restores no mathematically distinct state.
- Changing min-E[f] action traversal order changed node counts by only tens and did not move any
  completion boundary.
- B0-based branch-and-bound passed correctness, one capacity recovery, WASM-size, and memory gates,
  but was 1.93x slower than phase2 on the hard fixture and was rejected.
- Corrected exact sparse policy iteration matched min-E[f] on small fixtures, but exceeded the
  1.2-million-state budget on `R10-balanced300`.
- The Rust max-path bounded candidate improved SR0 resource quality, but regressed R10 and failed
  all four direct latency campaigns and the 115KB WASM budget.
- Full recorded CVaR exceeded memo capacity on all 21 product-fallback states where it was tried,
  recovered through phase2, and changed no exact result.
- Forcing every recommended run to one reduced expected manual entries, but regressed R10 F and
  total consumption while the added confirmation and recalculation burden remained unmeasured.

## Candidate Audit

| Candidate | Research question | Confirmed result | Decision |
| --- | --- | --- | --- |
| A. Phase2 cap offset | Does preserving clipped stock as an offset restore useful phase2 information? | An independent recurrence matched `capStockForState` for every nonterminal state across 960 encoded states and three kits | Rejected |
| B. Sparse constrained PI | Can exact improvement of only necessary phase2 states cover min-E[f] fallback inputs? | The TypeScript candidate showed quality signal but was slow; the prioritized Rust candidate failed exact R10 capacity, bounded latency, and WASM-size gates | Rejected |
| C. min-E[f] action order | Can traversal order reduce `MEMO_FULL` outcomes? | Six permutations preserved action, success bits, and cost bits; node deltas were 6 to 56 with no outcome change | Rejected |
| D. Gate-aware CVaR | Can a tail objective preserve the product's success and resource constraints? | Two one-step changes failed the joint gate; the full recorded policy failed capacity on all 21 product-fallback attempts | Rejected |
| E. Branch-and-bound | Can an admissible lower bound reduce min-E[f] state pressure? | B2 passed semantic, capacity, memory, and WASM gates but regressed hard-fixture p95 by 1.93x | Rejected |
| F. Single-use batching | Can one-use runs reduce manual input without increasing resource burden? | Expected manual input fell by about 0.15, but R10 F and total use regressed and interaction burden was unmeasured | Rejected |

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

[Historically confirmed] The one-step CVaR candidate was restricted to actions inside the phase2
maximum-success gate. Only `R10-balanced300` and `SR5-observedPurpleHigh` changed root action in the
122-root screen.

| Fixture | Interactive P delta | Interactive F delta | Total-use delta | Rejection reason |
| --- | ---: | ---: | ---: | --- |
| R10-balanced300 | 0 | +0.0009873 | +2.2575 | Burden and total consumption regressed |
| SR5-observedPurpleHigh | about +1 ulp | -0.005313 | -8.8477 | Blue exhaustion probability increased by 0.004558 |

[Historically confirmed] Neither one-step root signal preserved success, mean burden, total
consumption, and per-kit exhaustion under the joint product gate.

[Confirmed] The follow-up ran Rust's full recorded CVaR policy with `alpha=0.9` and
`eta={0,0.05,0.1,0.2,0.4,0.8,1.6}`. Of 122 roots, 115 completed and seven exceeded the current
1,000,000-slot memo. A recorded policy passed the tail, success, and mean guardrails on 29 roots,
but only `SR10-skewPurple` changed first action or run. The product ladder solves that input with
min-E[f] first, in 168 states.

[Confirmed] In exact product-fallback evaluation, all four CVaR attempts for `R10-balanced300` and
all 17 attempts for `SR0-balanced300` failed with status 2 and recovered through phase2. Success,
F, total consumption, and per-kit exhaustion remained identical to baseline, with zero CVaR
decision changes.

[Decision] Full recorded CVaR under the current memo and finite eta grid does not improve the
product fallback. This does not prove that every CVaR objective is useless; a larger state
representation or a different tail objective requires a new capacity and performance contract.

### Prior H/p Supply-Debt Tail Decision

[Confirmed] The separate `min-ef-hp-study-findings.md` screened 49 H/p combinations under current
raw-pieces semantics and completed 176 exact records for a 16-candidate shortlist. The only tail
challenger to baseline `H0.75-p3`, `H0.5-p3`, increased max-kit supply-debt CVaR90 on
`R0-balanced150` from 76.4861 to 85.9952 days, a 9.5091-day Holm-adjusted significant regression.
The baseline was retained. This is a decision over the fixed grid and current tail panel, not a
proof of optimality over every possible risk objective.

## E. Admissible Branch-And-Bound

[Confirmed] The immediate-consumption B0 bound uses nonnegativity and monotonicity of terminal
cost. Exhaustive small-state checks confirmed that it never exceeds the actual continuation cost.
Corrected B2 added a compact maximum-success oracle, matched the phase2 oracle bit-for-bit on four
hard fixtures, and changed the existing `MEMO_FULL` result for `SR0 / 350,300,150` to completed.

| Item | Result |
| --- | --- |
| Tier-22 linear-memory growth versus product | +64.00MiB, inside the pre-registered +66MiB cap |
| Candidate WASM | 110,336 bytes, inside the 115KB budget |
| `R0 / 60,120,900` warm p95 | 199.81ms to 139.61ms, ratio 0.70 |
| `R0 / 250,250,250` warm p95 | 1,576.39ms to 3,042.48ms, ratio 1.93 |

[Confirmed] The hard fixture exceeded the `max(+15%, +50ms)` latency gate by a wide margin. A
small input can save more pruning work than the oracle costs while a large input does the reverse.
The study therefore does not generalize B0/B2 into a product-wide improvement. Browser and Android
measurements were skipped under the pre-registered stop rule.

## Sparse Constrained Policy Iteration

> **Current correction:** The root, interactive, and latency tables below describe observations
> from the legacy TypeScript prototype whose completion test was unsound. States discovered after
> an iteration began could remain unscanned while the run still returned `completed`. The former
> convergence interpretation is withdrawn. The current exact baseline saturates the closure first
> and scans every state in every iteration; `phase2-next-research-ledger.ko.md` and
> `sparse-policy-exact-baseline-v2.json` own that result.

The initial policy is phase2. The evaluator computes exact raw-stock terminal cost under the
current policy, expands the successor closure of alternative actions within the phase2
maximum-success gate, and replaces only states with a strict cost improvement. Exact ties preserve
the existing action. Iteration, state, and time limits produce typed outcomes.

[Confirmed] The corrected implementation scanned the complete closure on every iteration for four
small semantic fixtures and matched Rust min-E[f] in action, success probability, cost, and the
three-axis expected-consumption vector. `R10-balanced300` returned `state_budget_exceeded` at the
fixed 1.2-million-state budget. The legacy root table below is not a result of that corrected run.

### Legacy Root Screen (Pre-Correction Prototype)

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

### Legacy Interactive Results (Not Evidence of Exact Convergence)

The candidate follows the product ladder: a completed min-E[f] result is retained, and sparse PI
is invoked only where min-E[f] fails.

| Fixture | Sparse mode | P delta | Interactive F delta | Total-use delta | Exhaustion delta | Expected manual-entry delta |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| R10-balanced300 | legacy `completed` | -1.11e-16 | -0.0000195441 | -0.00737312 | blue -0.0000925147 | -0.0401802 |
| R0-observedBalanced | legacy `completed` | 0 | 0 | 0 | all zero | 0 |
| SR0-observedPurpleHigh | legacy `completed` | 0 | 0 | 0 | all zero | 0 |
| SR0-balanced300 | four sweeps | -1.11e-16 | -0.00312231 | -0.302357 | blue -0.00349444 | +0.533577 |

[Historically confirmed] The legacy R10 observation showed a signal in F, total consumption, blue
exhaustion, and manual-entry burden within the `1e-12` success tolerance. The corrected exact run
exceeds the closure budget on that input, so this is not evidence of an exactly converged policy
improvement. The four-sweep SR0 record is also approximate and increases expected manual entries.

### Legacy Performance Screening

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

[Confirmed] Under the same bounded budget of `4 passes x 256 updates`,
`max_path_probability` produced a lower final phase2-policy E[F] than `discovery_order` on all three
screening fixtures. This is a bounded-update ordering win, not exact convergence or product
adoption.

[Confirmed] Exact product-ladder evaluation kept R10 success unchanged but regressed F by
`+0.0010308173`, total expected uses by `+0.1342049927`, and blue exhaustion by `+0.0002999188`.
SR0 improved F by `-0.0027377024`, total uses by `-0.2987284709`, and blue exhaustion by
`-0.0025905029`, while expected manual entries increased by `+0.2029253483`. The scenario-level
hard gate does not offset the R10 regression with the SR0 improvement.

[Confirmed] Direct fallback latency removed the common min-E[f] rung and collected 31 warm samples
per arm in two independent campaigns. R10 p95 ratios were 1.322 and 1.368; SR0 ratios were 1.185
and 1.162. All four exceeded `max(+15%, +50ms)`. The isolated candidate WASM was 133,089 bytes,
18,089 bytes over the 115,000-byte product budget.

[Decision] Exact R10 capacity, R10 interactive quality, direct latency, and WASM size failed
independently. The candidate was not wired into the product runtime, and `public/solver_rs.wasm`
remains unchanged.

## Single-Use Batching

The experiment preserved the action chosen by the current min-E[f]-to-phase2 ladder but forced the
recommended run count to one, causing a new solve after every use.

| Fixture | P delta | Interactive F delta | Total-use delta | Blue-exhaustion delta | Manual-entry delta | Solve-call delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `R10-balanced300` | 0 | +0.0000000475 | +0.0000809789 | -0.0000000949 | -0.1475407801 | +292 |
| `SR0-balanced300` | +2.22e-16 | -0.0001656483 | -0.0292006848 | -0.0006787112 | -0.1526720255 | +976 |

[Confirmed] Expected manual entries fell by about 0.15 in both scenarios. R10 nevertheless
regressed F and total use and had no strict success/F benefit, so it failed the joint quality gate.
The evaluator also does not measure added user confirmations, recalculation clicks, or perceived
interaction burden. The candidate is rejected on resource quality before that unmeasured tradeoff
could be considered.

## Per-Kit Exhaustion Objective

Per-kit exhaustion is the vector
`g=(P[blue<10], P[purple<10], P[yellow<10])`. If a policy protects blue by consuming more purple,
there is no natural total order without user-provided weights or a lexicographic priority. This
study did not invent such weights. Instead, componentwise non-regression was a product guardrail.
No H/p-tail, bounded-hybrid, CVaR, or single-use candidate passed that guardrail together with all
other product gates. This does not prove that no Pareto candidate exists; it avoids silently adding
an undefined user preference to the solver.

## Next-Generation Solver And Platform Follow-Up

[Confirmed] After closing the phase2 methodology candidates, separate contracts evaluated
complete-policy and HiGHS LP oracles, layer streaming, backward exact pruning, strong bounds and the
AO*/BRTDP prerequisite, Lagrangian columns, global monotonicity, exact DAG abstraction, certified
approximation, distribution compression, WASM SIMD and threads, and WebGPU.

- Complete-policy enumeration and a three-stage HiGHS 1.14.0 occupancy LP matched compact exact DP
  on small and medium fixtures and remain independent research oracles.
- Layer streaming reduced logical payload by 72.46% without reducing hard-graph state work, while
  backward pruning collapsed no state before capacity exhaustion.
- Strong bounds did not certify representative R10/SR0 cost actions at depth eight. Lagrangian exact
  pricing expanded successor closure beyond 890,000 states.
- Unlike the initial root sample, internal exact policies contained 13,679 re-entrant action lines,
  rejecting a global threshold rule. Exact DAG reduction was 27.73% on R10, below the 30% gate.
- Strict distribution covers, certified approximation, SIMD, threads, and WebGPU failed their error,
  speed/size, deployment/memory, or state-capacity gates.

[Decision] No follow-up candidate qualified for product adoption, so the current Rust min-E[f] to
phase2 ladder remains unchanged. This is a decision about the implemented candidates and registered
contracts, not a proof that every possible algorithm is inferior. See
[`next-solver-research-findings.md`](./next-solver-research-findings.md) for measurements and
unverified scope.

[Confirmed] Only reusable exact oracles and generic measurement tools from the follow-up campaign
remain as code. Dedicated rejected-candidate implementations/runners and bulk artifacts are not
Git-tracked; findings and the evidence ledger retain the decisions and key measurements. Therefore,
not every follow-up figure is replayable from a clean checkout.

## Unverified Scope

- [Unverified] Branch-and-bound, bounded hybrid, and full recorded CVaR failed earlier Node,
  quality, or size gates and were not measured in browsers or on Android.
- [Unverified] Full CVaR covers alpha 0.9, seven eta values, and the current 1,000,000-slot memo. It
  does not generalize to a larger memo or a different tail-risk definition.
- [Unverified] The exact evaluator does not measure the added confirmation and recalculation burden
  of single-use batching.
- [Unverified] No user weighting or priority order has been defined for the per-kit exhaustion
  vector.
- [Unverified] Synthetic and historically aggregated scenario definitions are not user-frequency
  estimates.
- Exact evaluator elapsed time is exhaustive research cost, not one user solve latency.

## Reproduction

Candidate WASM and large reports for the Phase2 candidates below are generated in local gitignored
paths. These runners and decision documents are that stage's public reproduction contract.
Authoritative stage hashes are recorded in `phase2-next-research-ledger.ko.md`.

```powershell
npm run test:bench
npm run bench:phase2:action-order
npm run bench:phase2:branch-bound:latency
npm run bench:phase2:gated-cvar:screen
npm run bench:phase2:gated-cvar:interactive
npm run bench:phase2:recorded-cvar:screen
npm run bench:phase2:recorded-cvar:interactive
npm run bench:phase2:single-use-batching
npm run bench:phase2:successor-closure
npm run bench:phase2:sparse-pi
npm run bench:phase2:sparse-pi:exact-baseline
npm run bench:phase2:sparse-pi:interactive
npm run bench:phase2:sparse-pi:performance
npm run build:solver-wasm:sparse-pi
npm run bench:phase2:sparse-pi:rust
npm run bench:phase2:prioritized-policy
npm run bench:phase2:bounded-hybrid:quality
npm run bench:phase2:bounded-hybrid:performance
```

Large JSON outputs are generated under `benchmarks/results/`; candidate WASM artifacts are generated
under `output/`. Both locations are gitignored. This report distinguishes fingerprinted current
artifacts from records explicitly labeled as legacy evidence.
