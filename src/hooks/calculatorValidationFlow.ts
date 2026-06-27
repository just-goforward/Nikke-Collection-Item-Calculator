import { type Dispatch, type SetStateAction, useCallback } from "react";

import { formatFlooredPercent, formatInteger } from "../format";
import { ignoreExpectedError } from "../lib/errorHandling";
import type { ProgressEvent, SolverInput } from "../types";
import type { ValidationView } from "../ui-types";
import { makeValidationCharts } from "../view-models/validationCharts";
import {
  INITIAL_VALIDATION,
  inputKey,
  type MonteCarloResult,
  makeMonteCarloSeed,
  monteCarloRuns,
  type SolverResult,
} from "./calculatorShared";

type MutableRef<T> = { current: T };

type ValidateBestAvailable = (
  input: SolverInput,
  runs: number,
  onProgress: (progress: ProgressEvent) => void,
  options?: { force?: boolean; seed?: number },
) => Promise<MonteCarloResult>;

type ValidationFlowOptions = {
  latestResultRef: MutableRef<SolverResult | null>;
  setValidationView: Dispatch<SetStateAction<ValidationView>>;
  validateBestAvailable: ValidateBestAvailable;
};

type ValidationViewSetter = Dispatch<SetStateAction<ValidationView>>;

function validationInputFromResult(result: SolverResult): SolverInput {
  if (!result.input) throw new Error("Validation requires a solver input.");
  return {
    start: { ...result.input.start },
    strategy: result.input.strategy || "supply",
    stock: { ...result.input.stock },
  };
}

function solverInputKeyFromResult(result: SolverResult | null) {
  if (!result?.input) return "";
  return inputKey({
    start: result.input.start,
    strategy: result.input.strategy || "supply",
    stock: result.input.stock,
  });
}

function setValidationStarted(setValidationView: ValidationViewSetter) {
  setValidationView((current) => ({
    ...current,
    disabled: true,
    buttonLabel: "시도 중",
    message: "가상의 니붕이 0명이 시도를 완료했습니다.",
  }));
}

function validationProgressHandler(setValidationView: ValidationViewSetter, runs: number) {
  return (progress: ProgressEvent) => {
    if (progress.phase !== "monte-carlo" && progress.phase !== "mdp") return;
    const scanned = Math.min(runs, Math.trunc(Number(progress.scanned || 0)));
    setValidationView((current) => ({
      ...current,
      message: `가상의 니붕이 ${formatInteger(scanned)}명이 시도를 완료했습니다.`,
    }));
  };
}

function validationCompleteMessage(monteCarlo: MonteCarloResult) {
  return `이번엔 가상의 니붕이 ${formatInteger(monteCarlo.runs)}명 중 ${formatInteger(
    monteCarlo.completed || 0,
  )}명(${formatFlooredPercent(monteCarlo.successProbability, 1)})이 SR 15에 성공했습니다.`;
}

function setValidationComplete(
  setValidationView: ValidationViewSetter,
  monteCarlo: MonteCarloResult,
  expectedProbability: number,
) {
  const validationCharts = makeValidationCharts(monteCarlo, expectedProbability);
  setValidationView({
    disabled: false,
    buttonLabel: "다시 시켜보기",
    message: validationCompleteMessage(monteCarlo),
    stageReach: validationCharts.stageReach,
  });
}

function setValidationFailed(setValidationView: ValidationViewSetter) {
  setValidationView((current) => ({
    ...current,
    disabled: false,
    buttonLabel: INITIAL_VALIDATION.buttonLabel,
    message: "검증 중 오류가 발생했습니다.",
  }));
}

export function useValidationFlow({
  latestResultRef,
  setValidationView,
  validateBestAvailable,
}: ValidationFlowOptions) {
  return useCallback(async () => {
    const latest = latestResultRef.current;
    if (!latest?.possible || !latest.input) return;
    const runs = monteCarloRuns();
    const input = validationInputFromResult(latest);
    const resultKey = inputKey(input);
    const seed = makeMonteCarloSeed();
    setValidationStarted(setValidationView);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    try {
      const monteCarlo = await validateBestAvailable(
        input,
        runs,
        validationProgressHandler(setValidationView, runs),
        { force: true, seed },
      );
      if (solverInputKeyFromResult(latestResultRef.current) !== resultKey) return;
      setValidationComplete(
        setValidationView,
        monteCarlo,
        Number(latest.best?.successProbability || 0),
      );
    } catch (error) {
      ignoreExpectedError("validation errors are reported through the validation view", error);
      setValidationFailed(setValidationView);
    }
  }, [latestResultRef, setValidationView, validateBestAvailable]);
}
