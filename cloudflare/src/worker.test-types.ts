export type AdminDiagnosticsBody = {
  windowDays?: number;
  since?: string;
  allTime?: Array<{
    forecastId: string;
    solverVersion: string;
    solverPhase: string;
    events: number;
    firstDate: string | null;
    lastDate: string | null;
  }>;
  window?: Array<{
    forecastId: string;
    solverVersion: string;
    solverPhase: string;
    events: number;
  }>;
  daily?: Array<{
    date: string;
    forecastId: string;
    solverVersion: string;
    solverPhase: string;
    events: number;
  }>;
  nodeCounts?: Array<{
    forecastId: string;
    solverBackend: string;
    nodeCountBucket: string;
    events: number;
  }>;
  runtime?: Array<{
    forecastId: string;
    solverVersion: string;
    solverPhase: string;
    solverBackend: string;
    fallbackFrom: string;
    fallbackReason: string;
    memoryStrategy: string;
    minEfMemoTier: string;
    phase2MemoTier: string;
    phase2MemoRetried: string;
    grade: string;
    level: number;
    expBucket: number;
    stockBuckets: { blue: string; purple: string; yellow: string };
    nodeCountBucket: string;
    attemptedNodeCountBucket: string;
    solveMsBucket: string;
    events: number;
  }>;
  cache?: Array<{
    diagnosticVersion: number;
    forecastId: string;
    requestedBackend: string;
    terminalBackend: string;
    executionKind: string;
    events: number;
  }>;
  runtimeDataPolicy?: {
    trustworthyFromDiagnosticVersion: number;
    filteredToTrustworthyVersions: boolean;
    legacyClassification: string;
    solveMsSemantics: string;
  };
  recoveryDataPolicy?: {
    aggregatesAreIndependent: boolean;
    ratioWarning: string;
  };
  recoveryRungs?: Array<{
    forecastId: string;
    policyVersion: string;
    requestedBackend: string;
    rungBackend: string;
    rungExit: string;
    deviceType: string;
    events: number;
  }>;
  recoveryTerminals?: Array<{
    forecastId: string;
    policyVersion: string;
    requestedBackend: string;
    terminalBackend: string;
    terminalOutcome: string;
    events: number;
  }>;
  fallbacks?: Array<{
    forecastId: string;
    attemptedBackend: string;
    events: number;
    fallbackEvents: number;
    fallbackRate: number;
  }>;
  latencies?: Array<{
    forecastId: string;
    solverVersion: string;
    solverPhase: string;
    solverBackend: string;
    solveMsBucket: string;
    events: number;
  }>;
  supplyForecastRegistry?: {
    version: number;
    activeForecastId: string;
    forecasts: Array<{
      id: string;
      basisDays: number;
      effectiveFrom: string;
      expectedGain: { blue: number; purple: number; yellow: number };
    }>;
  };
};
