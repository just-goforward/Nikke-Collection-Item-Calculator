import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from "react";

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
import { WorkerTaskCancelled, type WorkerTaskError } from "./solverWorkerClient";

type MutableRef<T> = { current: T };

type ValidateBestAvailable = (
  input: SolverInput,
  runs: number,
  onProgress: (progress: ProgressEvent) => void,
  options?: { force?: boolean; seed?: number },
) => Promise<MonteCarloResult>;

type ValidationFlowOptions = {
  generationRef: MutableRef<number>;
  latestResultRef: MutableRef<SolverResult | null>;
  setValidationView: Dispatch<SetStateAction<ValidationView>>;
  validateBestAvailable: ValidateBestAvailable;
};

type ValidationViewSetter = Dispatch<SetStateAction<ValidationView>>;

export function useValidationCoordinator({
  cancelValidationForSolve,
  setValidationView,
}: {
  cancelValidationForSolve: () => WorkerTaskError | null;
  setValidationView: ValidationViewSetter;
}) {
  const generationRef = useRef(0);
  const invalidateValidation = useCallback(() => {
    generationRef.current += 1;
    const invariantError = cancelValidationForSolve();
    if (invariantError) {
      console.error("Validation cancellation invariant failed.", invariantError.code);
    }
  }, [cancelValidationForSolve]);
  const prepareForSolve = useCallback(() => {
    generationRef.current += 1;
    const invariantError = cancelValidationForSolve();
    if (invariantError) throw invariantError;
    setValidationView((current) =>
      current.disabled
        ? {
            ...current,
            buttonLabel: INITIAL_VALIDATION.buttonLabel,
            disabled: false,
            message: "계산을 우선하기 위해 검증을 취소했습니다.",
            status: "cancelled",
          }
        : current,
    );
  }, [cancelValidationForSolve, setValidationView]);
  return { generationRef, invalidateValidation, prepareForSolve };
}

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
    message: "가상의 니붕이들이 검산을 진행하고 있습니다.",
    stageReach: null,
    status: "running",
  }));
}

function validationProgressHandler(
  setValidationView: ValidationViewSetter,
  runs: number,
  isCurrent: () => boolean,
) {
  return (progress: ProgressEvent) => {
    if (!isCurrent()) return;
    if (progress.phase !== "monte-carlo" && progress.phase !== "mdp") return;
    const scanned = Math.min(runs, Math.trunc(Number(progress.scanned || 0)));
    if (scanned <= 0) return;
    setValidationView((current) => ({
      ...current,
      message: `가상의 니붕이 ${formatInteger(scanned)}명이 시도를 완료했습니다.`,
    }));
  };
}

function validationCompleteMessage(monteCarlo: MonteCarloResult) {
  return `가상의 니붕이 ${formatInteger(monteCarlo.runs)}명 중 ${formatInteger(
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
    status: "complete",
    stageReach: validationCharts.stageReach,
  });
}

function setValidationFailed(setValidationView: ValidationViewSetter) {
  setValidationView((current) => ({
    ...current,
    disabled: false,
    buttonLabel: INITIAL_VALIDATION.buttonLabel,
    message: "검증 중 오류가 발생했습니다.",
    status: "error",
  }));
}

export function useValidationFlow({
  generationRef,
  latestResultRef,
  setValidationView,
  validateBestAvailable,
}: ValidationFlowOptions) {
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [generationRef],
  );

  return useCallback(async () => {
    const latest = latestResultRef.current;
    if (!latest?.possible || !latest.input) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    const runs = monteCarloRuns();
    const input = validationInputFromResult(latest);
    const resultKey = inputKey(input);
    const isCurrent = () =>
      generationRef.current === generation &&
      solverInputKeyFromResult(latestResultRef.current) === resultKey;
    const seed = makeMonteCarloSeed();
    setValidationStarted(setValidationView);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!isCurrent()) return;
    try {
      const monteCarlo = await validateBestAvailable(
        input,
        runs,
        validationProgressHandler(setValidationView, runs, isCurrent),
        { force: true, seed },
      );
      if (!isCurrent()) return;
      setValidationComplete(
        setValidationView,
        monteCarlo,
        Number(latest.best?.successProbability || 0),
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof WorkerTaskCancelled) {
        if (error.cancellation.task !== "validate") {
          console.error("Unexpected solve cancellation reached the validation flow.");
          setValidationFailed(setValidationView);
          return;
        }
        if (error.cancellation.reason === "component_unmount") return;
        setValidationView((current) => ({
          ...current,
          buttonLabel: INITIAL_VALIDATION.buttonLabel,
          disabled: false,
          message: "계산을 우선하기 위해 검증을 취소했습니다.",
          status: "cancelled",
        }));
        return;
      }
      ignoreExpectedError("validation errors are reported through the validation view", error);
      setValidationFailed(setValidationView);
    }
  }, [generationRef, latestResultRef, setValidationView, validateBestAvailable]);
}
