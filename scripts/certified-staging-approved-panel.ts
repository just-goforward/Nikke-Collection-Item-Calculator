import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CertifiedSupplySnapshot } from "../shared/certifiedSupply.ts";
import type { CertifiedInput } from "../src/certified/types.ts";
import {
  add,
  compareValue,
  createOracleEvaluator,
  fromWire,
  makeTriple,
  mapTriple,
  mul,
  type QTriple,
  q,
  wire,
} from "./certified-staging-oracle.ts";
import { generateValidationCases } from "./certified-staging-oracle-fixtures.ts";

export const APPROVED_PANEL_DIRECTORY = "scripts/certified-staging-approved-panel";
export const APPROVED_PANEL_PATH = `${APPROVED_PANEL_DIRECTORY}/panel.json`;
export const APPROVED_PANEL_INDICES = [
  0, 1, 3, 4, 8, 15, 17, 21, 26, 29, 30, 31, 61, 73, 99, 137, 211, 313, 517, 731, 991, 1237, 1619,
  1999,
] as const;
type WireQ = ReturnType<typeof wire>;
type WireTriple = readonly [WireQ, WireQ, WireQ];
export const fileSha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert.ok(value !== undefined, `Missing approved fixture value at index ${index}`);
  return value;
}
export function approvedFixtureProvenance() {
  return ["snapshot.json", "independent-physical-cohorts.json", "provenance.json", "panel.json"]
    .map((file) => `${APPROVED_PANEL_DIRECTORY}/${file}`)
    .concat([
      "scripts/certified-staging-approved-panel.ts",
      "scripts/generate-certified-staging-approved-panel.ts",
      "scripts/certified-staging-oracle.ts",
      "scripts/certified-staging-oracle-tuples.ts",
      "scripts/certified-staging-oracle-fixtures.ts",
      "scripts/certified-staging-oracle-physical-supply.ts",
      "shared/game.ts",
    ])
    .map((path) => ({ path, sha256: fileSha256(path) }));
}
export function frozenApprovedSnapshot(): CertifiedSupplySnapshot {
  const path = `${APPROVED_PANEL_DIRECTORY}/snapshot.json`;
  assert.equal(
    fileSha256(path),
    "5dd4017b6f74bda406bbd93daa0037e720329d0d64eca05a442c59d6dd170e6d",
  );
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as CertifiedSupplySnapshot;
  assert.equal(snapshot.events.length, 79);
  return snapshot;
}
export function frozenIndependentCohorts(): readonly [QTriple, QTriple, QTriple] {
  const path = `${APPROVED_PANEL_DIRECTORY}/independent-physical-cohorts.json`;
  assert.equal(
    fileSha256(path),
    "fed3faab0a2b032deb65f9b892684cb9518c38a67596f8ba066f8e9cc7d8be0a",
  );
  const physical = JSON.parse(readFileSync(path, "utf8")) as {
    sources: { path: string; sha256: string }[];
    sourceHash: string;
    cohorts: readonly [WireTriple, WireTriple, WireTriple];
  };
  const sources = [
    "scripts/certified-staging-oracle-physical-supply.ts",
    "scripts/certified-staging-oracle.ts",
  ].map((path) => ({ path, sha256: fileSha256(path) }));
  assert.deepEqual(
    physical.sources,
    sources,
    "frozen independent physical enumeration source changed",
  );
  assert.equal(
    physical.sourceHash,
    createHash("sha256").update(JSON.stringify(sources)).digest("hex"),
  );
  assert.equal(physical.cohorts.length, 3);
  return mapTriple(physical.cohorts, (cohort) => {
    assert.equal(cohort.length, 3);
    return mapTriple(cohort, fromWire);
  });
}
export function independentApprovedPricing(snapshot: CertifiedSupplySnapshot, priors: QTriple) {
  assert.equal(snapshot.cadence.numerator, 1197);
  assert.equal(snapshot.cadence.denominator, 39);
  assert.equal(snapshot.rules.length, 1);
  const rule = at(snapshot.rules, 0);
  assert.deepEqual(rule.dispatch, [{ lawId: "dispatch-board-v1", count: 1 }]);
  assert.deepEqual(rule.normalShop, [{ lawId: "box-ii-v1", count: 5 }]);
  const count = (lawId: string) =>
    rule.soloDays.flat().reduce((sum, ref) => sum + (ref.lawId === lawId ? ref.count : 0), 0);
  assert.equal(count("regular-box-v1"), 16);
  assert.equal(count("box-ii-v1"), 68);
  assert.deepEqual(add(add(priors[0], priors[1]), priors[2]), q(1));
  assert.ok(priors.every((prior) => prior.n >= 0n));
  const cohorts = frozenIndependentCohorts();
  const shop = [q(35, 2), q(2), q(1)] as const;
  const solo = [q(1382, 5), q(152, 5), q(68, 5)] as const;
  return makeTriple((color) => {
    const dispatch = priors.reduce(
      (sum, prior, cohort) => add(sum, mul(prior, at(at(cohorts, cohort), color))),
      q(0),
    );
    return add(add(dispatch, mul(at(shop, color), q(1, 7))), mul(at(solo, color), q(39, 1197)));
  });
}
/** Expected values depend on the independent oracle and public rules only.
 * The frozen approved snapshot is test input, never an expected candidate output. */
export function generateIndependentApprovedPanel() {
  const originals = generateValidationCases();
  const snapshot = frozenApprovedSnapshot();
  const receivedEventIds = snapshot.events
    .filter(
      (event) =>
        event.gameDate === snapshot.coverage.currentDay &&
        Date.parse(event.at) <= Date.parse(snapshot.asOf),
    )
    .map((event) => event.id);
  return APPROVED_PANEL_INDICES.map((index) => {
    const original = at(originals, index);
    const input: CertifiedInput = { ...original.input, snapshot, receivedEventIds };
    const rates = independentApprovedPricing(snapshot, original.cohortWeights);
    const prices = makeTriple((color) => {
      const rate = at(rates, color);
      return q(rate.d, BigInt(at(input.stock, color)) * rate.d + rate.n);
    });
    const current = createOracleEvaluator(prices)(input);
    const difference = (first: WireQ, second: WireQ) => {
      const a = fromWire(first),
        b = fromWire(second);
      return wire(q(a.n * b.d - b.n * a.d, a.d * b.d));
    };
    const actionGaps = [...current.candidates].map(([action, value]) => ({
      action,
      optimal: compareValue(value, current) === 0,
      // Signed objective differences in lexicographic P-max/B-min/C-min order.
      P: difference(wire(current.P), wire(value.P)),
      B: difference(wire(value.B), wire(current.B)),
      C: difference(wire(value.C), wire(current.C)),
    }));
    const { snapshot: _snapshot, ...smallInput } = input;
    return {
      id: original.id,
      originalIndex: index,
      input: smallInput,
      expected: {
        successP: wire(current.P),
        weightedExpectedConsumptionB: wire(current.B),
        expectedTotalConsumptionC: wire(current.C),
        expectedConsumed: mapTriple(current.consumed, wire),
        action: current.action === "STOP" || current.action === "DONE" ? null : current.action,
        mask: current.ties.reduce((mask, action) => {
          if (action === "blue") return mask | 1;
          if (action === "purple") return mask | 2;
          if (action === "yellow") return mask | 4;
          return mask;
        }, 0),
        rates: mapTriple(rates, wire),
        prices: mapTriple(prices, wire),
        cohortWeights: mapTriple(original.cohortWeights, wire),
        actionGaps,
      },
    };
  });
}
export type ApprovedPanelRow = ReturnType<typeof generateIndependentApprovedPanel>[number];
export function loadIndependentApprovedPanel() {
  const stored = JSON.parse(readFileSync(APPROVED_PANEL_PATH, "utf8")) as ApprovedPanelRow[];
  assert.deepEqual(
    stored,
    generateIndependentApprovedPanel(),
    "tracked approved24 expectations differ from independent oracle; run the explicit generator and review the diff",
  );
  const snapshot = frozenApprovedSnapshot();
  return stored.map((row) => ({ ...row, input: { ...row.input, snapshot } }));
}
