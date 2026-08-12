# min-E[f] Memo Grow-and-Resume Study

- Run date: 2026-08-12
- Baseline commit: `7e3d07130568e6312590b825dfcd1d2213dcbab3`
- Product baseline: `rust-min-ef` tier 21, then `rust-phase2` tier 22 on capacity failure
- Research contract: `H=0.75`, `p=3`, `tau=0`, min-E[f] node budget 4,000,000
- Scope: research only; no product runtime, WASM, UI, Worker protocol, or D1 schema change

## Decision

The candidate moved existing tier-21 memo entries into a tier-22 table after `MEMO_FULL` and resumed
the same exact min-E[f] search. It reduced median time by 31.7% to 41.6% versus restarting an exact
tier-22 solve, and all 24 common completions were bit-identical to fresh tier 22.

It nevertheless failed the product comparison. On `R10-balanced300`, end-to-end p95 increased from
901.883ms for the current phase2 fallback to 1,222.216ms, a 35.5% regression. The pre-registered gate
required every hard fixture to remain within `max(+15%, +50ms)`, so the candidate was rejected.

- `[confirmed]` The root prerequisite gate passed accuracy, completion, memory, and WASM-size checks.
- `[confirmed]` Three of four repeated fixtures beat the current ladder; one failed the p95 gate.
- `[decision]` Exact-interactive, browser, and Android gates were not run after the prerequisite failed.
- `[decision]` Candidate feature, ABI, and runners were removed; the product WASM was not changed.
- `[inference]` Reusing exact work is valuable, but not consistently faster than the current phase2 fallback.

## Mechanism

```text
Existing retry: tier 21 -> MEMO_FULL -> fresh tier 22 -> exact restart
Candidate:      tier 21 -> MEMO_FULL -> allocate tier 22 -> rehash entries -> resume
```

The candidate decoded packed memo keys into `(state, blue, purple, yellow)` and inserted them into the
larger table. This preserved completed work, at the cost of rehashing about 1.83 million entries and
temporarily retaining both allocations.

## Root Screening

The study used 218 roots: 122 discovery, 48 confirmation, 24 routing validation, and 24 new held-out
scenarios.

| Cohort | Roots | Tier-21 capacity failures | Resume completed | Fresh tier 22 completed | Bit parity |
| --- | ---: | ---: | ---: | ---: | ---: |
| Discovery | 122 | 5 | 2 | 2 | 2/2 |
| Confirmation | 48 | 11 | 8 | 8 | 8/8 |
| Validation | 24 | 9 | 7 | 7 | 7/7 |
| Held-out | 24 | 11 | 7 | 7 | 7/7 |
| Total | 218 | 36 | 24 | 24 | 24/24 |

Parity covered action, success/max-success, expected-cost, all three expected-consumption vector axes,
and every root candidate's validity, success, vector, and cost. Resume and fresh tier 22 both remained
capacity-limited on the other 12 roots.

- `[confirmed]` Rehash time was 135.7-152.8ms for 1,834,748-1,834,869 entries.
- `[confirmed]` Resumed searches reused 114,115-7,543,691 memo hits.
- `[confirmed]` All 36 failures passed the fresh-tier-22 plus 16MiB memory gate.
- `[confirmed]` Maximum additional page growth was 15,597,568B, approximately 14.88MiB.
- `[confirmed]` Candidate WASM was 106,140B, within the 115,000B budget.

## Repeated Performance

Each arm used 31 fresh-process samples in ABBA order. Candidate combined time includes the failed
tier-21 attempt, rehash, and resumed solve. Restart exact begins a fresh tier-22 exact solve after the
tier-21 failure. Current ladder is the product's phase2 recovery path.

| Fixture | Candidate p50 | Restart exact p50 | vs restart | Candidate p95 | Current ladder p95 | vs current | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `R10-balanced300` | 1,127.910ms | 1,695.087ms | -33.5% | 1,222.216ms | 901.883ms | +35.5% | Fail |
| `confirm-R3e400-balanced220` | 1,012.483ms | 1,588.572ms | -36.3% | 1,064.173ms | 1,845.071ms | -42.3% | Pass |
| `validate-R2e300-balanced205` | 838.062ms | 1,434.421ms | -41.6% | 925.435ms | 1,723.175ms | -46.3% | Pass |
| `grow-resume-R5e800-balanced260` | 1,252.226ms | 1,832.547ms | -31.7% | 1,310.219ms | 1,511.919ms | -13.3% | Pass |

Outcomes and semantic snapshots were stable across repeats. Every fixture passed the 20% median
improvement requirement versus exact restart and the resume-only p95 check. The sole final blocker was
`R10-balanced300` against the current product ladder.

## Provenance and Retention

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Product WASM after cleanup | 99,937 | `7430c32ae5f3f7c8845c8390568e1f49dcd25c43c67bbda74adb61202c41a8df` |
| Feature-off base from transient candidate source | 99,937 | `9cdd43bb8360b73451fec7d66c0b80a96d7340384f2f17de0546851b84dec856` |
| Grow/resume candidate | 106,140 | `9d95154b94972953db75fb378dc5647edd6b2ff2e353e1ec0624aad141cffb03` |
| Root report | - | `ea0d6e8706dabfab9d76fa886c574cfb890c398942c40e89ee830ab837c6700a` |
| Performance report | - | `daee1a7d8c5f2d8b21e4700605544e2a091d1690a2686d96bb1f5bba632da56a` |

The temporary base was built from the candidate source with its research feature disabled. Rebuilding
the product with default features after cleanup produced no Git diff. The local reports record the
baseline commit, dirty paths, source fingerprint, per-file hashes, Node `v24.19.0`, and Windows x64.
Bulk JSON and candidate WASM remain gitignored local evidence. Because the candidate was rejected, its
feature, ABI, build script, and dedicated runners are not retained. The
tracked assets are the reusable 218-scenario contract, gate tests, packed memo-key round-trip test, and
this findings document.

## Limits

- `[unverified]` Performance was measured in Windows x64 Node, not browser or Android distributions.
- `[unverified]` Exact-interactive quality and browser/Android survival were not run after the performance gate failed.
- `[unverified]` This does not disprove all grow-and-resume designs. It rejects this tier-21-to-tier-22
  rehash implementation under the fixed contract and product comparison.
