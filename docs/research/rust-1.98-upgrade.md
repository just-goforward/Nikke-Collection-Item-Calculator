# Rust 1.98 Toolchain Upgrade Validation

Validated: 2026-08-24

Baseline commit: `b3d72883b6cb6b62b8ee322603453f826e0ac5a0`

## Decision

- `[confirmed]` Isolated Rust 1.97.1 and 1.98.0 builds are both 100,674 bytes and retain 0 imports, 100 exports, and identical `target_features`.
- `[confirmed]` Two min-E[f] fixtures and one phase2 fixture preserve the action and every compared binary64 probability, consumption-vector, and cost bit pattern. Terminal-cache lifecycle and WASM page growth are unchanged.
- `[confirmed]` Two independent 31-repeat Node ABBA campaigns completed every solve and passed compile, instantiate, cold, and warm p50 non-regression gates. A few first-campaign p95 increases did not repeat in the second campaign.
- `[decision]` Pin Rust 1.98.0 and publish its rebuilt WASM without changing the solver algorithm or policy version.
- `[unverified]` These measurements cover Windows x64 Node and a small Chromium direct-ABI smoke, not the distribution of physical user devices.

## Release Impact

The review used the official [Rust 1.98 announcement](https://blog.rust-lang.org/2026/08/20/Rust-1.98.0/), [Rust release notes](https://doc.rust-lang.org/releases.html#version-1980-2026-08-20), and [Cargo changelog](https://doc.rust-lang.org/nightly/cargo/CHANGELOG.html#cargo-198-2026-08-20).

- The new runtime-symbol and `c_void` lints produce no diagnostics under Clippy with `-D warnings`.
- The crate does not rely on the affected `transmute`, `repr(transparent)`, trait-object lifetime, or manual-`Ord`/derived-`PartialOrd` patterns.
- The newly stable floating-point `algebraic_*` operations are deliberately not adopted. They permit algebraic reassociation, which conflicts with the solver's operand-order and binary64 golden contracts.
- The remaining stabilized library APIs and Cargo changes do not simplify a demonstrated solver hot path or alter this dependency-free build graph.

## Artifacts And Semantics

| Item | Rust 1.97.1 | Rust 1.98.0 |
| --- | --- | --- |
| LLVM | 22.1.6 | 22.1.8 |
| SHA-256 | `ba0f3da54e01f1baedab46d6e49edf10d034e65a385e168c9f15d991817b661e` | `6d379139c065961d336d08a53ad7bf803b33acf2a14ec98d5a0a93a13ef8f4ce` |
| raw bytes | 100,674 | 100,674 |
| imports / exports | 0 / 100 | 0 / 100 |
| small page growth | 120,193,024 | 120,193,024 |
| maximum page growth | 130,875,392 | 130,875,392 |

Semantic fixtures covered min-E[f] `R0 / [60,120,900]`, min-E[f] `SR5 / [300,300,300]`, and phase2 `R1 / [100,100,100]`. The dominance-cap expected-cost golden remains `0x3fbf64e435ab1f1e`; candidate-level probability, vector, and cost bits also match.

## Performance

The environment was Node 24.19.0 on Windows x64 with a Ryzen 5 5600. Each campaign alternated base/candidate order for 31 repeats. Values below are paired median solve-time ratios; values below 1 favor Rust 1.98.

| Scenario | Phase | Campaign 1 | Campaign 2 |
| --- | --- | ---: | ---: |
| R0 remainder | instance cold | 0.9993 | 0.9939 |
| R0 remainder | allocation warm | 0.9950 | 0.9906 |
| SR5 balanced | instance cold | 0.9973 | 0.9961 |
| SR5 balanced | allocation warm | 0.9980 | 1.0024 |

The first-campaign R0 warm p95 increase did not repeat. SR5 warm p95 was approximately 5.3% higher in campaign 1 and 1.9% higher in campaign 2, below the repeated-regression threshold. This establishes p50 non-regression and no repeated p95 regression signal; it does not establish that Rust 1.98 is faster.

## Validation Boundary Repairs

- Updated the candidate validator and browser direct-ABI benchmark from the obsolete seven-argument min-E[f] ABI to the dynamic-gain ABI.
- Extended candidate validation to cover phase2 snapshots, imports/exports, and `target_features`.
- Separated the terminal-cache 3% improvement profile from the toolchain-upgrade non-regression profile.

This upgrade does not activate the schedule-based forecast. The product continues to use the existing active forecast while the staging shadow runs.
