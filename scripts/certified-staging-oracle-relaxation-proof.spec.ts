import { describe, expect, it } from "vitest";
import type { CertifiedValue } from "../src/certified/types.ts";
import { q, wire } from "./certified-staging-oracle.ts";
import { evaluatePublicPathRelaxationPair } from "./certified-staging-oracle-public-path-relaxation.ts";
import { checkPublicRelaxationProof } from "./certified-staging-oracle-relaxation-proof.ts";

function fixture() {
  const result = evaluatePublicPathRelaxationPair({
    grade: "SR",
    level: 14,
    exp: 2400,
    prices: [q(1), q(2), q(4)],
    beforeStock: [0, 40, 40],
    afterStock: [10, 40, 40],
    finiteColors: [0, 2],
  });
  const value = (endpoint: NonNullable<typeof result.before>): CertifiedValue => ({
    successP: wire(endpoint.P),
    weightedExpectedConsumptionB: wire(endpoint.B),
    expectedTotalConsumptionC: wire(endpoint.C),
    expectedConsumed: [
      wire(endpoint.consumed[0]),
      wire(endpoint.consumed[1]),
      wire(endpoint.consumed[2]),
    ],
    display: { successP: 1, weightedExpectedConsumptionB: 0, expectedTotalConsumptionC: 0 },
  });
  if (!result.before || !result.after) throw new Error("Expected both independent endpoints");
  return {
    result,
    witness: { beforeValue: value(result.before), afterValue: value(result.after) },
  };
}
describe("independent replay terminal resource status", () => {
  it("never promotes populated exact endpoint diagnostics after a final deadline refusal", () => {
    const { result, witness } = fixture();
    const exception = {
      name: "Error",
      message: "independent_public_relaxation_deadline",
      stack: "saved exact failure stack",
    };
    const refused = {
      ...result,
      status: "NOTRUN" as const,
      reason: exception.message,
      rawException: exception,
    };
    expect(result.beforeFits && result.afterFits && result.strictOrder === 1).toBe(true);
    expect(checkPublicRelaxationProof(refused, witness)).toEqual({
      status: "NOTRUN",
      reason: exception.message,
      beforeParity: false,
      afterParity: false,
    });
    expect(refused.rawException).toEqual(exception);
  });
  it("preserves UNKNOWN populated fields and accepts an admitted full exact comparison", () => {
    const { result, witness } = fixture();
    expect(
      checkPublicRelaxationProof(
        { ...result, status: "UNKNOWN", reason: "unsupported proof" },
        witness,
      ).status,
    ).toBe("UNKNOWN");
    expect(checkPublicRelaxationProof(result, witness).status).toBe("PASS_ENDPOINT_PARITY");
  });
});
