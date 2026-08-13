import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from "react";

import { isWorkerSolverBackend, type WorkerSolverBackend } from "../../shared/workerProtocol";
import { formatFlooredPercent } from "../format";
import { message } from "../i18n/locale";
import { ignoreExpectedError } from "../lib/errorHandling";
import type { ProgressEvent, SolverInput } from "../types";
import type { ValidationView } from "../ui-types";
import { makeValidationCharts } from "../view-models/validationCharts";
import type { RuntimeInvariantReporter } from "./calculatorDiagnostics";
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
  options?: { backend?: WorkerSolverBackend; force?: boolean; seed?: number },
) => Promise<MonteCarloResult>;

type ValidationFlowOptions = {
  generationRef: MutableRef<number>;
  latestResultRef: MutableRef<SolverResult | null>;
  reportRuntimeInvariant: RuntimeInvariantReporter;
  setValidationView: Dispatch<SetStateAction<ValidationView>>;
  validateBestAvailable: ValidateBestAvailable;
};

type ValidationViewSetter = Dispatch<SetStateAction<ValidationView>>;

export function useValidationCoordinator({
  cancelValidationForSolve,
  reportRuntimeInvariant,
  setValidationView,
}: {
  cancelValidationForSolve: () => WorkerTaskError | null;
  reportRuntimeInvariant: RuntimeInvariantReporter;
  setValidationView: ValidationViewSetter;
}) {
  const generationRef = useRef(0);
  const invalidateValidation = useCallback(() => {
    generationRef.current += 1;
    const invariantError = cancelValidationForSolve();
    if (invariantError) {
      console.error("Validation cancellation invariant failed.", invariantError.code);
      reportRuntimeInvariant("validation_cancel_failed", "validation", "unknown");
    }
  }, [cancelValidationForSolve, reportRuntimeInvariant]);
  const prepareForSolve = useCallback(() => {
    generationRef.current += 1;
    const invariantError = cancelValidationForSolve();
    if (invariantError) {
      reportRuntimeInvariant("validation_cancel_failed", "validation", "unknown");
      throw invariantError;
    }
    setValidationView((current) =>
      current.disabled
        ? {
            ...current,
            buttonLabel: INITIAL_VALIDATION.buttonLabel,
            disabled: false,
            message: message("validation.cancelled"),
            status: "cancelled",
          }
        : current,
    );
  }, [cancelValidationForSolve, reportRuntimeInvariant, setValidationView]);
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

export function validationBackendFromResult(result: SolverResult): WorkerSolverBackend | undefined {
  const backend = result.stats?.solverBackend;
  return isWorkerSolverBackend(backend) ? backend : undefined;
}

function setValidationStarted(setValidationView: ValidationViewSetter) {
  setValidationView((current) => ({
    ...current,
    disabled: true,
    buttonLabel: message("validation.runningButton"),
    message: message("validation.running"),
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
      message: message("validation.progress", { count: scanned }),
    }));
  };
}

function validationCompleteMessage(monteCarlo: MonteCarloResult) {
  return message("validation.complete", {
    runs: monteCarlo.runs,
    successes: monteCarlo.completed || 0,
    percent: formatFlooredPercent(monteCarlo.successProbability, 1),
  });
}

function setValidationComplete(
  setValidationView: ValidationViewSetter,
  monteCarlo: MonteCarloResult,
  expectedProbability: number,
) {
  const validationCharts = makeValidationCharts(monteCarlo, expectedProbability);
  setValidationView({
    disabled: false,
    buttonLabel: message("validation.retry"),
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
    message: message("validation.error"),
    status: "error",
  }));
}

export function useValidationFlow({
  generationRef,
  latestResultRef,
  reportRuntimeInvariant,
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
    const backend = validationBackendFromResult(latest);
    setValidationStarted(setValidationView);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!isCurrent()) return;
    try {
      const monteCarlo = await validateBestAvailable(
        input,
        runs,
        validationProgressHandler(setValidationView, runs, isCurrent),
        {
          ...(backend ? { backend } : {}),
          force: true,
          seed,
        },
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
          reportRuntimeInvariant("unexpected_validation_cancellation", "validation", "unknown");
          setValidationFailed(setValidationView);
          return;
        }
        if (error.cancellation.reason === "component_unmount") return;
        setValidationView((current) => ({
          ...current,
          buttonLabel: INITIAL_VALIDATION.buttonLabel,
          disabled: false,
          message: message("validation.cancelled"),
          status: "cancelled",
        }));
        return;
      }
      ignoreExpectedError("validation errors are reported through the validation view", error);
      setValidationFailed(setValidationView);
    }
  }, [
    generationRef,
    latestResultRef,
    reportRuntimeInvariant,
    setValidationView,
    validateBestAvailable,
  ]);
}
