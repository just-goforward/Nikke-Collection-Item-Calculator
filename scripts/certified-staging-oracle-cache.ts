import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PHYSICAL_CACHE, readV5Evidence } from "./certified-staging-approved-panel/v5/evidence.ts";
import {
  fromWire,
  mapTriple,
  type OracleInput,
  type OracleResult,
  wire,
} from "./certified-staging-oracle.ts";
import { solveIntegerOracle } from "./certified-staging-oracle-integer.ts";

const SOURCES = [
  "scripts/certified-staging-oracle-integer.ts",
  "scripts/certified-staging-oracle.ts",
  "scripts/certified-staging-oracle-tuples.ts",
  "shared/game.ts",
];
export const oracleSourceHashes = SOURCES.map((path) => ({
  path,
  sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
}));
export const oracleSourceHash = createHash("sha256")
  .update(JSON.stringify(oracleSourceHashes))
  .digest("hex");
type Wire = ReturnType<typeof wire>;
/** Restore authenticated v5 enumeration only. A failed v5 identity never falls
 * back to v1 rates, overwrites a cache or invokes an expensive enumeration. */
export function prepareIndependentPhysicalRatesCache(rootDirectory = process.cwd()) {
  const { physical, physicalBytes: bytes, provenance } = readV5Evidence(rootDirectory);
  const { sourceHash, sources } = physical;

  const path = resolve(rootDirectory, PHYSICAL_CACHE);
  const verifyExisting = () => {
    if (!readFileSync(path).equals(bytes))
      throw new Error(
        `Existing independent physical cache differs from pinned fixture; preserved: ${path}`,
      );
  };
  let cacheHit = existsSync(path);
  if (cacheHit) verifyExisting();
  else {
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, bytes, { flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      verifyExisting();
      cacheHit = true;
    }
  }
  return { path, cacheHit, sha256: provenance.physicalEnumeration.sha256, sourceHash, sources };
}

type Stored = {
  version: string;
  oracleSourceHash: string;
  inputHash: string;
  value: {
    P: Wire;
    B: Wire;
    C: Wire;
    consumed: readonly [Wire, Wire, Wire];
    action: OracleResult["action"];
    ties: OracleResult["ties"];
    nodes: number;
  };
  generatedAt: string;
  computeMs: number;
};
export function cachedOriginalOracle(input: OracleInput) {
  const inputHash = createHash("sha256")
    .update(JSON.stringify({ ...input, prices: input.prices.map(wire) }))
    .digest("hex");
  const key = createHash("sha256")
    .update(JSON.stringify({ inputHash, oracleSourceHash }))
    .digest("hex");
  const path = `benchmarks/results/certified-staging-validation-independent-oracle-cache/${key}.json`;
  let stored: Stored;
  const cacheHit = existsSync(path);
  if (cacheHit) {
    stored = JSON.parse(readFileSync(path, "utf8")) as Stored;
    if (
      stored.version !== "independent-original-oracle-cache-v1" ||
      stored.inputHash !== inputHash ||
      stored.oracleSourceHash !== oracleSourceHash
    )
      throw new Error("Exact independent oracle cache identity drift");
  } else {
    const started = performance.now();
    const result = solveIntegerOracle(input);
    stored = {
      version: "independent-original-oracle-cache-v1",
      oracleSourceHash,
      inputHash,
      generatedAt: new Date().toISOString(),
      computeMs: performance.now() - started,
      value: {
        P: wire(result.P),
        B: wire(result.B),
        C: wire(result.C),
        consumed: mapTriple(result.consumed, wire),
        action: result.action,
        ties: result.ties,
        nodes: result.nodes,
      },
    };
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { flag: "wx" });
  }
  const result: OracleResult = {
    P: fromWire(stored.value.P),
    B: fromWire(stored.value.B),
    C: fromWire(stored.value.C),
    consumed: mapTriple(stored.value.consumed, fromWire),
    action: stored.value.action,
    ties: stored.value.ties,
    nodes: stored.value.nodes,
    candidates: new Map(),
  };
  return {
    result,
    cacheHit,
    path,
    inputHash,
    oracleSourceHash,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    generatedComputeMs: stored.computeMs,
  };
}
