# NIKKE Collection Item Level-Up Calculator

[한국어](./README.md) | **English** | [日本語](./README.ja.md)

[Open the calculator](https://just-goforward.github.io/Nikke-Collection-Item-Calculator/)

An unofficial browser tool for GODDESS OF VICTORY: NIKKE. Enter the current collection-item grade, level, EXP, and maintenance-kit inventory to calculate a recommended next action and its expected outcome. The interface supports Korean, English, and Japanese across desktop, tablet, and mobile layouts.

## Features

- Next-action recommendations based on grade, level, EXP, and kit inventory
- Comparison of SR15 reach probability, expected kit consumption, and inventory burden
- Continued calculation after Great Success outcomes and the R15-to-SR replacement flow
- Rust/WebAssembly `min-E[f]` solver with a Rust phase2 fallback
- Independent validation runs for recommendation verification
- Public aggregate statistics for environments and solver usage
- Light and dark themes with Korean, English, and Japanese interfaces

## How It Calculates

The solver first maximizes the probability of reaching SR15. Within the same probability range, it searches for an action that reduces kit burden while accounting for current inventory and expected future gains. Rust `min-E[f]` is the primary path; Rust phase2 is used as a recovery path when the primary solver cannot finish within its memory or time limits.

Results are probabilistic recommendations based on the entered state and the game rules represented by the current implementation. They do not predict Great Success events or guarantee a particular outcome. See the [research and technical records](#research-and-technical-records) for solver semantics and policy-quality measurements.

## Privacy and Statistics

Calculations run in the browser. The statistics service records a limited set of aggregate event categories in Cloudflare D1 to monitor service and solver behavior. It does not collect accounts, names, email addresses, or raw kit inventories. Event counts are not unique-user counts.

For security issues, use the private reporting route in the [security policy](./SECURITY.md) instead of opening a public issue.

## Local Development

Requirements:

- A current Node.js and npm installation
- A Rust toolchain with the `wasm32-unknown-unknown` target

```powershell
npm install
npm run dev
```

The production build recompiles the Rust solver to WebAssembly before Vite builds the frontend.

```powershell
npm run build
```

Primary verification commands:

```powershell
npm run typecheck
npm run lint
npm test
npm run test:worker
npm run build
npm run report:bundle
```

## Research and Technical Records

- [Expected 28-day maintenance-kit gains (Korean)](./docs/research/kit-expected-gain.ko.md)
- [Current min-E[f] H/p study (Korean)](./docs/research/min-ef-hp-study-findings.ko.md)
- [Solver policy quality study](./docs/research/solver-policy-quality-findings.md)
- [Rust phase2 methodology study](./docs/research/phase2-methodology-findings.md)
- [Next-generation solver and platform study](./docs/research/next-solver-research-findings.md)
- [Source artwork for the generated app icons](./docs/assets/app-icon-source.png)

Runtime CSS and components are the source of truth for the interface. The repository does not duplicate design values in a separate prose specification; visual, alignment, and compatibility tests protect observable layout behavior.

## License

Copyright (C) 2026 just-goforward and contributors.

Except for separately identified third-party components, this project is distributed under the [GNU Affero General Public License v3.0 or later](./LICENSE). The deployed site links to the Git commit used for its build so network users can obtain the corresponding source. See [Third-Party Notices](./THIRD_PARTY_NOTICES.md) for details.

The Pretendard font family remains under the SIL Open Font License 1.1 and is not relicensed under the AGPL.

NIKKE and related names and assets belong to their respective owners. This independent project is not affiliated with or endorsed by the game's developer or publisher.
