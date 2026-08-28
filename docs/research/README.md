# Research Document Index

This directory contains reproducible research contracts, findings, and operational studies for
the calculator. Product behavior is defined by the current runtime code and tests; these documents
record the evidence behind decisions and do not override the implementation.

## Solver Policy And Semantics

- [Rust min-E[f] H/p joint study (Korean)](./min-ef-hp-study-findings.ko.md) / [English](./min-ef-hp-study-findings.md)
- [Rust solver policy-quality study (Korean)](./solver-policy-quality-findings.ko.md) / [English](./solver-policy-quality-findings.md)
- [Rust phase2 methodology findings (Korean)](./phase2-methodology-findings.ko.md) / [English](./phase2-methodology-findings.md)
- [Conditional solver portfolio study (Korean)](./solver-portfolio-findings.ko.md) / [English](./solver-portfolio-findings.md)
- [min-E[f] memo grow-and-resume findings (Korean)](./min-ef-grow-resume-findings.ko.md) / [English](./min-ef-grow-resume-findings.md)
- [Rust 1.98 toolchain upgrade validation (Korean)](./rust-1.98-upgrade.ko.md) / [English](./rust-1.98-upgrade.md)

## Follow-Up Research

- [Next solver and platform findings (Korean)](./next-solver-research-findings.ko.md) / [English](./next-solver-research-findings.md)
- [Phase2 follow-up research ledger (Korean)](./phase2-next-research-ledger.ko.md)
- [Prioritized sparse policy-iteration contract (Korean)](./rust-prioritized-sparse-pi-plan.ko.md) / [English](./rust-prioritized-sparse-pi-plan.md)

## Statistics And Inputs

- [Schedule-based supply forecast contract (Korean)](./schedule-supply-forecast.ko.md) / [English](./schedule-supply-forecast.md)
- [Full Solo Raid cadence census (Korean)](./solo-raid-cadence-census.ko.md) / [English](./solo-raid-cadence-census.md)
- [Expected 28-day kit gains (Korean)](./kit-expected-gain.ko.md)
- [Statistics interval and D1 rollup review (Korean)](./stats-interval-rollup-findings.ko.md) / [English](./stats-interval-rollup-findings.md)

Large benchmark outputs, checkpoints, candidate WASM binaries, and profiler traces are local
research artifacts and are intentionally excluded from Git. Tracked findings should contain the
scenario definitions, tool versions, provenance, decisive measurements, and adoption decision
needed to audit a conclusion without publishing the complete raw campaign.
