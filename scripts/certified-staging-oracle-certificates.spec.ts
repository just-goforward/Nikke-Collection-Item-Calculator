import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { CertifiedInput, CertifiedOutput } from "../src/certified/types.ts";
import { q, wire } from "./certified-staging-oracle.ts";
import {
  ENGINE_RECOMMENDATION_HORIZON,
  HISTORICAL_H56_RECOMMENDATION_HORIZON as H56,
  physicalMass,
  verifyActualWaiting,
} from "./certified-staging-oracle-certificates.ts";
import { independentPhysicalRecurringRates } from "./certified-staging-oracle-physical-supply.ts";
import { makeTriple } from "./certified-staging-oracle-tuples.ts";

type Artifact = { input: CertifiedInput; records: readonly { output: CertifiedOutput }[] };
/** Preserved certified-daily-v1 output of the retired H56 engine (recommendedDays 56). Tests that
 * replay its witness pass the historical horizon explicitly; live checks use 14. */
function fixture() {
  const artifact = JSON.parse(
    readFileSync(
      "scripts/certified-staging-oracle-fixtures/historical-r0-witness.json.txt",
      "utf8",
    ),
  ) as Artifact;
  const input = {
    ...artifact.input,
    snapshot: {
      ...artifact.input.snapshot,
      futureLawSemantics: "independent_given_cohort-v1" as const,
    },
  };
  const record = artifact.records[0];
  assert(record, "Expected historical witness record");
  const output = structuredClone(record.output);
  const rates = independentPhysicalRecurringRates();
  const prices = makeTriple((color) =>
    q(rates[color].d, BigInt(input.stock[color]) * rates[color].d + rates[color].n),
  );
  return { input, output, prices };
}
it("independently validates historical physical witness masses, stocks and both exact finite endpoints under the declared law independence", () => {
  const { input, output, prices } = fixture();
  expect(verifyActualWaiting(input, output, prices, false, H56)).toMatchObject({
    status: "PASS",
    receiptCount: 80,
    finiteBeforeParity: true,
    finiteAfterParity: true,
  });
});
it("rejects missing receipts and independently false physical masses", () => {
  const { input, output, prices } = fixture();
  const witness = output.waiting.strictBoundaryWitness;
  assert(witness, "Expected strict boundary witness");
  output.waiting.strictBoundaryWitness = { ...witness, receipts: witness.receipts.slice(1) };
  expect(verifyActualWaiting(input, output, prices, false, H56).status).toBe("FAIL");
  output.waiting.strictBoundaryWitness = {
    ...witness,
    receipts: witness.receipts.map((receipt, index) =>
      index ? receipt : { ...receipt, mass: wire(q(0)) },
    ),
  };
  expect(verifyActualWaiting(input, output, prices, false, H56).status).toBe("FAIL");
});
it("rejects an endpoint value changed by one exact numerator unit", () => {
  const { input, output, prices } = fixture();
  const witness = output.waiting.strictBoundaryWitness;
  assert(witness, "Expected strict boundary witness");
  const B = witness.beforeValue.weightedExpectedConsumptionB;
  output.waiting.strictBoundaryWitness = {
    ...witness,
    beforeValue: {
      ...witness.beforeValue,
      weightedExpectedConsumptionB: { ...B, numerator: String(BigInt(B.numerator) + 1n) },
    },
  };
  expect(verifyActualWaiting(input, output, prices, false, H56).status).toBe("FAIL");
});
it("reports unsupported cohort replay as NOTRUN and never converts it into a passed certificate", () => {
  const { input, output, prices } = fixture();
  const witness = output.waiting.strictBoundaryWitness;
  assert(witness, "Expected strict boundary witness");
  output.waiting.strictBoundaryWitness = { ...witness, cohort: 1 };
  expect(verifyActualWaiting(input, output, prices, false, H56).status).toBe("NOTRUN");
});
it("rejects a declared boundary certificate without complete model coverage", () => {
  const { input, output, prices } = fixture();
  const incomplete = {
    ...input,
    snapshot: {
      ...input.snapshot,
      coverage: {
        ...input.snapshot.coverage,
        future: { ...input.snapshot.coverage.future, complete: false },
      },
    },
  };
  expect(verifyActualWaiting(incomplete, output, prices, false, H56).status).toBe("FAIL");
});
it("rejects a false boundary range or advertised probability interval without fabricating a full H56 expected value", () => {
  const { input, output, prices } = fixture();
  output.waiting.rangeBoundary = false;
  expect(verifyActualWaiting(input, output, prices, false, H56).reason).toBe(
    "boundary_range_or_unknown_expected_value_misreported",
  );
  output.waiting.rangeBoundary = true;
  output.waiting.successProbabilityInterval = { lower: wire(q(1)), upper: wire(q(1)) };
  expect(verifyActualWaiting(input, output, prices, false, H56).reason).toBe(
    "boundary_probability_interval_or_gap_not_current_coupling",
  );
});
it("checks N0 against the independent unrestricted optimum and detects a false terminal burden", () => {
  const { input, output, prices } = fixture();
  const terminal: CertifiedInput = { ...input, grade: "SR", level: 15, exp: 0 };
  const zero = wire(q(0)),
    one = wire(q(1));
  const current = output.current;
  assert(current, "Expected current optimum");
  output.current = {
    ...current,
    status: "complete",
    kit: null,
    uses: 0,
    pieces: 0,
    optimalActionMask: 0,
    value: {
      successP: one,
      weightedExpectedConsumptionB: zero,
      expectedTotalConsumptionC: zero,
      expectedConsumed: [zero, zero, zero],
      display: { successP: 1, weightedExpectedConsumptionB: 0, expectedTotalConsumptionC: 0 },
    },
  };
  output.waiting.recommendedDays = 0;
  output.waiting.rangeBoundary = false;
  output.waiting.bestDayRange = [0, 0];
  output.waiting.value = output.current.value;
  output.waiting.successProbabilityInterval = { lower: one, upper: one };
  output.waiting.successImprovementUpperBound = zero;
  expect(verifyActualWaiting(terminal, output, prices, false).status).toBe("PASS");
  output.current.value.weightedExpectedConsumptionB = one;
  expect(verifyActualWaiting(terminal, output, prices, false).status).toBe("FAIL");
});
it("uses the engine's 14-day recommendation horizon for every snapshot version; H56 only as explicit historical replay", () => {
  expect(ENGINE_RECOMMENDATION_HORIZON).toBe(14);
  expect(H56).toBe(56);
  const { input } = fixture();
  expect(input.snapshot.version).toBe("certified-daily-v1");
  for (const version of [
    "certified-daily-v1",
    "certified-daily-v2",
    "certified-daily-v3",
  ] as const) {
    const { output, prices } = fixture();
    const live = { ...input, snapshot: { ...input.snapshot, version } } as CertifiedInput;
    // A day-56 recommendation is outside the live 14-day horizon, whatever the version.
    expect(verifyActualWaiting(live, output, prices, false)).toEqual({
      status: "NOTRUN",
      reason: "independent_full_expectation_for_interior_day_not_computed",
    });
    output.waiting.recommendedDays = 14;
    expect(verifyActualWaiting(live, output, prices, false).reason).toBe(
      "boundary_range_or_unknown_expected_value_misreported",
    );
    output.waiting.bestDayRange = [14, 14];
    // The 56-day witness carries receipts beyond day 14: not the complete H14 receipt set.
    expect(verifyActualWaiting(live, output, prices, false)).toEqual({
      status: "FAIL",
      reason: "witness_stock_or_complete_receipt_set_mismatch",
    });
  }
});
it("gives a v3 deterministic weekly law its sole outcome mass 1 and keeps v2 deterministic laws unsupported", () => {
  const { input } = fixture();
  const event = {
    id: "weekly-kits:2026-09-30",
    gameDate: "2026-09-30",
    at: "2026-09-29T20:00:00.000Z",
    kind: "weekly-kits" as const,
    status: "confirmed" as const,
    ruleId: "schedule-kit-v3:documented-physical-supply-v2",
    refs: [
      { lawId: "deterministic:10,10,0", count: 1 },
      { lawId: "deterministic:10,10,0", count: 2 },
    ],
  };
  const v3 = {
    ...input,
    snapshot: { ...input.snapshot, version: "certified-daily-v3" as const, events: [event] },
  } as CertifiedInput;
  const receipt = (refIndex: number, pieces: readonly [number, number, number]) => ({
    eventId: event.id,
    refIndex,
    pieces,
    mass: wire(q(1)),
  });
  expect(physicalMass(v3, receipt(0, [10, 10, 0]))).toEqual(q(1));
  expect(physicalMass(v3, receipt(1, [20, 20, 0]))).toEqual(q(1));
  for (const pieces of [
    [10, 0, 0],
    [0, 10, 0],
    [10, 10, 1],
    [0, 0, 0],
  ] as const)
    expect(physicalMass(v3, receipt(0, pieces))).toEqual(q(0));
  expect(physicalMass(v3, receipt(1, [10, 10, 0]))).toEqual(q(0));
  const v2 = { ...v3, snapshot: { ...v3.snapshot, version: "certified-daily-v2" as const } };
  expect(() => physicalMass(v2, receipt(0, [10, 10, 0]))).toThrow(
    "independent_law_not_supported:deterministic:10,10,0",
  );
  const finite = {
    ...v3,
    snapshot: {
      ...v3.snapshot,
      laws: [
        {
          id: "deterministic:10,10,0",
          kind: "finite" as const,
          modelVersion: "fixture-v1",
          outcomes: [{ pieces: [10, 10, 0] as const, mass: wire(q(1)) }],
        },
      ],
    },
  } as CertifiedInput;
  expect(() => physicalMass(finite, receipt(0, [10, 10, 0]))).toThrow(
    "independent_law_not_supported:finite_override",
  );
});
