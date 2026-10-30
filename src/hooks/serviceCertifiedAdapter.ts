import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import { createBrowserCertifiedClient } from "../certifiedRuntime/browserClient";
import { CERTIFIED_TOTAL_DEADLINE_MS } from "../certifiedRuntime/protocol";
import { certifiedRunError } from "../certifiedUi/runStatus";
import { awaitCertifiedRunPreparation, cancelCertifiedRunWhenHidden } from "../certifiedUi/runVisibility";
import type { SolverInput } from "../types";
import type { SolverResult } from "./calculatorShared";
import { createServiceForecastLifecycle, prepareServiceForecast } from "./serviceCertifiedForecast";
import { serviceCertifiedInput } from "./serviceCertifiedInput";
import { projectServiceCertifiedResult } from "./serviceCertifiedPresentation";
import { ServiceCertifiedCancelled, type ServiceCertifiedSolveOutcome } from "./serviceCertifiedTypes";
import { retainVerifiedAcquisition } from "../analytics/decisionAcquisition";

export { serviceCertifiedInput } from "./serviceCertifiedInput";

/** This module is loaded only after the service's explicit Calculate action. */
export function createServiceCertifiedAdapter(
  onForecastInvalidated?: () => void,
  bindings: {
    prepareForecast?: typeof prepareServiceForecast;
    createClient?: () => Pick<ReturnType<typeof createBrowserCertifiedClient>, "request" | "dispose">;
    projectResult?: typeof projectServiceCertifiedResult;
    projectInput?: typeof serviceCertifiedInput;
    asOf?: () => string;
  } = {},
) {
  let client: Pick<ReturnType<typeof createBrowserCertifiedClient>, "request" | "dispose"> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let sessionId = crypto.randomUUID();
  let disposed = false;
  let forecast: Awaited<ReturnType<typeof createServiceForecastLifecycle>> = null;
  let forecastReady: ReturnType<typeof createServiceForecastLifecycle> | undefined;
  const invalidateSolve = () => {
    ++generation;
    controller?.abort("service_input_changed");
    sessionId = crypto.randomUUID();
    forecast?.forget();
  };
  const checkForecastBoundary = () => forecast?.check() ?? true;
  return {
    invalidateSolve,
    checkForecastBoundary,
    async dispose() {
      disposed = true;
      invalidateSolve();
      forecast?.dispose();
      await client?.dispose();
    },
    async solveBestAvailable(
      source: SolverInput,
      onCurrent?: (result: SolverResult) => void,
      submitted = performance.now(),
    ): Promise<ServiceCertifiedSolveOutcome> {
      if (disposed) throw new ServiceCertifiedCancelled(true);
      const ticket = ++generation;
      controller?.abort("service_new_request");
      const active = new AbortController();
      controller = active;
      const input = structuredClone(source);
      const owns = () => ticket === generation && !disposed;
      const visibility = cancelCertifiedRunWhenHidden(active, ticket, owns);
      let checkpoint: ServiceCertifiedSolveOutcome | undefined;
      let projectionFailure: unknown;
      let acceptingCurrent = true;
      try {
        active.signal.throwIfAborted();
        const asOf = bindings.asOf ? bindings.asOf() : new Date().toISOString();
        // Headless adapter callers have no App ownership to observe. The actual
        // service hook always supplies this callback and owns the subscription.
        if (onForecastInvalidated) {
          forecastReady ??= createServiceForecastLifecycle(() => {
            invalidateSolve();
            onForecastInvalidated();
          }, () => !disposed).then((value) => {
            if (disposed) value?.dispose();
            else forecast = value;
            return value;
          });
          await awaitCertifiedRunPreparation(
            forecastReady, active.signal,
            CERTIFIED_TOTAL_DEADLINE_MS - (performance.now() - submitted),
          );
          if (!owns()) throw new ServiceCertifiedCancelled(disposed);
          // Explicit Calculate replaces old ownership. Its own acquisition must
          // not invalidate the new App input revision while refreshing A->B.
          forecast?.forget();
        }
        const { snapshot, publication, forecastSource } = await awaitCertifiedRunPreparation(
          (bindings.prepareForecast ?? prepareServiceForecast)(asOf),
          active.signal,
          CERTIFIED_TOTAL_DEADLINE_MS - (performance.now() - submitted),
        );
        if (!owns()) throw new ServiceCertifiedCancelled(disposed);
        active.signal.throwIfAborted();
        if (forecast && publication) {
          const bound = await awaitCertifiedRunPreparation(
            forecast.bind({ snapshot, publication }), active.signal,
            CERTIFIED_TOTAL_DEADLINE_MS - (performance.now() - submitted),
          );
          if (!bound || !owns()) throw new ServiceCertifiedCancelled(disposed);
        }
        const remaining = CERTIFIED_TOTAL_DEADLINE_MS - (performance.now() - submitted);
        if (remaining <= 0) throw new Error("certified_total_deadline");
        client ??= (bindings.createClient ?? createBrowserCertifiedClient)();
        const run = await client.request((bindings.projectInput ?? serviceCertifiedInput)(input, snapshot, asOf, publication, forecastSource), {
          sessionId,
          engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE,
          signal: active.signal,
          totalDeadlineMs: remaining,
          onCurrent: (output) => {
            if (!acceptingCurrent || !owns() || active.signal.aborted || !checkForecastBoundary()) return;
            try {
              checkpoint = (bindings.projectResult ?? projectServiceCertifiedResult)(input, output, false);
              onCurrent?.(checkpoint.result);
            } catch (failure) {
              checkpoint = undefined;
              projectionFailure = failure;
            }
          },
        });
        if (!checkForecastBoundary() || !owns()) throw new ServiceCertifiedCancelled(disposed);
        if (projectionFailure) throw projectionFailure;
        // Explicit visibility cancellation may retain bound Current, but never future guidance.
        if (active.signal.aborted) {
          if (checkpoint && visibility.cause) return checkpoint;
          throw new ServiceCertifiedCancelled();
        }
        const final = (bindings.projectResult ?? projectServiceCertifiedResult)(input, run.output, true);
        retainVerifiedAcquisition(final.result, snapshot, publication, asOf, source);
        return final;
      } catch (failure) {
        checkForecastBoundary();
        if (!owns()) throw new ServiceCertifiedCancelled(disposed);
        if (projectionFailure) throw projectionFailure;
        // Only a budget interruption can reuse this request's already validated checkpoint.
        // Binding/profile/input errors are not recoverable by retaining untrusted final advice.
        if (checkpoint && (certifiedRunError(failure) === "limit" || visibility.cause))
          return checkpoint;
        if (active.signal.aborted) throw new ServiceCertifiedCancelled();
        throw failure;
      } finally {
        acceptingCurrent = false;
        visibility.dispose();
        if (controller === active) controller = undefined;
      }
    },
  };
}
