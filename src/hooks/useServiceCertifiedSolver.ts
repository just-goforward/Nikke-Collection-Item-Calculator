import { adaptiveShell } from "../lib/rootCandidate";
import { useCallback, useEffect, useRef } from "react";
import type { SolverInput } from "../types";
import type { SolverResult } from "./calculatorShared";
import { ServiceCertifiedCancelled, type ServiceCertifiedAdapter } from "./serviceCertifiedTypes";
import { withPreviewResume } from "./previewResume";
import { serviceH14DeadlineMs } from "../serviceH14/deadline";
const cancelValidationForSolve = () => null;
const validateBestAvailable = async (): Promise<never> => {
  throw new Error("service_certified_validation_disabled");
};

/** No certified runtime/forecast module, Worker, cache or request is created during App boot. */
export function useServiceCertifiedSolver(..._unused: unknown[]) {
  const pending = useRef<Promise<ServiceCertifiedAdapter> | null>(null);
  const ready = useRef<ServiceCertifiedAdapter | null>(null);
  const sequence = useRef(0);
  const unmounted = useRef(false);
  const lifetime = useRef(0);
  const resumeOwner = useRef<AbortController | null>(null);
  const forecastInvalidationRef = useRef<(() => void) | null>(null);
  const checkForecastBoundary = useCallback(() => ready.current?.checkForecastBoundary() ?? true, []);
  const invalidateSolve = useCallback(() => {
    ++sequence.current;
    resumeOwner.current?.abort();
    ready.current?.invalidateSolve();
  }, []);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      ++sequence.current;
      resumeOwner.current?.abort();
      ++lifetime.current;
      const previous = pending.current;
      const active = ready.current;
      pending.current = null;
      ready.current = null;
      // Stop the watch synchronously, before a queued observation can publish.
      const disposal = active ? active.dispose() : previous?.then((adapter) => adapter.dispose());
      void disposal?.catch((error: unknown) => {
        console.error("Service certified client disposal failed.", error);
      });
    };
  }, []);
  const solveBestAvailable = useCallback(async (
    input: SolverInput,
    onCurrent?: (result: SolverResult) => void,
    parentInputHash?: string,
  ) => {
    const submitted = performance.now(), epoch = Date.now();
    const ticket = ++sequence.current;
    const owner = lifetime.current;
    pending.current ??= import("./serviceCertifiedAdapter").then((module) => {
      const adapter = module.createServiceCertifiedAdapter(() => {
        if (unmounted.current || lifetime.current !== owner || ready.current !== adapter) return;
        ++sequence.current;
        forecastInvalidationRef.current?.();
      });
      if (!unmounted.current && lifetime.current === owner) ready.current = adapter;
      return adapter;
    });
    resumeOwner.current?.abort();
    const solve = async (retry: boolean, start: number, epoch: number) => {
      const adapter = await pending.current!;
      if (unmounted.current || lifetime.current !== owner || ticket !== sequence.current)
        throw new ServiceCertifiedCancelled(unmounted.current);
      return adapter.solveBestAvailable(input, onCurrent, start, retry ? undefined : parentInputHash, epoch);
    };
    if (!adaptiveShell) return solve(false, submitted, epoch);
    const logical = new AbortController();
    resumeOwner.current = logical;
    try { return await withPreviewResume(serviceH14DeadlineMs(input.start), logical.signal, solve, submitted, epoch); }
    finally { if (resumeOwner.current === logical) resumeOwner.current = null; }
  }, []);
  return {
    solveBestAvailable,
    invalidateSolve,
    checkForecastBoundary,
    forecastInvalidationRef,
    cancelValidationForSolve,
    // A programmatic call is also refused: the certified branch never invokes legacy validation.
    validateBestAvailable,
  };
}
