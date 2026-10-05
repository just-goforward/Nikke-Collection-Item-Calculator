import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CertifiedInput, CertifiedOutput, CertifiedValue } from "../src/certified/types.ts";
import { fromWire, mapTriple } from "./certified-staging-oracle.ts";
import {
  loadWaitingProofCache,
  type WaitingProofCacheDocument,
  waitingCacheBuilderSources,
  waitingProofMathSources,
  waitingProofSignature,
} from "./certified-staging-oracle-waiting-cache.ts";

const fixture = JSON.parse(
  readFileSync("scripts/certified-staging-oracle-fixtures/historical-r0-witness.json.txt", "utf8"),
) as {
  input: CertifiedInput;
  records: { output: CertifiedOutput }[];
};
const input = fixture.input;
const output = fixture.records[0]!.output;
const prices = mapTriple(output.pricing!.weights, fromWire);
const snapshotHash = "a".repeat(64);
const { snapshot: _snapshot, ...fullInput } = input;
const signature = waitingProofSignature(fullInput, output, prices, snapshotHash);
mkdirSync(".certified-test-tmp", { recursive: true });
const directory = mkdtempSync(join(".certified-test-tmp", "waiting-cache-controls-"));
function document(): WaitingProofCacheDocument {
  return {
    version: "independent_waiting_exact_signature_cache_v1",
    oldProductProfile: "unit_apparatus_only",
    snapshotSha256: snapshotHash,
    mathSources: waitingProofMathSources(),
    cacheBuilderSources: waitingCacheBuilderSources(),
    sourceReports: [],
    sourcesCurrentAtEnd: true,
    entries: [
      {
        ...signature,
        originalId: "synthetic-cache-control",
        check: { status: "PASS", reason: "cache_controls_do_not_assert_this_fixture_was_reproved" },
        sourceProof: { path: "unit-apparatus", sha256: "b".repeat(64) },
      },
    ],
  };
}
let ordinal = 0;
function loaded(value = document()) {
  const bytes = JSON.stringify(value);
  const path = join(directory, String(ordinal++) + ".json");
  writeFileSync(path, bytes);
  return loadWaitingProofCache(path, createHash("sha256").update(bytes).digest("hex"));
}
function changeValue(value: CertifiedValue, field: number): void {
  if (field === 0)
    value.successP = {
      ...value.successP,
      numerator: String(BigInt(value.successP.numerator) + 1n),
    };
  else if (field === 1)
    value.weightedExpectedConsumptionB = {
      ...value.weightedExpectedConsumptionB,
      numerator: String(BigInt(value.weightedExpectedConsumptionB.numerator) + 1n),
    };
  else if (field === 2)
    value.expectedTotalConsumptionC = {
      ...value.expectedTotalConsumptionC,
      numerator: String(BigInt(value.expectedTotalConsumptionC.numerator) + 1n),
    };
  else
    value.expectedConsumed = mapTriple(value.expectedConsumed, (q, color) =>
      color === field - 3 ? { ...q, numerator: String(BigInt(q.numerator) + 1n) } : q,
    );
}
describe("exact waiting-proof cache signature controls", () => {
  it("binds the N0 exact-value envelope as well as its current optimum", () => {
    const n0 = structuredClone(output);
    n0.waiting = {
      ...n0.waiting,
      recommendedDays: 0,
      bestDayRange: [0, 0],
      rangeBoundary: false,
      value: n0.current!.value,
      successProbabilityInterval: {
        lower: { numerator: "1", denominator: "1" },
        upper: { numerator: "1", denominator: "1" },
      },
      successImprovementUpperBound: { numerator: "0", denominator: "1" },
    };
    const doc = document();
    doc.entries[0] = {
      ...doc.entries[0]!,
      ...waitingProofSignature(fullInput, n0, prices, snapshotHash),
    };
    const cache = loaded(doc);
    expect(cache.find(input, n0, prices, snapshotHash, true)).not.toBeNull();
    const changed = structuredClone(n0);
    changeValue(changed.waiting.value!, 1);
    expect(cache.find(input, changed, prices, snapshotHash, true)).toBeNull();
  });
  it("requires a measured current proof and exact snapshot/fixed prices", () => {
    const cache = loaded();
    expect(cache.find(input, output, prices, snapshotHash, true)?.key).toBe(signature.key);
    expect(cache.find(input, output, prices, snapshotHash, false)).toBeNull();
    expect(cache.find(input, output, prices, "c".repeat(64), true)).toBeNull();
    const changed = structuredClone(output);
    changed.pricing!.weights = mapTriple(changed.pricing!.weights, (q, color) =>
      color === 0 ? { ...q, numerator: String(BigInt(q.numerator) + 1n) } : q,
    );
    expect(cache.find(input, changed, prices, snapshotHash, true)).toBeNull();
  });
  it("rejects changed stock, price anchor, clock, prior and receipt ledger", () => {
    const cache = loaded();
    const changes: CertifiedInput[] = [
      { ...input, stock: [301, 50, 20] },
      { ...input, priceBasisStock: [301, 50, 20] },
      { ...input, asOf: "2026-09-30T09:00:00.000Z" },
      { ...input, receivedEventIds: ["different-receipt"] },
      {
        ...input,
        cohortWeights: [
          { numerator: "1", denominator: "1" },
          { numerator: "0", denominator: "1" },
          { numerator: "0", denominator: "1" },
        ],
      },
    ];
    for (const changed of changes)
      expect(cache.find(changed, output, prices, snapshotHash, true)).toBeNull();
  });
  it("rejects each of the12 exact endpoint numeric fields and every current numeric field", () => {
    const cache = loaded();
    for (const endpoint of ["beforeValue", "afterValue"] as const) {
      for (let field = 0; field < 6; field++) {
        const changed = structuredClone(output);
        changeValue(changed.waiting.strictBoundaryWitness![endpoint], field);
        expect(cache.find(input, changed, prices, snapshotHash, true)).toBeNull();
      }
    }
    for (let field = 0; field < 6; field++) {
      const changed = structuredClone(output);
      changeValue(changed.current!.value, field);
      expect(cache.find(input, changed, prices, snapshotHash, true)).toBeNull();
    }
  });
  it("rejects changes to the entire waiting envelope and actual receipt support", () => {
    const cache = loaded();
    const changedEnvelope = structuredClone(output);
    changedEnvelope.waiting.successProbabilityInterval!.upper = {
      numerator: "999",
      denominator: "1000",
    };
    expect(cache.find(input, changedEnvelope, prices, snapshotHash, true)).toBeNull();
    const changedReceipt = structuredClone(output);
    changedReceipt.waiting.strictBoundaryWitness!.receipts =
      changedReceipt.waiting.strictBoundaryWitness!.receipts.map((receipt, index) =>
        index === 0 ? { ...receipt, pieces: [999, 0, 0] } : receipt,
      );
    expect(cache.find(input, changedReceipt, prices, snapshotHash, true)).toBeNull();
    const changedDay = structuredClone(output);
    changedDay.waiting.recommendedDays = 55;
    expect(cache.find(input, changedDay, prices, snapshotHash, true)).toBeNull();
  });
  it("rejects unverified, duplicate, unstable or source-drifted cache documents", () => {
    const unverified = document();
    unverified.entries[0]!.check.status = "NOTRUN";
    expect(() => loaded(unverified)).toThrow("unverified");
    const duplicate = document();
    duplicate.entries.push(duplicate.entries[0]!);
    expect(() => loaded(duplicate)).toThrow("duplicate");
    const unstable = document();
    unstable.sourcesCurrentAtEnd = false;
    expect(() => loaded(unstable)).toThrow("unstable");
    const drift = document();
    drift.mathSources[0]!.sha256 = "f".repeat(64);
    expect(() => loaded(drift)).toThrow("source mismatch");
    expect(() => loadWaitingProofCache(join(directory, "0.json"), "0".repeat(64))).toThrow(
      "hash mismatch",
    );
  });
});
