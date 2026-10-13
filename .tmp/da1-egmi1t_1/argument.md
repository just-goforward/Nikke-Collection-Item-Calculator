# Certified solver: structural correctness argument

## Scope, identity, and labels

Source inspected at HEAD `80260350a715f09300366f38fbe96cf025c1636c`. The working tree was dirty: `.github/dependabot.yml` modified; `.certified-test-tmp/`, `.mixdog/`, `.tmp/`, and `scripts/certified-staging-approved-panel/v5/draft-5GoiTZ/` untracked. These are not evidence of solver correctness. This document is a static argument, not an execution report or machine-checked proof. No project code, tests, build, or benchmark was executed.

**PROVED** means a mathematical implication justified below, under its stated assumptions, or a direct source-level contract. **ARGUED** means an informal implementation correspondence, not a complete proof. **NOTRUN** identifies an unproved obligation or unexecuted validation. In particular, an ARGUED correspondence does not discharge its associated NOTRUN universal verification obligation.

The separate proofs for the six recorded groups, 48 intervals, and 33 prefix endpoints, and separately labelled samples, are outside this artifact. Their completion is **NOTRUN** here. This document alone does not establish the user's three-part full-correctness criterion.

## 1. Accepted domain

**PROVED — visible validation contract.** `src/certified/validation.ts` `validateState`, `validateTriple`, `validate`, and `validateSnapshot` require:

- grade R or SR; safe-integer level 0 through 15;
- safe-integer EXP, nonnegative, divisible by 100, strictly below 1000 for R or 3000 for SR; level 15 requires EXP 0;
- exactly three stock coordinates, each a safe integer 0 through 100000; the same check for `priceBasisStock ?? stock`;
- finite `Date.parse(asOf)` (not a promise of one canonical textual timestamp);
- absent batch limit or safe integer 1 through 1000;
- three parsed rational cohort weights, nonnegative and summing exactly to one, defaulting to thirds;
- successful `assertCertifiedSupplySnapshot`, version `certified-daily-v1`, snapshot and input timestamps equal as parsed instants, at most 2048 events and 256 rules;
- unique event IDs, parseable event timestamps, safe-integer event offsets, safe-integer reference counts 0 through 64, and dispatch-board counts at most one.

These are necessary conditions, not an exhaustive replacement for delegated snapshot/rational validation. **NOTRUN — full transitive schema proof:** `assertCertifiedSupplySnapshot` and rational decoding are additional gates; this argument has not audited every delegated malformed-input case. The oracle's `OracleInput` in `scripts/certified-staging-oracle.ts` is a typed numerical evaluator, not an independent implementation of that complete public validator.

**PROVED — acceptance is not guaranteed completion.** `src/certified/pricing.ts` `calculatePricing` adds pricing-domain gates: weights are reciprocal of raw basis stock plus recurring rate; zero denominator is permitted only when `futureUsable` is false. `FiniteKernel` uses work-budget checks, and Rust `Engine::new` checks work limits. Thus “full supported domain” cannot mean every syntactically valid request returns an exact answer within resource limits. Universal successful termination of the deployed service is **NOTRUN**.

## 2. Canonical states and whole uses

**PROVED — model equivalence.** `shared/game.ts` `failOnce`, `greatSuccessState`, `nextBoundary` specify ordinary EXP gains 200/500/1000 and discarding excess EXP at levels 5/10/15. `src/certified/game.ts` `encode` maps R15 directly to state 300 = SR5 EXP0 and SR15 to terminal 600. The oracle `canonicalState`, `independentSuccess`, and `independentFailure` make the same free conversion. `src/solver/domain.ts` instead exposes R15 and `convertState` explicitly; it is not itself the certified graph encoder. Conversion has no inventory cost. Terminal value is P=1 and all expected future costs/consumption zero.

At fixed prices, write pieces as `10u+r`, with `0 <= r < 10`. Feasibility of an action is exactly `u_k >= 1`; consuming ten pieces subtracts one use and preserves r. Induction over any action history therefore gives identical feasible actions, transitions, and rewards for inventories with identical u. Consequently the complete endpoint `(P,B,C,consumed,mask,chosen)` is identical under a common tie convention. Evidence: certified `capUnits`, oracle `createOracleEvaluator` (tests stock below ten and subtracts ten), legacy `stockToUses`.

**NOTRUN — stronger remainder claims.** This quotient must not be applied to raw price basis, or before future receipts without retaining remainders: nine pieces plus one receipt unlocks a use. It does not prove equality between requests whose raw stock changes their prices.

## 3. Saturation and deterministic ties

**PROVED — all-path cap theorem for the certified graph.** Let D_j(s) be the maximum number of j-actions on any positive-probability path from s, allowing every action regardless of inventory and allowing STOP. The graph is finite and forward. Thus

`D_j(terminal)=0; D_j(s)=max(0, max_{k,t positive child of k}(1[k=j]+D_j(t)))`.

This is precisely the reverse-state construction of `CAPS` in `src/certified/game.ts`, which excludes zero-mass edges and rejects backward positive edges. Every feasible path uses at most D_j(s) pieces-of-ten of color j. Replacing u_j by min(u_j,D_j(s)) therefore removes no feasible path: where a coordinate was reduced, every path already obeyed that bound; where it was not reduced, its original constraint remains. The policy trees and their outcome probabilities, immediate costs, and consumed-piece vectors coincide. This argument also applies at every reachable subproblem, not merely the root.

Inductively, each candidate has the same P/B/C and selected-child consumption vector. Comparing in the same order STOP, blue, purple, yellow gives the same strict improvements and equalities, hence the same full tied mask and first chosen action. Retaining the incumbent consumption vector on equality gives the same consumed vector even when tied policies have different per-color consumption. This establishes full-endpoint preservation for exact Bellman evaluation at fixed prices, not merely equality of the primary objective. Source evidence: `FiniteKernel.action`, `FiniteKernel.unlimited`, `compareValue`; oracle `createOracleEvaluator` initializes STOP, iterates colors in that order, replaces only on strict improvement, and appends exact ties.

**NOTRUN — requested legacy cap universal correspondence.** `src/solver/domain.ts` `worstCaseUsesNormalized` follows only repeated ordinary outcomes of one kit, with free conversion and a guard returning infinity; `capStockForState` clamps separately to these counts. This is not the certified all-action/all-positive-branch CAPS recurrence. An additional monotonicity proof is required that interleaving other colors or great successes cannot increase the possible count of that kit, despite boundary EXP discard. No equality between those legacy caps and all-path caps is asserted here. Consequently preservation of the full endpoint, including first ties at every subproblem, by that legacy routine is **NOTRUN**, not inferred from its name or from a sampled test.

## 4. Bellman induction

**PROVED — exact recurrence.** For a nonterminal state/inventory, STOP has `(0,0,0)` and zero vector. For feasible kit k with great probability p and child optimum V:

`P_k=p P_g+(1-p)P_n`

`B_k=10 w_k+p B_g+(1-p)B_n`

`C_k=10+p C_g+(1-p)C_n`

`consumed_k=10 e_k+p consumed_g+(1-p)consumed_n`.

Terminal is `(1,0,0)`. `src/certified/value.ts` `compareValue` and the oracle function of the same name maximize P, then minimize B, then minimize C exactly.

Induct on decreasing state ID: positive-mass children have larger IDs, and terminal is the base case. Conditional on the first action, any continuation decomposes into the two child policies. Replacing either child by its lexicographic optimum cannot worsen the weighted sum: improvements in the first differing coordinate remain improvements under positive multiplication; zero-probability children are irrelevant. Taking the maximum over STOP and feasible actions therefore attains the optimal value. Randomization cannot improve on the lexicographic maximum of finitely many candidates. Fixing first ties recursively makes the selected policy and its consumed vector deterministic.

**ARGUED — basic source correspondence.** `FiniteKernel.action` implements exact weighted sums and a common positive burden scale; Rust `Engine::compare`, `Engine::combine`, `Engine::lift` use integer numerators on denominator powers of 1000, deriving burden from consumed coordinates. The oracle uses separately implemented reduced rational arithmetic and an uncapped inventory recursion.

**NOTRUN — optimized implementation refinement.** A complete proof of `IntegerFiniteTable`, `GuidedFiniteTable`, completion shortcuts, bounds/pruning, memoization, and their Rust equivalents preserving all six endpoint components is not supplied. The mathematical recurrence proof must not be mistaken for verification of every optimization or allocation/error path.

## 5. Price dependence

**PROVED — finite policy comparisons.** For fixed state and finite inventory the acyclic graph has finitely many deterministic policy trees. For each fixed policy pi, P_pi and the expected consumption vector d_pi do not depend on prices; `B_pi(w)=sum_j w_j d_pi,j` is linear and `C_pi=sum_j d_pi,j` is price-independent. Policies with smaller P can first be discarded. Among maximal-P policies, each remaining burden comparison is a linear inequality; on equality C and then the recursive first-tie convention decide. There are finitely many such comparisons, hence a finite partition into price regions and equality boundaries.

The source recurrence above and oracle `weighted`/`createOracleEvaluator` provide the coefficients' semantics. **NOTRUN — universal region certification:** no complete list of policies, coefficients, hyperplanes, or boundary tie proofs has been computed. The theorem neither makes optimal B globally linear nor proves samples between tested prices preserve a policy. Changing stock changes both feasible policies and, without explicit fixed basis, prices. Default/snapshot-derived price coverage is not established by this theorem.

## 6. Batch and waiting envelopes

**PROVED — prefix contract conditional on exact endpoint answers.** `src/certified/current.ts` `currentView` chooses the first set root mask bit, then repeats that original kit only while it remains optimal along the ordinary-outcome path. It stops after the consumed action if great success was certain, terminal was reached, or grade/level changed, and at `batchLimit ?? 10`. The oracle `scripts/certified-staging-oracle-lane.ts` `normalPathPrefix` does the same using independent child ties and fixed prices. Both include the boundary-crossing action. They do not promise that every random trajectory consumes the whole prefix; a great success interrupts this normal-path instruction.

**NOTRUN — unconditional batch equality:** product budget refusal during the loop truncates a prefix; oracle incomplete endpoint evaluation returns a not-computed reason. Full prefix equality presupposes all required endpoint computations complete. The 33 separately recorded endpoints are not checked here.

**PROVED — probability envelope theorem.** With nonnegative extra inventory, fixed prices, and the ability to ignore arrivals, the old policy remains feasible. Future optimal P is therefore at least current P and at most one. Averaging preserves `[P_current,1]`; improvement is bounded by `1-P_current`. These are probability bounds, not bounds fixing B/C, and not exact future expectations.

`scripts/certified-staging-oracle-certificates.ts` `boundaryEnvelope` requires boundary flag, range `[56,56]`, null waiting value, and those exact probability/gap fields. `verifyActualWaiting` additionally requires declared complete future coverage and conditional-independence semantics and checks the strict witness. **ARGUED — interpretation:** a verified positive-mass strict improvement from day 55 to 56, coupled with monotone optimal values, can rule out earlier equality with the day-56 optimum within that horizon. It proves neither a globally optimal date beyond day 56 nor the exact day-56 expectation. **NOTRUN:** general witness reconstruction, interior-day full expectation, and all envelopes; the checker explicitly returns NOTRUN for unsupported interior calculations, refresh cohorts, and finite law overrides.

## 7. Supply and cohorts

**PROVED — convolution identity under model assumptions.** Oracle `futureStockDistribution` fixes one latent cohort for the whole event sequence, initializes its mass with the prior, convolves independent-within-cohort receipts for events with day <= target, merges equal physical stocks by addition, then sums cohorts. By induction on events the resulting mass is the prior times the product of conditional receipt masses, summed over receipt histories. `averageOracle` is the law of total expectation of the endpoint values. This does not assume cohorts are independently redrawn each event.

**ARGUED — product correspondence.** `src/certified/distribution.ts` `singleton`, `convolve`, and `expectation` use per-cohort supports, exact rational multiplication/addition, and apply priors when averaging. Physical stocks are capped before storage but not prematurely divided into uses. For nonnegative receipts and a fixed cap M, `min(M,min(M,x)+y)=min(M,x+y)`, so intermediate physical saturation commutes with later arrivals; the all-path theorem justifies endpoint saturation. Below saturation, remainders must remain.

**NOTRUN — full supported snapshot path:** compilation of snapshot laws, actual event selection/received IDs/time zones, custom finite laws, all three cohort PMFs and recurring-rate pricing, Rust supply/waiting parity, and all budget/refusal cases are not universally verified here. Oracle certificate reconstruction explicitly supports only selected law families/cohort paths. Declared completeness and conditional independence are model assumptions, not facts about real-world arrivals proved by code.

## 8. Backend and oracle correspondence obligations

**ARGUED — intended shared contract.** Rust `rust/certified/src/lib.rs` `Init`, `Engine::new`, `Value`, `PublicValue`, `compare`, `combine`, and `lift` expose the graph/caps/prices and exact numeric contract corresponding to the JS kernel. Both must agree on validated/canonical input, graph edges/probabilities, caps, fixed prices, terminal/STOP, exact P/B/C, selected-policy consumption, root masks and first kit, prefix semantics, conditional supply mixtures, waiting claims, and refusal behavior. The oracle shares `shared/game.ts` probability data but independently implements transitions, arithmetic and uncapped Bellman evaluation: this is useful algorithmic independence, not independent confirmation of the underlying game data.

Existing test-source evidence (all **NOTRUN** in this assignment):

- `src/certified/kernel.spec.ts`: exact C tiebreak, zero-success preservation, exact action ties, rare positive success, fixed-price cap vector preservation.
- `src/certified/wasmBackend.spec.ts`: exact P/B/C, vectors, ties and prefixes; fixed pricing and H56 claims; conditional cohorts and partial support refusal; safe-integer arrivals; physical remainder grouping; zero-prior cohorts; bounded representative SR10/R0 parity; artifact substitution and resource/deadline handling.
- `scripts/certified-staging-oracle.spec.ts`: integer versus reduced-rational oracle, raw remainders, three objectives/ties, failure-branch costs, boundary EXP/R15 conversion, tiny exact gaps, and persistent latent cohorts.

These names establish intended checked properties, not current passing results or exhaustive domain coverage. WASM artifact identity, build-to-source correspondence, universal optimized-backend equivalence and actual test results remain **NOTRUN**.

## Summary

| Claim | Label |
|---|---|
| Visible validator constraints | PROVED |
| Full delegated schema / universal completion | NOTRUN |
| Canonical model and fixed-price whole-use equivalence | PROVED |
| Certified all-path cap full-endpoint theorem | PROVED |
| Legacy repeated-normal cap full-endpoint theorem | NOTRUN |
| Exact Bellman optimum / first-tie induction | PROVED |
| Optimized JS/Rust refinement | ARGUED; universal proof NOTRUN |
| Finite price-policy comparison theorem | PROVED |
| Complete price-region coverage | NOTRUN |
| Conditional normal-prefix semantics | PROVED |
| Waiting probability coupling envelope | PROVED |
| Full waiting certificates / snapshot parity | NOTRUN |
| Conditional cohort convolution identity | PROVED |
| Product supply implementation correspondence | ARGUED; universal proof NOTRUN |
| Existing backend/oracle tests executed here | NOTRUN |
| Separate recorded groups/intervals/prefix proofs and samples | NOTRUN here |

The structural model has the stated proofs; full product correctness over every supported input remains unproved at the explicitly identified implementation, legacy-cap, supply, and resource boundaries.
