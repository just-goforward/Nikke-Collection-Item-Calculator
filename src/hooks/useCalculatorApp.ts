import { useCallback, useRef, useState } from "react";

import { formatFlooredPercent, formatInteger, formatPercent } from "../format";
import { STRATEGY_META, transition } from "../solver";
import type { Grade, ProgressEvent, SolverInput } from "../types";
import type {
  CandidateView,
  DetailView,
  LoadingView,
  ResultView,
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

export function useCalculatorApp() {
  const [resultView, setResultView] = useState<ResultView>(EMPTY_RESULT);
  const [detailView, setDetailView] = useState<DetailView>(EMPTY_DETAIL);
  const [validationView, setValidationView] = useState<ValidationView>(INITIAL_VALIDATION);
  const [loading, setLoading] = useState<LoadingView>({
    active: false,
    text: DEFAULT_LOADING_TEXT,
  });
  const latestResultRef = useRef<SolverResult | null>(null);
  const pendingStatsEventRef = useRef<PendingStatsEvent | null>(null);

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
    strategy,
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
    (result: SolverResult) => {
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
      setResultView({
        type: "recommendation",
        kit: best.firstAction,
        count: run.count,
        multiUse: run.count > 1,
      });
      const strategyKey = result.stats?.strategy || result.input.strategy || strategy;
      const candidates: CandidateView[] = (result.topCandidates || []).map((candidate, index) => ({
        rankLabel: index === 0 ? "추천" : `후보 ${index + 1}`,
        kit: candidate.firstAction,
        count: candidate.run?.count || 1,
        successProbability: formatPercent(candidate.successProbability, 2),
      }));
      setDetailView({
        type: "metrics",
        strategyLabel: STRATEGY_META[strategyKey]?.label || STRATEGY_META.single.label,
        successProbability: formatPercent(best.successProbability, 2),
        greatSuccessProbability: formatPercent(
          run.greatSuccessProbability || best.firstProbability,
          1,
        ),
        stateCount: formatInteger(Number(result.stats?.states || 0)),
        candidates,
        monteCarloRuns: monteCarloRuns().toLocaleString("ko-KR"),
      });
      setValidationView(INITIAL_VALIDATION);
    },
    [strategy],
  );

  const runCalculation = useCallback(async () => {
    const input = collectInput();
    finalizePendingStatsEvent(input);
    setLoading({ active: true, text: DEFAULT_LOADING_TEXT });
    setCalculateBusy(true);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      const result = await solveBestAvailable(input);
      renderResult(result);
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
  }, [collectInput, finalizePendingStatsEvent, renderResult, setCalculateBusy, solveBestAvailable]);

  const runMonteCarloValidation = useCallback(async () => {
    const latest = latestResultRef.current;
    if (!latest?.possible || !latest.input) return;
    const runs = monteCarloRuns();
    const input: SolverInput = {
      start: { ...latest.input.start },
      strategy: latest.input.strategy || strategy,
      stock: { ...latest.input.stock },
    };
    const resultKey = inputKey(input);
    const seed = makeMonteCarloSeed();
    setValidationView({
      disabled: true,
      buttonLabel: "시도 중",
      message: "가상의 니붕이 0명이 시도를 완료했습니다.",
    });
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
            strategy: currentLatest.input.strategy || strategy,
            stock: currentLatest.input.stock,
          })
        : "";
      if (latestKey !== resultKey) return;
      setValidationView({
        disabled: false,
        buttonLabel: "다시 시켜보기",
        message: `이번엔 가상의 니붕이 ${formatInteger(monteCarlo.runs)}명 중 ${formatInteger(
          monteCarlo.completed || 0,
        )}명(${formatFlooredPercent(monteCarlo.successProbability, 1)})이 SR 15에 성공했습니다.`,
      });
    } catch {
      setValidationView({
        disabled: false,
        buttonLabel: "니붕이들 시켜보기",
        message: "검증 중 오류가 발생했습니다.",
      });
    }
  }, [strategy, validateBestAvailable]);

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
    actions: {
      setThemeMode,
      setGrade: stateActions.setGrade,
      setLevel: stateActions.setLevel,
      setExp: stateActions.setExp,
      setStock: stateActions.setStock,
      setStrategy: stateActions.setStrategy,
      calculate: runCalculation,
      reset: resetInputs,
      applyOutcome,
      applyConvert,
      runMonteCarloValidation,
      setModalAttempt,
      submitSuccessAttempt,
    },
  };
}
