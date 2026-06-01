# Shadow-Price Pilot Findings

Korean documentation: [`SHADOW_PILOT_FINDINGS.ko.md`](./SHADOW_PILOT_FINDINGS.ko.md)

Date: 2026-05-27

## Decision

The current B (`single-update shadow-price`) and C (`bounded fixed-point shadow-price`) models
are rejected as drop-in replacements for active `supply` policy A. No product solver behavior is
changed.

This is a fail-fast decision under the predeclared acceptance rules:

- Exact interactive-replan success probability must not decrease relative to A.
- Product-relevant interactive expected-consumption objective `F` must not worsen in protected
  scenarios.
- The existing `max - 0.01` probability gate must have zero violations.

B/C already contradict the first two requirements on low-cost deterministic scenarios, so
running expensive full-grid or trajectory significance evaluation cannot make them acceptable as
currently defined.

## Model Definitions Tested

- **A**: existing `phase1_availability_pnorm`.
- **B**: one gradient price update from A, followed by one linear shadow-price solve.
- **C**: damped fixed-point gradient updates with bounded iterations, cycle detection, timeout,
  and A fallback.

After an initial root-policy pilot exposed raw B/C candidates that worsened root `F`, both models
were strengthened with a monotonic local safeguard: a candidate whose root committed-policy `F`
is worse than A falls back to A at that replanning boundary. The exact results below are for the
safeguarded variants.

## A Baseline Gate

Before B/C evaluation, all five required exact A sentinels completed with zero internal and
boundary probability-gate violations. See `benchmarks/BASELINE_FINDINGS.md`.

## Exact Interactive Pilot Results

| Scenario | Model | Exact Success Probability | Interactive F | Delta Success vs A | Delta F vs A | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `R14e900-yellow30` | A | 0.5814477455800285 | 0.4525738379168630 | - | - | Baseline |
| `R14e900-yellow30` | B | 0.5854778239184680 | 0.4554618867922021 | +0.0040300783384395 | +0.0028880488753391 | Reject: F worse |
| `R14e900-yellow30` | C | 0.5809695512322890 | 0.4547045363154545 | -0.0004781943477395 | +0.0021306983985915 | Reject: success and F worse |
| `SR5-blue30` | A | 0.9565117082385661 | 0.2016306298740647 | - | - | Baseline |
| `SR5-blue30` | B | 0.9563314325784384 | 0.2006232166491749 | -0.0001802756601277 | -0.0010074132248898 | Reject: success worse |
| `SR5-blue30` | C | 0.9564833775151333 | 0.2005449832268461 | -0.0000283307234328 | -0.0010856466472186 | Reject: success worse |
| `SR0-balanced100` | A | 0.8691509913512931 | 0.3863971711273906 | - | - | Baseline |
| `SR0-balanced100` | B | 0.8695927910281485 | 0.3807100679816476 | +0.0004417996768554 | -0.0056871031457430 | Improvement signal only |
| `SR0-balanced100` | C | 0.8709616366733679 | 0.3820550274167669 | +0.0018106453220748 | -0.0043421437106237 | Improvement signal only |

All reported pilot evaluations had zero internal and boundary probability-gate violations.

## Consequence

- Do not connect B or C to `solve()` or update `solverVersion`.
- Keep the research API and deterministic pilot as evidence for future model redesign.
- A future candidate must address temporal pressure without relying on a local root safeguard
  alone; local non-worsening did not imply non-worsening interactive outcomes.
- Tail-risk significance work is deferred for B/C because mandatory exact acceptance already
  failed.

Generated raw reports are written under ignored `benchmarks/results/` and are not committed.

The D1-weighted strata pass and full-grid trajectory significance evaluation were intentionally
not executed for these B/C definitions. D1 exposure weighting can prioritize an acceptable
candidate, but it cannot rescue a model that already violates deterministic mandatory
acceptance conditions.
