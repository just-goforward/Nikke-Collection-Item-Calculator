import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ACTIVE_SUPPLY_FORECAST_BASE_PROFILE } from "../shared/generated/supplyForecast.ts";

type MinEfExports = {
  configureMemo?: (tier: number) => void;
  configureMinEfMemo?: (tier: number) => void;
  configureNodeBudget?: (budget: number) => void;
  getSolveStatus?: () => number;
  memory?: WebAssembly.Memory;
  minEfAction?: () => number;
  minEfExpectedCost?: () => number;
  minEfMaxSuccessProb?: () => number;
  minEfNodeCount?: () => number;
  minEfRootCandidateExpectedCost?: (action: number) => number;
  minEfRootCandidateMaxSuccessProb?: () => number;
  minEfRootCandidateSuccessProb?: (action: number) => number;
  minEfRootCandidateValid?: (action: number) => number;
  minEfRootCandidateVecB?: (action: number) => number;
  minEfRootCandidateVecP?: (action: number) => number;
  minEfRootCandidateVecY?: (action: number) => number;
  minEfSuccessProb?: () => number;
  minEfVecB?: () => number;
  minEfVecP?: () => number;
  minEfVecY?: () => number;
  releaseMinEfMemo?: () => void;
  resAction?: (slot: number) => number;
  resMaxSuccessProb?: (slot: number) => number;
  resSuccessProb?: (slot: number) => number;
  resVecB?: (slot: number) => number;
  resVecP?: (slot: number) => number;
  resVecY?: (slot: number) => number;
  rootCandidateCost?: (action: number) => number;
  rootCandidateMaxSuccessProb?: () => number;
  rootCandidateSuccessProb?: (action: number) => number;
  rootCandidateValid?: (action: number) => number;
  rootCandidateVecB?: (action: number) => number;
  rootCandidateVecP?: (action: number) => number;
  rootCandidateVecY?: (action: number) => number;
  solveCore?: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    blueGain: number,
    purpleGain: number,
    yellowGain: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
  ) => number;
  solveMinEf?: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    blueGain: number,
    purpleGain: number,
    yellowGain: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
  ) => void;
  statesCount?: () => number;
};
type CandidateSnapshot =
  | { valid: false }
  | {
      expectedCostBits: string;
      successBits: string;
      valid: true;
      vectorBits: [string, string, string];
    };
type MinEfSnapshot = {
  action: number;
  candidates: CandidateSnapshot[];
  expectedCostBits: string;
  maxSuccessBits: string;
  nodeCount: number;
  status: number;
  successBits: string;
  vectorBits: [string, string, string];
};
type Phase2Snapshot = {
  action: number;
  candidates: CandidateSnapshot[];
  maxSuccessBits: string;
  stateCount: number;
  status: number;
  successBits: string;
  vectorBits: [string, string, string];
};
type Stock = readonly [blue: number, purple: number, yellow: number];

const SMALL_ADDITIONAL_LIMIT = 1 << 20;
const MAX_TERMINAL_CACHE_BYTES = 885_105 * 12;
const MAX_ADDITIONAL_LIMIT = MAX_TERMINAL_CACHE_BYTES + (1 << 20);

function requiredPath(name: "WASM_BASE_PATH" | "WASM_CANDIDATE_PATH") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return resolve(value);
}

function requireFunction<T extends (...args: never[]) => unknown>(
  value: T | undefined,
  name: string,
): T {
  if (typeof value !== "function") throw new Error(`WASM export ${name} is missing.`);
  return value;
}

function f64Bits(value: number) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, true);
  return `0x${view.getBigUint64(0, true).toString(16).padStart(16, "0")}`;
}

async function instantiate(path: string) {
  const bytes = await readFile(path);
  const result = await WebAssembly.instantiate(bytes);
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  const exports = instance.exports as MinEfExports;
  requireFunction(exports.configureMinEfMemo, "configureMinEfMemo")(21);
  exports.configureNodeBudget?.(2_000_000);
  if (!(exports.memory instanceof WebAssembly.Memory))
    throw new Error("WASM memory export is missing.");
  return exports;
}

function solve(exports: MinEfExports, stateId: number, stock: Stock) {
  const gain = ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.expectedGain;
  requireFunction(exports.solveMinEf, "solveMinEf")(
    stateId,
    stock[0],
    stock[1],
    stock[2],
    gain.blue,
    gain.purple,
    gain.yellow,
    0.75,
    3,
    0,
  );
  const status = requireFunction(exports.getSolveStatus, "getSolveStatus")();
  if (status !== 0) throw new Error(`min-E[f] solve failed with status ${status}.`);
}

function snapshotCandidate(exports: MinEfExports, action: number): CandidateSnapshot {
  const valid = requireFunction(exports.minEfRootCandidateValid, "minEfRootCandidateValid")(action);
  if (valid === 0) return { valid: false };
  return {
    expectedCostBits: f64Bits(
      requireFunction(
        exports.minEfRootCandidateExpectedCost,
        "minEfRootCandidateExpectedCost",
      )(action),
    ),
    successBits: f64Bits(
      requireFunction(
        exports.minEfRootCandidateSuccessProb,
        "minEfRootCandidateSuccessProb",
      )(action),
    ),
    valid: true,
    vectorBits: [
      f64Bits(requireFunction(exports.minEfRootCandidateVecB, "minEfRootCandidateVecB")(action)),
      f64Bits(requireFunction(exports.minEfRootCandidateVecP, "minEfRootCandidateVecP")(action)),
      f64Bits(requireFunction(exports.minEfRootCandidateVecY, "minEfRootCandidateVecY")(action)),
    ],
  };
}

function snapshot(exports: MinEfExports): MinEfSnapshot {
  const status = requireFunction(exports.getSolveStatus, "getSolveStatus")();
  if (status !== 0) throw new Error(`Cannot snapshot failed min-E[f] solve status ${status}.`);
  return {
    action: requireFunction(exports.minEfAction, "minEfAction")(),
    candidates: [0, 1, 2].map((action) => snapshotCandidate(exports, action)),
    expectedCostBits: f64Bits(requireFunction(exports.minEfExpectedCost, "minEfExpectedCost")()),
    maxSuccessBits: f64Bits(requireFunction(exports.minEfMaxSuccessProb, "minEfMaxSuccessProb")()),
    nodeCount: requireFunction(exports.minEfNodeCount, "minEfNodeCount")(),
    status,
    successBits: f64Bits(requireFunction(exports.minEfSuccessProb, "minEfSuccessProb")()),
    vectorBits: [
      f64Bits(requireFunction(exports.minEfVecB, "minEfVecB")()),
      f64Bits(requireFunction(exports.minEfVecP, "minEfVecP")()),
      f64Bits(requireFunction(exports.minEfVecY, "minEfVecY")()),
    ],
  };
}

function snapshotPhase2Candidate(exports: MinEfExports, action: number): CandidateSnapshot {
  const valid = requireFunction(exports.rootCandidateValid, "rootCandidateValid")(action);
  if (valid === 0) return { valid: false };
  return {
    expectedCostBits: f64Bits(
      requireFunction(exports.rootCandidateCost, "rootCandidateCost")(action),
    ),
    successBits: f64Bits(
      requireFunction(exports.rootCandidateSuccessProb, "rootCandidateSuccessProb")(action),
    ),
    valid: true,
    vectorBits: [
      f64Bits(requireFunction(exports.rootCandidateVecB, "rootCandidateVecB")(action)),
      f64Bits(requireFunction(exports.rootCandidateVecP, "rootCandidateVecP")(action)),
      f64Bits(requireFunction(exports.rootCandidateVecY, "rootCandidateVecY")(action)),
    ],
  };
}

function solveAndSnapshotPhase2(
  exports: MinEfExports,
  stateId: number,
  stock: Stock,
): Phase2Snapshot {
  requireFunction(exports.configureMemo, "configureMemo")(21);
  const gain = ACTIVE_SUPPLY_FORECAST_BASE_PROFILE.expectedGain;
  const slot = requireFunction(exports.solveCore, "solveCore")(
    stateId,
    stock[0],
    stock[1],
    stock[2],
    gain.blue,
    gain.purple,
    gain.yellow,
    0.75,
    3,
    0,
  );
  const status = requireFunction(exports.getSolveStatus, "getSolveStatus")();
  if (status !== 0 || slot < 0) {
    throw new Error(`phase2 solve failed with status ${status} and slot ${slot}.`);
  }
  return {
    action: requireFunction(exports.resAction, "resAction")(slot),
    candidates: [0, 1, 2].map((action) => snapshotPhase2Candidate(exports, action)),
    maxSuccessBits: f64Bits(requireFunction(exports.resMaxSuccessProb, "resMaxSuccessProb")(slot)),
    stateCount: requireFunction(exports.statesCount, "statesCount")(),
    status,
    successBits: f64Bits(requireFunction(exports.resSuccessProb, "resSuccessProb")(slot)),
    vectorBits: [
      f64Bits(requireFunction(exports.resVecB, "resVecB")(slot)),
      f64Bits(requireFunction(exports.resVecP, "resVecP")(slot)),
      f64Bits(requireFunction(exports.resVecY, "resVecY")(slot)),
    ],
  };
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `${message}\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`,
    );
  }
}

async function memoryGrowth(path: string, stateId: number, stock: Stock) {
  const exports = await instantiate(path);
  const before = exports.memory?.buffer.byteLength ?? 0;
  solve(exports, stateId, stock);
  const after = exports.memory?.buffer.byteLength ?? 0;
  return after - before;
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function moduleContract(path: string) {
  const module = await WebAssembly.compile(await readFile(path));
  return {
    exports: WebAssembly.Module.exports(module),
    imports: WebAssembly.Module.imports(module),
    targetFeatures: WebAssembly.Module.customSections(module, "target_features").map((section) =>
      Buffer.from(section).toString("hex"),
    ),
  };
}

async function main() {
  const basePath = requiredPath("WASM_BASE_PATH");
  const candidatePath = requiredPath("WASM_CANDIDATE_PATH");
  const [baseHash, candidateHash, baseContract, candidateContract] = await Promise.all([
    sha256(basePath),
    sha256(candidatePath),
    moduleContract(basePath),
    moduleContract(candidatePath),
  ]);
  if (baseHash === candidateHash) throw new Error("Base and candidate hashes are identical.");
  assertEqual(candidateContract, baseContract, "Candidate changed the WASM import/export contract");

  const fixtures = [
    { id: "dominance-cap", stateId: 0, stock: [60, 120, 900] as const },
    { id: "balanced", stateId: (16 + 5) * 30, stock: [300, 300, 300] as const },
  ];
  const parity: Record<string, MinEfSnapshot> = {};
  for (const fixture of fixtures) {
    const [base, candidate] = await Promise.all([
      instantiate(basePath),
      instantiate(candidatePath),
    ]);
    solve(base, fixture.stateId, fixture.stock);
    solve(candidate, fixture.stateId, fixture.stock);
    const baseSnapshot = snapshot(base);
    const candidateSnapshot = snapshot(candidate);
    assertEqual(candidateSnapshot, baseSnapshot, `${fixture.id} changed min-E[f] semantics`);
    parity[fixture.id] = candidateSnapshot;
  }
  if (parity["dominance-cap"]?.action !== 0) {
    throw new Error("Dominance-cap semantic fixture no longer selects blue.");
  }
  if (parity["dominance-cap"]?.expectedCostBits !== "0x3fbf64e435ab1f1e") {
    throw new Error("Dominance-cap expected-cost semantic golden changed.");
  }

  const [phase2Base, phase2Candidate] = await Promise.all([
    instantiate(basePath),
    instantiate(candidatePath),
  ]);
  const phase2Snapshot = solveAndSnapshotPhase2(phase2Base, 30, [100, 100, 100]);
  assertEqual(
    solveAndSnapshotPhase2(phase2Candidate, 30, [100, 100, 100]),
    phase2Snapshot,
    "R1-balanced changed phase2 semantics",
  );

  const candidateFresh = await instantiate(candidatePath);
  solve(candidateFresh, 0, [60, 120, 900]);
  const freshSnapshot = snapshot(candidateFresh);

  const candidateReused = await instantiate(candidatePath);
  solve(candidateReused, (16 + 5) * 30, [300, 300, 300]);
  solve(candidateReused, 0, [60, 120, 900]);
  assertEqual(
    snapshot(candidateReused),
    freshSnapshot,
    "Reused candidate leaked terminal cache state",
  );
  requireFunction(candidateReused.releaseMinEfMemo, "releaseMinEfMemo")();
  solve(candidateReused, 0, [60, 120, 900]);
  assertEqual(
    snapshot(candidateReused),
    freshSnapshot,
    "Released candidate rebuilt different results",
  );

  const [smallBase, smallCandidate, maxBase, maxCandidate] = await Promise.all([
    memoryGrowth(basePath, 0, [60, 120, 900]),
    memoryGrowth(candidatePath, 0, [60, 120, 900]),
    memoryGrowth(basePath, (16 + 10) * 30, [100_000, 100_000, 100_000]),
    memoryGrowth(candidatePath, (16 + 10) * 30, [100_000, 100_000, 100_000]),
  ]);
  const smallAdditional = smallCandidate - smallBase;
  const maxAdditional = maxCandidate - maxBase;
  if (smallAdditional > SMALL_ADDITIONAL_LIMIT) {
    throw new Error(
      `Small terminal cache added ${smallAdditional} bytes, above ${SMALL_ADDITIONAL_LIMIT}.`,
    );
  }
  if (maxAdditional > MAX_ADDITIONAL_LIMIT) {
    throw new Error(
      `Maximum terminal cache added ${maxAdditional} bytes, above ${MAX_ADDITIONAL_LIMIT}.`,
    );
  }

  console.log(
    JSON.stringify(
      {
        artifacts: {
          base: { path: basePath, sha256: baseHash },
          candidate: { path: candidatePath, sha256: candidateHash },
        },
        moduleContract: {
          exportCount: candidateContract.exports.length,
          importCount: candidateContract.imports.length,
          targetFeatures: candidateContract.targetFeatures,
        },
        lifecycle: "passed",
        memory: {
          limitations: "page growth is a coarse signal, not logical allocation size",
          max: { additional: maxAdditional, base: maxBase, candidate: maxCandidate },
          small: { additional: smallAdditional, base: smallBase, candidate: smallCandidate },
        },
        parity,
        phase2Parity: {
          "R1-balanced": phase2Snapshot,
        },
      },
      null,
      2,
    ),
  );
}

await main();
