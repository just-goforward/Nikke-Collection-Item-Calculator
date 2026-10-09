import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { CertifiedInput, CertifiedOutput } from "../src/certified/types.ts";
import { q, wire } from "./certified-staging-oracle.ts";
import { verifyActualWaiting } from "./certified-staging-oracle-certificates.ts";
import { independentPhysicalRecurringRates } from "./certified-staging-oracle-physical-supply.ts";
import { makeTriple } from "./certified-staging-oracle-tuples.ts";

type Artifact = { input: CertifiedInput; records: readonly { output: CertifiedOutput }[] };
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
  expect(verifyActualWaiting(input, output, prices, false)).toMatchObject({
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
  expect(verifyActualWaiting(input, output, prices, false).status).toBe("FAIL");
  output.waiting.strictBoundaryWitness = {
    ...witness,
    receipts: witness.receipts.map((receipt, index) =>
      index ? receipt : { ...receipt, mass: wire(q(0)) },
    ),
  };
  expect(verifyActualWaiting(input, output, prices, false).status).toBe("FAIL");
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
  expect(verifyActualWaiting(input, output, prices, false).status).toBe("FAIL");
});
it("reports unsupported cohort replay as NOTRUN and never converts it into a passed certificate", () => {
  const { input, output, prices } = fixture();
  const witness = output.waiting.strictBoundaryWitness;
  assert(witness, "Expected strict boundary witness");
  output.waiting.strictBoundaryWitness = { ...witness, cohort: 1 };
  expect(verifyActualWaiting(input, output, prices, false).status).toBe("NOTRUN");
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
  expect(verifyActualWaiting(incomplete, output, prices, false).status).toBe("FAIL");
});
it("rejects a false boundary range or advertised probability interval without fabricating a full H56 expected value", () => {
  const { input, output, prices } = fixture();
  output.waiting.rangeBoundary = false;
  expect(verifyActualWaiting(input, output, prices, false).reason).toBe(
    "boundary_range_or_unknown_expected_value_misreported",
  );
  output.waiting.rangeBoundary = true;
  output.waiting.successProbabilityInterval = { lower: wire(q(1)), upper: wire(q(1)) };
  expect(verifyActualWaiting(input, output, prices, false).reason).toBe(
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
