import { useCallback, useEffect, useRef } from "react";
import type { SolverInput } from "../types";
import type { SolverResult } from "./calculatorShared";
import type { createServiceCertifiedAdapter } from "./serviceCertifiedAdapter";
import { ServiceCertifiedCancelled } from "./serviceCertifiedTypes";

type Adapter = ReturnType<typeof createServiceCertifiedAdapter>;
const cancelValidationForSolve = () => null;
const validateBestAvailable = async (): Promise<never> => {
  throw new Error("service_certified_validation_disabled");
};

/** No certified runtime/forecast module, Worker, cache or request is created during App boot. */
export function useServiceCertifiedSolver(..._unused: unknown[]) {
  const pending = useRef<Promise<Adapter> | null>(null);
  const ready = useRef<Adapter | null>(null);
  const sequence = useRef(0);
  const unmounted = useRef(false);
  const lifetime = useRef(0);
  const forecastInvalidationRef = useRef<(() => void) | null>(null);
  const checkForecastBoundary = useCallback(() => ready.current?.checkForecastBoundary() ?? true, []);
  const invalidateSolve = useCallback(() => {
    ++sequence.current;
    ready.current?.invalidateSolve();
  }, []);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      ++sequence.current;
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
  ) => {
    const submitted = performance.now();
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
    const adapter = await pending.current;
    if (unmounted.current || lifetime.current !== owner || ticket !== sequence.current)
      throw new ServiceCertifiedCancelled(unmounted.current);
    return adapter.solveBestAvailable(input, onCurrent, submitted);
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
