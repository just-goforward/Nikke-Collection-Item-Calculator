import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  cmp,
  fromWire,
  mapTriple,
  type OracleInput,
  type OracleResult,
  q,
} from "./certified-staging-oracle.ts";
import { cachedOriginalOracle } from "./certified-staging-oracle-cache.ts";
import { createIndependentUnlimited } from "./certified-staging-oracle-witness.ts";

type Wire = Parameters<typeof fromWire>[0];
type Recorded = {
  status: string;
  sourceStable: boolean;
  input: {
    grade: "R" | "SR";
    level: number;
    exp: number;
    stock: readonly number[];
    prices: readonly Wire[];
  };
  result: {
    P: Wire;
    B: Wire;
    C: Wire;
    consumed: readonly [Wire, Wire, Wire];
    action: OracleResult["action"];
    ties: OracleResult["ties"];
    nodes: number;
  };
};
const KNOWN = [
  [
    "scripts/certified-staging-oracle-fixtures/large-current-R600.json.txt",
    "01ba9e5a1a45f21c4f17f9c90c6b1c60955494a72658118f5fda528113788aae",
  ],
  [
    "scripts/certified-staging-oracle-fixtures/large-current-R1000.json.txt",
    "5b478ab1a16a4f8774a82ffeaba662cbcf168b8453d83ade08bcf18b280bddb4",
  ],
  [
    "scripts/certified-staging-oracle-fixtures/large-current-SR800.json.txt",
    "d510c7aa03eca56532220cc1629f1cd7aedf0b4f3a5ce6cdfcecd49899e929d4",
  ],
] as const;
function sameInput(first: Recorded["input"], second: OracleInput) {
  return (
    first.grade === second.grade &&
    first.level === second.level &&
    first.exp === second.exp &&
    first.stock.every((pieces, color) => pieces === second.stock[color]) &&
    first.prices.every((price, color) => cmp(fromWire(price), second.prices[color]!) === 0)
  );
}
function recordedProof(input: OracleInput): OracleResult | null {
  for (const [path, expectedHash] of KNOWN) {
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") !== expectedHash)
      throw new Error("Immutable expanded current oracle report changed");
    const record = JSON.parse(bytes.toString("utf8")) as Recorded;
    if (!sameInput(record.input, input)) continue;
    if (record.status !== "PASS" || !record.sourceStable)
      throw new Error("Expanded exact oracle is not a completed frozen proof");
    return {
      P: fromWire(record.result.P),
      B: fromWire(record.result.B),
      C: fromWire(record.result.C),
      consumed: mapTriple(record.result.consumed, fromWire),
      action: record.result.action,
      ties: record.result.ties,
      nodes: record.result.nodes,
      candidates: new Map(),
    };
  }
  return null;
}
function feasibleUnrestricted(input: OracleInput): OracleResult | null {
  const value = createIndependentUnlimited(input.prices).solve(input);
  const terminal = input.grade === "SR" && input.level === 15;
  const colors = ["blue", "purple", "yellow"] as const;
  const ties = value.actions
    .map((action, color) => ({ action, color }))
    .filter(({ action }) => cmp(action.B, value.B) === 0 && cmp(action.C, value.C) === 0);
  if (
    !ties.every(({ action }) =>
      input.stock.every((pieces, color) => pieces >= 10 * action.worst[color]!),
    )
  )
    return null;
  const kits = ties.map(({ color }) => colors[color]!);
  return {
    P: q(1),
    B: value.B,
    C: value.C,
    consumed: value.consumed,
    action: kits[0] ?? (terminal ? "DONE" : "STOP"),
    ties: kits.length ? kits : ["DONE"],
    nodes: 0,
    candidates: new Map(),
  };
}
export function independentCurrentCoverage(input: OracleInput): {
  result?: OracleResult;
  basis: string;
} {
  const recorded = recordedProof(input);
  if (recorded)
    return { result: recorded, basis: "immutable_uncapped_expanded_layered_exact_proof" };
  if (input.stock.reduce((uses, pieces) => uses + Math.floor(pieces / 10), 0) <= 30)
    return {
      result: cachedOriginalOracle(input).result,
      basis: "original_guard_le30_exact_uncapped_inventory_DP",
    };
  const unrestricted = feasibleUnrestricted(input);
  return unrestricted
    ? {
        result: unrestricted,
        basis: "independent_unrestricted_optimum_all_tied_complete_policies_feasible",
      }
    : {
        basis:
          "NOTRUN_expanded_stock_without_independent_feasible_unrestricted_or_recorded_finite_proof",
      };
}
