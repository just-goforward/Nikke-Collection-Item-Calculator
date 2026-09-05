# Focused Mutation Contract

Run `npm run test:mutation` from the repository root. This is a manual ratchet,
not a new CI job or a whole-repository mutation target.

## Scope and Gate

- Mutate only `src/hooks/solverRecoveryPolicy.ts`, with no mutation exclusions.
- Run the existing policy tests and `solverRecoveryPolicy.contract.test.ts`.
- Fail below **90%**. The measured baseline is **174/178 killed, 97.75%**.
- Use at most two Stryker runners, each running Vitest with one worker.
- Keep production recovery code, root Vitest, Worker workspaces, and existing
  test expectations unchanged.

The added tests assert all Worker error classifications and JS-safety traits,
deadline and integrity precedence, no-fallback vetoes, backend transitions,
main-thread eligibility, per-color whole-use limits, and monotonic deadlines.

## Vitest 5 Compatibility

The installed Stryker Vitest runner 10.0.0 builds test names with a space in
`src/test-helpers.ts` and `src/stryker-setup.ts`. Its `src/vitest-test-runner.ts`
escapes those names into `testNamePattern`. Vitest 5 instead matches suite and
test names joined with ` > `, as documented in its
[testNamePattern reference](https://main.vitest.dev/config/testnamepattern).

This was reproduced without changing tests: the space-joined integrity-test
filter skipped all nine tests; the arrow-joined filter ran the intended test.
The original mutation report marks the empty `isIntegrityFailure` body as
surviving despite coverage, with `testsCompleted: 0`.

Setting `coverageAnalysis: "off"` alone did not fix the adapter. It still
returned per-test coverage and the same ten helper mutants survived with zero
tests executed. The Stryker
[Vitest runner limitations](https://stryker-mutator.io/docs/stryker-js/vitest-runner/#limitations)
also warn that the adapter ignores this setting.

The ratchet therefore uses the built-in
[command runner](https://stryker-mutator.io/docs/stryker-js/configuration/#commandrunner-object)
with coverage analysis off. Each mutant starts the unfiltered Vitest CLI for
the two named test files. Stryker activates the mutant through its environment
variable and uses the command's exit status. No installed packages are patched.
The existing absent-tsconfig workaround for Stryker 10 with TypeScript 7 remains.

This costs a fresh Vitest process per mutant and reports one aggregate
`All tests` result, not per-test coverage. Its zero `NoCoverage` count is not
proof of complete line coverage. Restore the adapter only after an upstream
compatibility fix passes the empty-body check with tests actually executed and
reproduces the full-module score.

## Measured Evidence

Recorded on 2026-09-05 with Node 24.20.0, Vitest 5.0.0, Stryker 10.0.0,
and TypeScript 7.0.2, from base commit
`001f8427ddfdeb158a96d1e56561bbdc97d169e1` plus this test/config patch.

| Run | Killed / Total | Other Results | Score |
| --- | ---: | --- | ---: |
| Original Vitest adapter, full module | 20 / 178 | 145 survived, 13 no coverage | 11.24%, invalid baseline |
| Adapter, integrity helper, per-test | 0 / 10 | Covered mutants ran zero tests | 0% |
| Adapter, integrity helper, analysis off | 0 / 10 | Covered mutants ran zero tests | 0% |
| Command runner, original tests, helper | 8 / 10 | 2 survived | 80% |
| Command runner, original tests, full module | 97 / 178 | 81 survived | 54.49% |
| Final ratchet, full module | 174 / 178 | 4 survived, no timeouts/errors | 97.75% |

The final run took 1 minute 29 seconds locally. Its full-module mutant `52`,
which replaces `isIntegrityFailure` with `{}`, is **Killed**; `statusReason`
contains the actual failing integrity assertions. Production code was never
edited for this proof: Stryker applies mutations in its sandbox.

The four remaining mutants are equivalent for valid typed inputs: the phase2
capacity guard's backend check is redundant after the preceding returns, and
three changes to the SR15 shortcut still reach the SR8-or-higher acceptance
rule. They remain in the denominator; there is no 100% requirement.

A separate ten-mutant check used only the original nine tests and inherited
the final 90% threshold. It scored 80% and exited **1**, proving the gate fails.
Normal verification passed 82 tests, including the unchanged recovery runtime
tests, plus TypeScript, formatting, and architecture checks.

## Local Reports

Evidence is ignored under `reports/mutation/`:

- `mutation.json` and `original-per-test-11.24.json`: preserved original report.
- `filter-space.log` and `filter-arrow.log`: direct name-filter reproduction.
- `diagnostic-per-test.json`, `diagnostic-off.json`, and
  `diagnostic-command.json`: ten-mutant compatibility controls.
- `baseline-command.json`: reliable baseline before adding tests.
- `recovery-policy.json` and `recovery-policy.log`: final full-module gate.
- `threshold-proof.json` and `threshold-proof.log`: intentional failing gate.

The preserved original report's SHA-256 is
`e8e3b42d6cb188162d622f712f4dc982a324591723e201f54f2b76f0fdaf7730`.
The final gate writes a different filename so it does not overwrite that report.
