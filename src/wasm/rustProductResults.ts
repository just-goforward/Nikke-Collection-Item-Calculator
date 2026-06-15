import { availabilityCostScore, legacySupplyCostScore } from "../solver/cost";
import {
  convertState,
  isConvertStateNormalized as isConvertState,
  isTerminalNormalized as isTerminal,
  pressureScore,
  SUPPLY_AVAILABILITY_PARAMS,
  totalKits,
  transition,
} from "../solver/domain";
import type { Kit } from "../types";
import type { RustProductInput } from "./rustProductInput";
import type { RustMonteCarloResult } from "./rustTypes";

type RustRootResultArgs = {
  input: RustProductInput;
  root: {
    firstAction: Kit;
    successProbability: number;
    maxSuccessProbability: number;
    vector: Record<Kit, number>;
  };
  name: string;
  solverBackend: string;
  solverVersion: string;
  solverPhase: string;
  resourceCost: number;
  states: number;
  candidateCount: number;
  run: unknown;
  route: unknown;
  monteCarlo: RustMonteCarloResult;
  topCandidates: unknown[];
  statsExtras?: Record<string, unknown>;
};

const KIT_ORDER: Kit[] = ["blue", "purple", "yellow"];

export function buildRustEarlyResult(input: RustProductInput, solverVersion: string) {
  if (isTerminal(input.start)) {
    return {
      terminal: true,
      input,
      message: "이미 SR 15레벨입니다.",
    };
  }

  if (isConvertState(input.start)) {
    return {
      possible: true,
      convertOnly: true,
      input,
      best: {
        name: "등급 전환",
        firstAction: "convert",
        firstProbability: 1,
        success: convertState(),
        fail: convertState(),
        vector: { blue: 0, purple: 0, yellow: 0 },
        totalKits: 0,
        successProbability: 1,
        pressure: 0,
      },
      route: [],
      monteCarlo: {
        runs: 0,
        completed: 0,
        successProbability: 1,
        vector: { blue: 0, purple: 0, yellow: 0 },
      },
      stats: {
        states: 0,
        exact: true,
        tolerance: 0,
        iterations: 0,
        solverVersion,
      },
      topCandidates: [],
    };
  }

  if (KIT_ORDER.reduce((sum, kit) => sum + input.stockUses[kit], 0) <= 0) {
    return buildRustNoActionResult(
      input,
      "사용 가능한 키트가 없습니다. 각 키트는 10개 단위로만 사용할 수 있습니다.",
    );
  }

  return null;
}

export function buildRustNoActionResult(input: RustProductInput, message: string) {
  return {
    possible: false,
    input,
    message,
  };
}

export function buildRustRootResult(args: RustRootResultArgs) {
  const edge = transition(args.input.start, args.root.firstAction);
  const totalExpectedKits = totalKits(args.root.vector);
  const pressure = pressureScore(args.root.vector, args.input.stockUses);
  const legacySupplyCost = legacySupplyCostScore(args.root.vector);
  const availabilityCost = availabilityCostScore(args.root.vector, args.input.stock);
  return {
    possible: true,
    terminal: false,
    input: args.input,
    candidateCount: args.candidateCount,
    best: {
      name: args.name,
      firstAction: args.root.firstAction,
      firstProbability: edge.probability,
      run: args.run,
      success: edge.success,
      fail: edge.fail,
      vector: args.root.vector,
      totalKits: totalExpectedKits,
      successProbability: args.root.successProbability,
      maxSuccessProbability: args.root.maxSuccessProbability,
      probabilityGap: Math.max(0, args.root.maxSuccessProbability - args.root.successProbability),
      pressure,
      supplyCost: legacySupplyCost,
      availabilityCost,
      legacySupplyCost,
      resourceCost: args.resourceCost,
    },
    route: args.route,
    monteCarlo: args.monteCarlo,
    stats: {
      states: args.states,
      exact: true,
      tolerance: 0,
      probabilityTolerance: 0,
      maxSuccessProbability: args.root.maxSuccessProbability,
      strategy: "supply",
      solverBackend: args.solverBackend,
      solverVersion: args.solverVersion,
      solverPhase: args.solverPhase,
      supplyAvailability: SUPPLY_AVAILABILITY_PARAMS,
      iterations: 0,
      ...args.statsExtras,
    },
    topCandidates: args.topCandidates,
  };
}
