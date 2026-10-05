import { expect, it } from "vitest";
import { makeTriple, type OracleInput, q } from "./certified-staging-oracle.ts";
import { independentCurrentCoverage } from "./certified-staging-oracle-current-coverage.ts";
import { independentPhysicalRecurringRates } from "./certified-staging-oracle-physical-supply.ts";

function physicalInput(grade: "R" | "SR", stock: OracleInput["stock"]): OracleInput {
  const rates = independentPhysicalRecurringRates();
  return {
    grade,
    level: 0,
    exp: 0,
    stock,
    prices: makeTriple((color) =>
      q(rates[color]!.d, BigInt(stock[color]!) * rates[color]!.d + rates[color]!.n),
    ),
  };
}
it("reuses only SHA-bound independent expanded proofs with exactly matching state, raw stock and physical prices", () => {
  for (const [grade, stock, action] of [
    ["R", [600, 100, 40], "purple"],
    ["R", [1000, 200, 100], "blue"],
    ["SR", [800, 150, 60], "blue"],
  ] as const) {
    const proof = independentCurrentCoverage(physicalInput(grade, stock));
    expect(proof.basis).toBe("immutable_uncapped_expanded_layered_exact_proof");
    expect(proof.result?.action).toBe(action);
  }
});
it("does not silently reuse an expanded proof when a price changes by one exact numerator unit", () => {
  const input = physicalInput("R", [600, 100, 40]);
  input.prices = [
    { ...input.prices[0], n: input.prices[0].n + 1n },
    input.prices[1],
    input.prices[2],
  ];
  expect(independentCurrentCoverage(input).basis).toContain("NOTRUN");
});
it("independently proves a sufficiently stocked unrestricted policy beyond the original thirty-use guard", () => {
  const proof = independentCurrentCoverage(physicalInput("R", [3000, 0, 0]));
  expect(proof.basis).toBe("independent_unrestricted_optimum_all_tied_complete_policies_feasible");
  expect(proof.result).toMatchObject({ P: q(1), action: "blue", ties: ["blue"] });
  expect(proof.result?.consumed.slice(1)).toEqual([q(0), q(0)]);
});
