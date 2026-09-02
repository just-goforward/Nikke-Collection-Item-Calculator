export type RustCoreExports = {
  configureMemo?: (capLog2: number) => void;
  configurePhase2Overflow?: (enabled: number) => void;
  releasePhase2Memo?: () => void;
  configureMinEfMemo?: (capLog2: number) => void;
  releaseMinEfMemo?: () => void;
  configureNodeBudget?: (budget: number) => void;
  getSolveStatus?: () => number;
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
  resAction?: (slot: number) => number;
  resSuccessProb?: (slot: number) => number;
  resMaxSuccessProb?: (slot: number) => number;
  resVecB?: (slot: number) => number;
  resVecP?: (slot: number) => number;
  resVecY?: (slot: number) => number;
  rootCandidateValid?: (action: number) => number;
  rootCandidateMaxSuccessProb?: () => number;
  rootCandidateSuccessProb?: (action: number) => number;
  rootCandidateVecB?: (action: number) => number;
  rootCandidateVecP?: (action: number) => number;
  rootCandidateVecY?: (action: number) => number;
  rootCandidateCost?: (action: number) => number;
  policyActionAt?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
  ) => number;
  phase2MaxSuccessForActionAt?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
    action: number,
  ) => number;
  simulateCore?: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    runs: number,
    seed: number,
  ) => void;
  simulateAfterFirstActionCore?: (
    stateId: number,
    bluePieces: number,
    purplePieces: number,
    yellowPieces: number,
    runs: number,
    seed: number,
    firstAction: number,
  ) => void;
  getMcCompleted?: () => number;
  getMcRuns?: () => number;
  getMcVecB?: () => number;
  getMcVecP?: () => number;
  getMcVecY?: () => number;
  getMcQuantileB?: (q: number) => number;
  getMcQuantileP?: (q: number) => number;
  getMcQuantileY?: (q: number) => number;
  getMcDepletion?: () => number;
  statesCount?: () => number;
  phase2OverflowSegments?: () => number;
  phase2MemoCapacity?: () => number;
  phase2MemoLogicalBytes?: () => number;
  solveMinEf: (
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
  minEfAction: () => number;
  minEfSuccessProb: () => number;
  minEfMaxSuccessProb: () => number;
  minEfVecB: () => number;
  minEfVecP: () => number;
  minEfVecY: () => number;
  minEfExpectedCost: () => number;
  minEfNodeCount?: () => number;
  minEfRootCandidateValid?: (action: number) => number;
  minEfRootCandidateMaxSuccessProb?: () => number;
  minEfRootCandidateSuccessProb?: (action: number) => number;
  minEfRootCandidateVecB?: (action: number) => number;
  minEfRootCandidateVecP?: (action: number) => number;
  minEfRootCandidateVecY?: (action: number) => number;
  minEfRootCandidateExpectedCost?: (action: number) => number;
  minEfActionAtOrSolve: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
  ) => number;
  simulateExpectedFAfterFirstAction?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
    initialBluePieces: number,
    initialPurplePieces: number,
    initialYellowPieces: number,
    horizonFactor: number,
    normPower: number,
    tolerance: number,
    runs: number,
    seed: number,
    firstAction: number,
  ) => void;
  simulateExpectedFAfterFirstActionFromPolicy?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
    initialBluePieces: number,
    initialPurplePieces: number,
    initialYellowPieces: number,
    horizonFactor: number,
    normPower: number,
    runs: number,
    seed: number,
    firstAction: number,
  ) => void;
  getMcEf?: () => number;
  getMcEfSumSq?: () => number;
  getMcEfRuns?: () => number;
  getMcEfCompletion?: () => number;
  simulateExpectedFPairFromPolicy?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
    initialBluePieces: number,
    initialPurplePieces: number,
    initialYellowPieces: number,
    horizonFactor: number,
    normPower: number,
    runs: number,
    seed: number,
    baselineFirstAction: number,
    selectedFirstAction: number,
  ) => void;
  getPairMeanBaseline?: () => number;
  getPairMeanSelected?: () => number;
  getPairMeanDelta?: () => number;
  getPairDeltaSumSq?: () => number;
  getPairRuns?: () => number;
  getPairCorrelation?: () => number;
  momentVectorAfterFirstActionFromPolicy?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
    firstAction: number,
  ) => void;
  momentMeanBUses?: () => number;
  momentMeanPUses?: () => number;
  momentMeanYUses?: () => number;
  momentSecondBBUses?: () => number;
  momentSecondPPUses?: () => number;
  momentSecondYYUses?: () => number;
  momentSecondBPUses?: () => number;
  momentSecondBYUses?: () => number;
  momentSecondPYUses?: () => number;
  momentVectorNodeCount?: () => number;
  cvarSetup?: (
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
  cvarFollowMean?: () => number;
  cvarFollowMeanAfterFirstAction?: (firstAction: number) => number;
  cvarFollowHingeAfterFirstAction?: (eta: number, firstAction: number) => number;
  cvarFollowHinge?: (eta: number) => number;
  cvarOptMean?: () => number;
  cvarOptHinge?: (eta: number) => number;
  cvarOptRecord?: (eta: number) => number;
  cvarFollowRecordedMean?: () => number;
  cvarFollowRecordedHinge?: (eta: number) => number;
  cvarFollowRecordedSuccess?: () => number;
  cvarRecordedActionAt?: (stateId: number, blue: number, purple: number, yellow: number) => number;
  cvarNodeCount?: () => number;
  solvePrioritizedSparsePi?: (
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
    maxPasses: number,
    maxStates: number,
    maxUpdatesPerPass: number,
    priorityMode: number,
  ) => void;
  prioritizedSparsePiOutcome?: () => number;
  prioritizedSparsePiAction?: () => number;
  prioritizedSparsePiSuccess?: () => number;
  prioritizedSparsePiCost?: () => number;
  prioritizedSparsePiVecB?: () => number;
  prioritizedSparsePiVecP?: () => number;
  prioritizedSparsePiVecY?: () => number;
  prioritizedSparsePiProbabilityGap?: () => number;
  prioritizedSparsePiPasses?: () => number;
  prioritizedSparsePiPeakStates?: () => number;
  prioritizedSparsePiScannedStates?: () => number;
  prioritizedSparsePiChanges?: () => number;
  prioritizedSparsePiFinalPassStates?: () => number;
  prioritizedSparsePiFinalPassScanned?: () => number;
  prioritizedSparsePiSuccessInvariantChecks?: () => number;
  prioritizedSparsePiSuccessInvariantMaxGap?: () => number;
  prioritizedSparsePiInitialCost?: () => number;
  prioritizedSparsePiInitialSuccess?: () => number;
  prioritizedSparsePiOverrideCount?: () => number;
  prioritizedSparsePiActionAt?: (
    stateId: number,
    blueUses: number,
    purpleUses: number,
    yellowUses: number,
  ) => number;
  releasePrioritizedSparsePi?: () => void;
};
