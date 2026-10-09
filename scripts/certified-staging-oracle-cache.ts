import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
const PHYSICAL_FIXTURE =
  "scripts/certified-staging-approved-panel/independent-physical-cohorts.json";
const PHYSICAL_PROVENANCE = "scripts/certified-staging-approved-panel/provenance.json";
const PHYSICAL_CACHE =
  "benchmarks/results/certified-staging-validation-independent-physical-rates.json";
const PHYSICAL_FIXTURE_SHA = "fed3faab0a2b032deb65f9b892684cb9518c38a67596f8ba066f8e9cc7d8be0a";
const PHYSICAL_PROVENANCE_SHA = "6cbf971ecdcbfe1e728a543a1a76adfa87ebbf694ae1722de5a2c6380b29d94a";
const physicalSourcePaths = [
  "scripts/certified-staging-oracle-physical-supply.ts",
  "scripts/certified-staging-oracle.ts",
];
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Restore only the authenticated independent enumeration bytes for the unchanged
 * physical helper. No product oracle is imported and no enumeration is rerun. */
export function prepareIndependentPhysicalRatesCache(rootDirectory = process.cwd()) {
  const pinnedFile = (path: string, expected: string) => {
    const bytes = readFileSync(resolve(rootDirectory, path));
    if (sha256(bytes) !== expected) throw new Error(`Independent physical hash drift: ${path}`);
    return bytes;
  };
  const provenance = JSON.parse(
    pinnedFile(PHYSICAL_PROVENANCE, PHYSICAL_PROVENANCE_SHA).toString(),
  ) as {
    physicalEnumeration: {
      path: string;
      sha256: string;
      sourceHash: string;
      sources: { path: string; sha256: string }[];
    };
  };
  const bytes = pinnedFile(PHYSICAL_FIXTURE, PHYSICAL_FIXTURE_SHA);
  const physical = JSON.parse(bytes.toString()) as {
    version: string;
    sourceHash: string;
    sources: { path: string; sha256: string }[];
    cohorts: readonly [
      readonly [Wire, Wire, Wire],
      readonly [Wire, Wire, Wire],
      readonly [Wire, Wire, Wire],
    ];
    rate: readonly [Wire, Wire, Wire];
  };
  const sources = physicalSourcePaths.map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(rootDirectory, path))),
  }));
  const sourceHash = sha256(JSON.stringify(sources));
  const origin = provenance.physicalEnumeration;
  if (
    physical.version !== "independent-ordered-physical-supply-rates-v1" ||
    origin.path !== PHYSICAL_CACHE ||
    origin.sha256 !== PHYSICAL_FIXTURE_SHA ||
    physical.sourceHash !== sourceHash ||
    origin.sourceHash !== sourceHash ||
    JSON.stringify(physical.sources) !== JSON.stringify(sources) ||
    JSON.stringify(origin.sources) !== JSON.stringify(sources)
  )
    throw new Error("Independent physical source identity drift");
  if (
    physical.cohorts.length !== 3 ||
    [physical.rate, ...physical.cohorts].some(
      (triple) =>
        triple.length !== 3 ||
        triple.some((value) => {
          const exact = fromWire(value);
          return (
            exact.n < 0n || exact.d <= 0n || JSON.stringify(wire(exact)) !== JSON.stringify(value)
          );
        }),
    )
  )
    throw new Error("Independent physical exact rate identity drift");

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
  return { path, cacheHit, sha256: PHYSICAL_FIXTURE_SHA, sourceHash, sources };
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
