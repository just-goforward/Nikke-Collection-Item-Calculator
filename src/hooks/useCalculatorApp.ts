import { useCallback, useEffect, useRef, useState } from "react";
import { STATE_FEEDBACK_VISIBLE_MS } from "../components/stateFeedbackAnimations";
import { formatFlooredPercent, formatInteger, formatNumber, formatPercent } from "../format";
import { EXPECTED_28_DAY_GAIN, STRATEGY_META, transition } from "../solver";
import type { Grade, Kit, ProgressEvent, SolverInput } from "../types";
import type {
  CandidateView,
  DetailView,
  LoadingView,
  RecommendationAction,
  ResultView,
  StateChangeFeedback,
  ValidationSuccessDistributionView,
  ValidationView,
} from "../ui-types";
import {
  DEFAULT_LOADING_TEXT,
  DEFAULT_STOCK_NOTICE,
  EMPTY_DETAIL,
  EMPTY_RESULT,
  INITIAL_VALIDATION,
  inputKey,
  KIT_KEYS,
  makeMonteCarloSeed,
  makeSolverDiagnosticEvent,
  makeStatsEvent,
  monteCarloRuns,
  type PendingStatsEvent,
  type SolverResult,
  sameState,
} from "./calculatorShared";
import { useCalculatorState } from "./useCalculatorState";
import { useOutcomeFlow } from "./useOutcomeFlow";
import { useSolverWorker } from "./useSolverWorker";
import { useStats } from "./useStats";
import { useTheme } from "./useTheme";

const KIT_SHORT_LABELS: Record<Kit, string> = {
  blue: "파랑",
  purple: "보라",
  yellow: "노랑",
};

function formatKitPieces(value: number) {
  return `약 ${formatInteger(Math.round(value))}개`;
}

function formatSupplyDays(pieces: number, kit: Kit) {
  if (pieces <= 0) return "0일치";
  const days = (pieces / EXPECTED_28_DAY_GAIN[kit]) * 28;
  return `${days < 10 ? days.toFixed(1) : formatInteger(Math.round(days))}일치`;
}

function formatReadablePercent(value: number, digits = 4) {
  const percent = value * 100;
  const rounded = Number(percent.toFixed(digits));
  if (Math.abs(rounded - Math.round(rounded)) <= 1e-10) {
    return `${formatInteger(Math.round(rounded))}%`;
  }
  return `${formatNumber(rounded, digits)}%`;
}

function formatCompactPercent(value: number, digits = 2) {
  return formatReadablePercent(value, digits);
}

function formatKitBreakdown(vector: Partial<Record<Kit, number>> = {}) {
  return KIT_KEYS.map(
    (kit) => `${KIT_SHORT_LABELS[kit]} ${formatInteger(Math.round(Number(vector[kit] || 0)))}`,
  ).join(" · ");
}

function makeBinomialCurvePoints(runs: number, probability: number, xMin: number, xMax: number) {
  if (probability <= 0 || probability >= 1 || xMax <= xMin) return [];
  const mode = Math.min(runs, Math.max(0, Math.floor((runs + 1) * probability)));
  const weights = new Map<number, number>([[mode, 1]]);
  for (let x = mode; x < xMax; x += 1) {
    const current = weights.get(x) || 0;
    const next =
      current * ((runs - x) / (x + 1)) * (probability / Math.max(1e-12, 1 - probability));
    weights.set(x + 1, Number.isFinite(next) ? next : 0);
  }
  for (let x = mode; x > xMin; x -= 1) {
    const current = weights.get(x) || 0;
    const previous =
      current * (x / (runs - x + 1)) * ((1 - probability) / Math.max(1e-12, probability));
    weights.set(x - 1, Number.isFinite(previous) ? previous : 0);
  }
  const maxWeight = Math.max(...weights.values(), 1e-12);
  const step = Math.max(1, Math.ceil((xMax - xMin) / 180));
  const points: Array<{ x: number; y: number }> = [];
  for (let x = xMin; x <= xMax; x += step) {
    points.push({ x, y: Math.max(0, Math.min(1, (weights.get(x) || 0) / maxWeight)) });
  }
  if (points[points.length - 1]?.x !== xMax) {
    points.push({ x: xMax, y: Math.max(0, Math.min(1, (weights.get(xMax) || 0) / maxWeight)) });
  }
  return points;
}

function makeValidationCharts(
  monteCarlo: {
    runs: number;
    completed: number;
    successProbability: number;
    vector?: Partial<Record<Kit, number>>;
    quantiles?: Record<Kit, { p50: number; p90: number; p95: number }>;
    depletion?: number;
  },
  expectedProbability: number,
) {
  const expected = Math.min(1, Math.max(0, Number(expectedProbability || 0)));
  const probability = Math.min(1, Math.max(0, Number(monteCarlo.successProbability || 0)));
  const runs = Math.max(1, Math.trunc(Number(monteCarlo.runs || 0)));
  const observedCount = Math.max(0, Math.min(runs, Math.trunc(Number(monteCarlo.completed || 0))));
  const meanCount = runs * expected;
  const variance = runs * expected * (1 - expected);
  const standardDeviation = Math.sqrt(Math.max(0, variance));
  const lowerCount = Math.max(0, Math.round(meanCount - 1.96 * standardDeviation));
  const upperCount = Math.min(runs, Math.round(meanCount + 1.96 * standardDeviation));
  const spread = Math.max(1, standardDeviation);
  let xMin = Math.max(0, Math.floor(Math.min(meanCount - 4 * spread, observedCount - spread)));
  let xMax = Math.min(runs, Math.ceil(Math.max(meanCount + 4 * spread, observedCount + spread)));
  if (xMax <= xMin) {
    xMin = Math.max(0, Math.floor(meanCount - 1));
    xMax = Math.min(runs, Math.ceil(meanCount + 1));
  }
  const deterministic = standardDeviation <= 1e-9;
  const skewness = variance > 0 ? (1 - 2 * expected) / Math.sqrt(variance) : 0;
  const excessKurtosis = variance > 0 ? (1 - 6 * expected * (1 - expected)) / variance : 0;
  const successDistribution: ValidationSuccessDistributionView = {
    kind: deterministic ? "deterministic" : "binomial",
    expectedRateLabel: formatReadablePercent(expected, 4),
    observedRateLabel: formatPercent(probability, 2),
    expectedCountLabel: `평균 ${formatNumber(meanCount, 1)}명`,
    observedCountLabel: `이번 ${formatInteger(observedCount)}명`,
    intervalLabel: deterministic
      ? "결과 폭 없음"
      : `95% 근사 ${formatInteger(lowerCount)} ~ ${formatInteger(upperCount)}명`,
    standardDeviationLabel: `표준편차 ${formatNumber(standardDeviation, 1)}명`,
    skewnessLabel: `왜도 ${formatNumber(skewness, 3)}`,
    kurtosisLabel: `초과첨도 ${formatNumber(excessKurtosis, 3)}`,
    xMin,
    xMax,
    meanCount,
    observedCount,
    points: makeBinomialCurvePoints(runs, expected, xMin, xMax),
  };
  return { successDistribution };
}

function recommendationFromResult(result: SolverResult | null): RecommendationAction | null {
  if (!result?.possible || !result.best) return null;
  return {
    kit: result.best.firstAction,
    count: result.best.run?.count || 1,
  };
}

export function useCalculatorApp() {
  const [resultView, setResultView] = useState<ResultView>(EMPTY_RESULT);
  const [detailView, setDetailView] = useState<DetailView>(EMPTY_DETAIL);
  const [validationView, setValidationView] = useState<ValidationView>(INITIAL_VALIDATION);
  const [stateFeedback, setStateFeedback] = useState<StateChangeFeedback | null>(null);
  const [loading, setLoading] = useState<LoadingView>({
    active: false,
    text: DEFAULT_LOADING_TEXT,
  });
  const stateFeedbackIdRef = useRef(0);
  const actionTransitionIdRef = useRef(0);
  const latestResultRef = useRef<SolverResult | null>(null);
  const pendingStatsEventRef = useRef<PendingStatsEvent | null>(null);

  useEffect(() => {
    if (!stateFeedback) return;
    const timeoutId = window.setTimeout(() => setStateFeedback(null), STATE_FEEDBACK_VISIBLE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [stateFeedback]);

  const recordStateFeedback = useCallback(
    (from: StateChangeFeedback["from"], to: StateChangeFeedback["to"]) => {
      if (from.grade === to.grade && from.level === to.level) return;
      const nextId = stateFeedbackIdRef.current + 1;
      stateFeedbackIdRef.current = nextId;
      const crossesSegment = Math.floor(from.level / 5) !== Math.floor(to.level / 5);
      const type: StateChangeFeedback["type"] =
        from.grade !== to.grade ? "grade" : crossesSegment ? "segment" : "level";
      const label =
        type === "grade"
          ? `${from.grade} → ${to.grade} · Lv ${to.level}`
          : type === "segment"
            ? `구간 이동 Lv ${from.level} → ${to.level}`
            : `Lv ${from.level} → Lv ${to.level}`;
      setStateFeedback({
        id: nextId,
        type,
        label,
        from: { ...from },
        to: { ...to },
      });
    },
    [],
  );

  const markInputChanged = useCallback((isManualStockEditRequired: boolean) => {
    latestResultRef.current = null;
    setValidationView(INITIAL_VALIDATION);
    if (!isManualStockEditRequired) {
      setResultView(EMPTY_RESULT);
      setDetailView(EMPTY_DETAIL);
    }
  }, []);

  const renderMaxLevelState = useCallback((nextGrade: Grade, nextLevel: number) => {
    latestResultRef.current = null;
    setValidationView(INITIAL_VALIDATION);
    if (nextGrade === "R" && nextLevel >= 15) {
      setResultView({ type: "convertRecommendation" });
      setDetailView({
        type: "empty",
        message: "R 15레벨은 등급 교체 가능 상태입니다. SR 5레벨로 교체할 수 있습니다.",
      });
      return;
    }
    if (nextGrade === "SR" && nextLevel >= 15) {
      setResultView({ type: "callout", message: "SR 15레벨입니다. 최종 목표 상태입니다." });
      setDetailView({ type: "empty", message: "SR 15레벨은 최종 목표 상태입니다." });
    }
  }, []);

  const calculatorState = useCalculatorState({
    onInputChanged: markInputChanged,
    onMaxLevelState: renderMaxLevelState,
  });
  const {
    grade,
    stock,
    manualStockEditRequired,
    stateRef,
    statePanel,
    solvePanel,
    setCollectionState,
    setStockCountForKit,
    setManualStockEditRequired,
    setCalculateBusy,
    collectInput,
    currentStateSnapshot,
    resetState,
    actions: stateActions,
  } = calculatorState;
  const { themeMode, setThemeMode } = useTheme(grade);
  const { statsView, queueStatsEvent } = useStats();

  const currentStockSnapshot = useCallback(() => stateRef.current.stock, [stateRef]);
  const {
    modal,
    applyOutcome,
    applyConvert,
    setModalAttempt,
    submitSuccessAttempt,
    resetOutcomeFlow,
  } = useOutcomeFlow({
    latestResultRef,
    pendingStatsEventRef,
    currentStockSnapshot,
    setCollectionState,
    setStockCountForKit,
    setManualStockEditRequired,
    setResultView,
    setDetailView,
    setValidationView,
    queueStatsEvent,
    currentStateSnapshot,
    recordStateFeedback,
  });

  const updateProgress = useCallback((progress: ProgressEvent) => {
    const scanned = Math.trunc(Number(progress.scanned || 0));
    if (progress.phase === "mdp") {
      setLoading({
        active: true,
        text: `${formatInteger(scanned)}개 상태를 평가했습니다.`,
      });
      return;
    }
    if (progress.phase === "done") {
      setLoading({ active: true, text: "결과를 정리하고 있습니다." });
    }
  }, []);

  const { solveBestAvailable, validateBestAvailable } = useSolverWorker(updateProgress);

  const finalizePendingStatsEvent = useCallback(
    (input: SolverInput) => {
      const pending = pendingStatsEventRef.current;
      if (!pending) return;
      pendingStatsEventRef.current = null;

      if (!sameState(currentStateSnapshot(), pending.resultState)) return;
      const before = pending.stockBefore;
      const after = input.stock;
      const usedKits = before[pending.kit] - after[pending.kit];
      const successAttempt = usedKits / 10;
      const otherChanged = KIT_KEYS.some(
        (kit) => kit !== pending.kit && before[kit] !== after[kit],
      );
      const valid =
        !otherChanged &&
        Number.isInteger(successAttempt) &&
        successAttempt >= 1 &&
        successAttempt <= pending.recommendedUses &&
        usedKits > 0;
      if (!valid) return;
      queueStatsEvent(
        makeStatsEvent({
          start: pending.start,
          kit: pending.kit,
          recommendedUses: pending.recommendedUses,
          outcome: "great_success",
          successAttempt,
          stockBefore: before,
          stockAfter: after,
          resultState: pending.resultState,
        }),
      );
    },
    [currentStateSnapshot, queueStatsEvent],
  );

  const renderResult = useCallback(
    (result: SolverResult, previousAction?: RecommendationAction | null) => {
      latestResultRef.current = result;
      if (result.terminal) {
        setResultView({ type: "callout", message: result.message || "완료 상태입니다." });
        setDetailView({ type: "empty", message: "완료 상태입니다." });
        return;
      }
      if (result.convertOnly) {
        setResultView({ type: "convertRecommendation" });
        setDetailView({
          type: "empty",
          message: "R 15레벨은 등급 교체 가능 상태입니다. SR 5레벨로 교체할 수 있습니다.",
        });
        return;
      }
      if (!result.possible || !result.best || !result.input) {
        setResultView({
          type: "error",
          message: result.message || "현재 보유 키트로 가능한 행동이 없습니다.",
        });
        setDetailView({ type: "empty", message: "사용 가능한 키트가 부족합니다." });
        return;
      }

      const best = result.best;
      const edge = transition(result.input.start, best.firstAction);
      const run = best.run || {
        count: 1,
        success: edge.success,
        fail: edge.fail,
        greatSuccessProbability: best.firstProbability,
      };
      const actionTransition = previousAction
        ? {
            id: ++actionTransitionIdRef.current,
            previous: previousAction,
          }
        : undefined;
      setResultView({
        type: "recommendation",
        kit: best.firstAction,
        count: run.count,
        actionTransition,
      });
      const strategyKey = result.stats?.strategy || result.input.strategy || "supply";
      const expectedConsumption = KIT_KEYS.map((kit) => {
        const pieces = Number(best.vector?.[kit] || 0);
        return {
          kit,
          pieces: formatKitPieces(pieces),
          supplyDays: formatSupplyDays(pieces, kit),
        };
      });
      const expectedRemaining = KIT_KEYS.map((kit) => {
        const remaining = Math.max(
          0,
          Math.round(Number(result.input?.stock?.[kit] || 0) - Number(best.vector?.[kit] || 0)),
        );
        return `${KIT_SHORT_LABELS[kit]} ${formatInteger(remaining)}개`;
      }).join(" · ");
      const tolerance = Number(result.stats?.probabilityTolerance ?? 0);
      const candidates: CandidateView[] = (result.topCandidates || []).map((candidate, index) => {
        const gap = Number(candidate.probabilityGap || 0);
        const excluded = gap > tolerance + 1e-9;
        const candidateVector = candidate.vector || {};
        const totalExpectedKits =
          Number(candidate.totalKits) ||
          KIT_KEYS.reduce((sum, kit) => sum + Number(candidateVector[kit] || 0), 0);
        return {
          rankLabel: index === 0 && !excluded ? "추천" : `후보 ${index + 1}`,
          kit: candidate.firstAction,
          count: candidate.run?.count || 1,
          successProbability: formatCompactPercent(candidate.successProbability, 2),
          greatSuccessProbability: formatCompactPercent(
            candidate.run?.greatSuccessProbability ?? candidate.firstProbability,
            1,
          ),
          expectedKits: formatKitPieces(totalExpectedKits),
          expectedBreakdown: formatKitBreakdown(candidateVector),
          excludedReason: excluded ? `허용 확률 차이 초과 (${formatPercent(gap, 2)})` : null,
        };
      });
      setDetailView({
        type: "metrics",
        strategyLabel: STRATEGY_META[strategyKey]?.label || STRATEGY_META.supply.label,
        successProbability: formatReadablePercent(best.successProbability, 2),
        greatSuccessProbability: formatCompactPercent(
          run.greatSuccessProbability ?? best.firstProbability,
          1,
        ),
        stateCount: formatInteger(Number(result.stats?.states || 0)),
        candidates,
        monteCarloRuns: monteCarloRuns().toLocaleString("ko-KR"),
        expectedConsumption,
        expectedRemaining,
      });
      setValidationView(INITIAL_VALIDATION);
    },
    [],
  );

  const solveAndRenderInput = useCallback(
    async (input: SolverInput, previousAction?: RecommendationAction | null) => {
      setLoading({ active: true, text: DEFAULT_LOADING_TEXT });
      setCalculateBusy(true);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      try {
        const result = await solveBestAvailable(input);
        renderResult(result, previousAction);
        const diagnosticEvent = makeSolverDiagnosticEvent(result);
        if (diagnosticEvent) queueStatsEvent(diagnosticEvent);
      } catch (error) {
        latestResultRef.current = null;
        setResultView({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        setDetailView({ type: "empty", message: "오류가 발생했습니다." });
      } finally {
        setLoading({ active: false, text: DEFAULT_LOADING_TEXT });
        setCalculateBusy(false);
      }
    },
    [queueStatsEvent, renderResult, setCalculateBusy, solveBestAvailable],
  );

  const runCalculation = useCallback(async () => {
    const input = collectInput();
    finalizePendingStatsEvent(input);
    await solveAndRenderInput(input);
  }, [collectInput, finalizePendingStatsEvent, solveAndRenderInput]);

  const applyOutcomeAndMaybeCalculate = useCallback(
    async (outcome: "success" | "fail") => {
      const previousAction = recommendationFromResult(latestResultRef.current);
      const applied = applyOutcome(outcome);
      if (applied?.outcome !== "fail") return;
      await solveAndRenderInput(applied.nextInput, previousAction);
    },
    [applyOutcome, solveAndRenderInput],
  );

  const runMonteCarloValidation = useCallback(async () => {
    const latest = latestResultRef.current;
    if (!latest?.possible || !latest.input) return;
    const runs = monteCarloRuns();
    const input: SolverInput = {
      start: { ...latest.input.start },
      strategy: latest.input.strategy || "supply",
      stock: { ...latest.input.stock },
    };
    const resultKey = inputKey(input);
    const seed = makeMonteCarloSeed();
    setValidationView((current) => ({
      ...current,
      disabled: true,
      buttonLabel: "시도 중",
      message: "가상의 니붕이 0명이 시도를 완료했습니다.",
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      const monteCarlo = await validateBestAvailable(
        input,
        runs,
        (progress) => {
          if (progress.phase === "monte-carlo" || progress.phase === "mdp") {
            const scanned = Math.min(runs, Math.trunc(Number(progress.scanned || 0)));
            setValidationView((current) => ({
              ...current,
              message: `가상의 니붕이 ${formatInteger(scanned)}명이 시도를 완료했습니다.`,
            }));
          }
        },
        { force: true, seed },
      );
      const currentLatest = latestResultRef.current;
      const latestKey = currentLatest?.input
        ? inputKey({
            start: currentLatest.input.start,
            strategy: currentLatest.input.strategy || "supply",
            stock: currentLatest.input.stock,
          })
        : "";
      if (latestKey !== resultKey) return;
      const validationCharts = makeValidationCharts(
        monteCarlo,
        Number(latest.best?.successProbability || 0),
      );
      setValidationView({
        disabled: false,
        buttonLabel: "다시 시켜보기",
        message: `이번엔 가상의 니붕이 ${formatInteger(monteCarlo.runs)}명 중 ${formatInteger(
          monteCarlo.completed || 0,
        )}명(${formatFlooredPercent(monteCarlo.successProbability, 1)})이 SR 15에 성공했습니다.`,
        successDistribution: validationCharts.successDistribution,
      });
    } catch {
      setValidationView((current) => ({
        ...current,
        disabled: false,
        buttonLabel: "니붕이들 시켜보기",
        message: "검증 중 오류가 발생했습니다.",
      }));
    }
  }, [validateBestAvailable]);

  const resetInputs = useCallback(() => {
    pendingStatsEventRef.current = null;
    latestResultRef.current = null;
    resetOutcomeFlow();
    resetState();
    setResultView(EMPTY_RESULT);
    setDetailView(EMPTY_DETAIL);
    setValidationView(INITIAL_VALIDATION);
  }, [resetOutcomeFlow, resetState]);

  return {
    statePanel,
    stockPanel: {
      stock,
      needsStockEdit: manualStockEditRequired,
      notice: DEFAULT_STOCK_NOTICE,
    },
    solvePanel,
    resultView,
    detailView,
    validationView,
    statsView,
    loading,
    modal,
    themeMode,
    stateFeedback,
    actions: {
      setThemeMode,
      setGrade: stateActions.setGrade,
      setLevel: stateActions.setLevel,
      setExp: stateActions.setExp,
      setStock: stateActions.setStock,
      calculate: runCalculation,
      reset: resetInputs,
      applyOutcome: applyOutcomeAndMaybeCalculate,
      applyConvert,
      runMonteCarloValidation,
      setModalAttempt,
      submitSuccessAttempt,
    },
  };
}
