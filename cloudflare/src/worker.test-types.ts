type StatisticsDateBasis = "kst_calendar_date_v1" | "kst_game_day_0500_v2";

export type AdminDiagnosticsBody = {
  windowDays?: number;
  since?: string;
  sinceByDateBasis?: Record<StatisticsDateBasis, string>;
  dateContract?: {
    legacy: { id: StatisticsDateBasis; boundary: string; acceptsNewWrites: boolean };
    current: { id: StatisticsDateBasis; boundary: string; acceptsNewWrites: boolean };
    rowsExposeDateBasis: boolean;
  };
  allTime?: Array<{
    dateBasis: StatisticsDateBasis;
    forecastId: string;
    solverVersion: string;
    solverPhase: string;
    events: number;
    firstDate: string | null;
    lastDate: string | null;
  }>;
  window?: Array<{
    dateBasis: StatisticsDateBasis;
    forecastId: string;
    solverVersion: string;
    solverPhase: string;
    events: number;
  }>;
  daily?: Array<{
    dateBasis: StatisticsDateBasis;
    date: string;
    forecastId: string;
    solverVersion: string;
    solverPhase: string;
    events: number;
  }>;
  nodeCounts?: Array<{
    dateBasis: StatisticsDateBasis;
    forecastId: string;
    solverBackend: string;
    nodeCountBucket: string;
    events: number;
  }>;
  runtime?: Array<{
    dateBasis: StatisticsDateBasis;
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
    dateBasis: StatisticsDateBasis;
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
    dateBasis: StatisticsDateBasis;
    forecastId: string;
    policyVersion: string;
    requestedBackend: string;
    rungBackend: string;
    rungExit: string;
    deviceType: string;
    events: number;
  }>;
  recoveryTerminals?: Array<{
    dateBasis: StatisticsDateBasis;
    forecastId: string;
    policyVersion: string;
    requestedBackend: string;
    terminalBackend: string;
    terminalOutcome: string;
    events: number;
  }>;
  fallbacks?: Array<{
    dateBasis: StatisticsDateBasis;
    forecastId: string;
    attemptedBackend: string;
    events: number;
    fallbackEvents: number;
    fallbackRate: number;
  }>;
  latencies?: Array<{
    dateBasis: StatisticsDateBasis;
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
