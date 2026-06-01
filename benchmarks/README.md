# Solver Dynamic Pressure Research

Korean documentation: [`README.ko.md`](./README.ko.md)

Note as of 2026-06-01: `tau0.01-h0.5-p3` / A is the historical research baseline used by
these benchmark artifacts. The production solver default has since moved to
`tau0-h0.75-p3` (`phase2_availability_h075_tau0_p3`).

This directory contains slow, explicitly-run experiments that originally assessed whether the
historical `phase1_availability_pnorm` policy should eventually be replaced by a dynamic
supply-pressure model.

The first baseline is an idealized exact-entry interactive replan evaluator:

- It follows the UI behavior of recalculating after a recorded outcome.
- Multi-use success is branched by its actual success attempt probability.
- A non-terminal multi-use success assumes the user enters the resulting stock accurately.
- It records probability gate evidence without storing every internal MDP decision.
- It separates `manualEntryProbability` from `expectedManualEntries`.

The fixed safety grid contains 96 deterministic scenarios: 24 balanced regression scenarios and
72 scarce or skewed improvement scenarios. High-stock scenarios can be expensive; an incomplete
evaluation must be reported as `verification_incomplete`, never treated as a pass.

Do not put these files under `src/`; the normal `npm test` gate remains for fast product
regression tests only. Generated result data belongs under `benchmarks/results/` and is not
committed.

Run benchmark specs explicitly with:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run test:bench
```

The full A feasibility sentinel gate is a separate runner because `R0-balanced300` did not
complete within a ten-minute exploratory run. It prints progress while evaluating, uses a
60-minute total budget by default, evaluates the most expensive high-stock sentinel first, and
must complete before candidate model evaluation proceeds:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run bench:a-feasibility
```

For resumable execution, run one 30-second exact evaluation slice at a time. Completed node
results and previously solved boundary policies are stored in the ignored
`benchmarks/results/a-feasibility.checkpoint.json` file, without approximating the evaluation:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run bench:a-feasibility:slice
```

Repeat the command until all required sentinels are reported complete. To discard the current
checkpoint and start over:

```powershell
$env:A_FEASIBILITY_RESET = "1"
& "C:\Program Files\nodejs\npm.cmd" run bench:a-feasibility:slice
Remove-Item Env:A_FEASIBILITY_RESET
```

For a shorter feasibility probe:

```powershell
$env:A_FEASIBILITY_BUDGET_MS = "40000"
& "C:\Program Files\nodejs\npm.cmd" run bench:a-feasibility
Remove-Item Env:A_FEASIBILITY_BUDGET_MS
```

Current local baseline findings and the B/C proceed condition are recorded in
`benchmarks/BASELINE_FINDINGS.md`.

The current safeguarded B/C pilot findings and rejection decision are recorded in
`benchmarks/SHADOW_PILOT_FINDINGS.md`.

Run the root-policy and exact interactive pilots with:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run bench:shadow-pilot
& "C:\Program Files\nodejs\npm.cmd" run bench:shadow-exact-pilot
```
