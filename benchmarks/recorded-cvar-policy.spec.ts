import { describe, expect, it } from "vitest";
import { type RecordedCvarSample, selectRecordedCvarCandidate } from "./recorded-cvar-policy";

describe("recorded CVaR candidate selection", () => {
  it("selects the lowest sampled CVaR only inside success and mean guardrails", () => {
    const selected = selectRecordedCvarCandidate(
      [
        sample({ eta: 0.2, candidateCvar: 0.8 }),
        sample({ eta: 0.4, candidateCvar: 0.7 }),
        sample({ eta: 0.8, candidateCvar: 0.6, meanNonWorse: false }),
      ],
      0.9,
    );
    expect(selected?.eta).toBe(0.4);
  });

  it("rejects an optimizer/recorded-policy mismatch instead of treating it as evidence", () => {
    const selected = selectRecordedCvarCandidate(
      [sample({ candidateCvar: 0.7, recordedHingeDelta: 2e-12 })],
      0.9,
    );
    expect(selected).toBeNull();
  });
});

function sample(overrides: Partial<RecordedCvarSample> = {}): RecordedCvarSample {
  return {
    eta: 0.2,
    optimizedHinge: 0.1,
    recordedHinge: 0.1,
    recordedHingeDelta: 0,
    candidateCvar: 0.8,
    candidateMean: 0.4,
    candidateSuccess: 1,
    firstAction: "blue",
    meanNonWorse: true,
    successNonWorse: true,
    ...overrides,
  };
}
