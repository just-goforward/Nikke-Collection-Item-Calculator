import { adaptiveShell, rootCandidate } from "../lib/rootCandidate";
import { normalizePublishedSupplyReference, selectPublishedSupplyReference } from "../../shared/decisionSupplyReference";
import { createServiceH14Client } from "../serviceH14/browserClient";
import { isServiceH14Interruption, ServiceH14RuntimeError, type ServiceH14Client } from "../serviceH14/client";
import { serviceH14DeadlineMs } from "../serviceH14/deadline";
import { awaitCertifiedRunPreparation, cancelCertifiedRunWhenHidden } from "../certifiedUi/runVisibility";
import type { SolverInput } from "../types";
import type { SolverResult } from "./calculatorShared";
import { createServiceForecastLifecycle, prepareServiceForecast, verifiedSequence } from "./serviceCertifiedForecast";
import { serviceCertifiedInput } from "./serviceCertifiedInput";
import { projectServiceCertifiedResult } from "./serviceCertifiedPresentation";
import { PreviewCalculationError, PreviewSolverResourceError, ServiceCertifiedCancelled, type ServiceCertifiedAdapter, type ServiceCertifiedSolveOutcome } from "./serviceCertifiedTypes";
import { retainVerifiedAcquisition } from "../analytics/decisionAcquisition";
import { readPreviewJoint } from '../lib/previewJoint';
import { previewTimedSupply } from "./previewExpectedSupply";
import { PreviewSourceError } from "../lib/previewSourceError";

export { serviceCertifiedInput } from "./serviceCertifiedInput";

const acquisitionProjection = {
  select: selectPublishedSupplyReference,
  normalize: normalizePublishedSupplyReference,
};

type SourceStamp = { timed: number; legacy?: number; joint?: number; requiresJoint?: true };

function advancedSource(previous: SourceStamp, next: SourceStamp) {
  if (!(next.timed >= previous.timed)) return false;
  // A verified timed active may supersede the entire OFF + legacy lane. But a
  // missing joint model on the OFF lane cannot silently replace a joint solve.
  if (next.legacy === undefined) return next.timed > previous.timed;
  if ((previous.requiresJoint || previous.joint !== undefined) && next.joint === undefined) return false;
  if (previous.legacy !== undefined && next.legacy < previous.legacy) return false;
  return next.timed > previous.timed || (previous.legacy !== undefined && next.legacy > previous.legacy) ||
    (next.joint !== undefined && previous.joint !== undefined && next.joint > previous.joint);
}

/** This module is loaded only after the service's explicit Calculate action. */
export function createServiceCertifiedAdapter(
  onForecastInvalidated?: () => void,
  bindings: {
    prepareForecast?: typeof prepareServiceForecast;
    createClient?: () => Pick<ServiceH14Client, "request" | "dispose">;
    projectResult?: typeof projectServiceCertifiedResult;
    projectInput?: typeof serviceCertifiedInput;
    asOf?: () => string;
  } = {},
): ServiceCertifiedAdapter {
  let client: Pick<ServiceH14Client, "request" | "dispose"> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let sessionId = crypto.randomUUID();
  let disposed = false;
  let forecast: Awaited<ReturnType<typeof createServiceForecastLifecycle>> = null;
  let forecastReady: ReturnType<typeof createServiceForecastLifecycle> | undefined;
  const preview = adaptiveShell;
  const invalidateSolve = () => {
    ++generation;
    controller?.abort("service_input_changed");
    sessionId = crypto.randomUUID();
    forecast?.forget();
  };
  // Only non-preview service builds subscribe to the live forecast. Preview
  // validates fresh heads in both admissions, never when confirming a game event.
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
    solveBestAvailable: async function solve(
      source: SolverInput,
      onCurrent?: (result: SolverResult) => void,
      submitted = performance.now(),
      parentInputHash?: string,
      submittedEpoch = Date.now(),
      retryOf?: { stamp?: SourceStamp; requireAdvance: boolean; input: SolverInput },
    ): Promise<ServiceCertifiedSolveOutcome> {
      if (disposed) throw new ServiceCertifiedCancelled(true);
      const ticket = ++generation;
      controller?.abort("service_new_request");
      const active = new AbortController();
      controller = active;
      const input = retryOf?.input ?? structuredClone(source);
      const deadline = submitted + serviceH14DeadlineMs(input.start);
      const wallDeadline = submittedEpoch + serviceH14DeadlineMs(input.start);
      const remainingMs = () => Math.min(deadline - performance.now(), wallDeadline - Date.now());
      const owns = () => ticket === generation && !disposed;
      const visibility = preview ? undefined : cancelCertifiedRunWhenHidden(active, ticket, owns);
      let checkpoint: ServiceCertifiedSolveOutcome | undefined;
      let projectionFailure: unknown;
      let acceptingCurrent = true;
      let acquired: SourceStamp | undefined;
      let submittedToClient = false;
      try {
        if (remainingMs() <= 0) throw new Error("certified_total_deadline");
        active.signal.throwIfAborted();
        const asOf = bindings.asOf ? bindings.asOf() : new Date().toISOString();
        if (!preview && onForecastInvalidated) {
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
            remainingMs(),
          );
          if (!owns()) throw new ServiceCertifiedCancelled(disposed);
          forecast?.forget();
        }
        const { snapshot, publication, forecastSource, legacyD0, rootConditional } = await awaitCertifiedRunPreparation(
          (bindings.prepareForecast ?? prepareServiceForecast)(asOf, active.signal),
          active.signal,
          remainingMs(),
        );
        if (!owns()) throw new ServiceCertifiedCancelled(disposed);
        active.signal.throwIfAborted();
        if (preview && (!publication || forecastSource)) throw new Error("forecast_unavailable");
        if (legacyD0 && !preview) throw new Error("forecast_unavailable");
        if (preview && publication) acquired = {timed:verifiedSequence(legacyD0?.timedOff ?? publication),
          ...(legacyD0 ? {legacy:verifiedSequence(publication)} : {})};
        if (forecast && publication) {
          const bound = await awaitCertifiedRunPreparation(
            forecast.bind({ snapshot, publication }), active.signal,
            remainingMs(),
          );
          if (!owns()) throw new ServiceCertifiedCancelled(disposed);
          if (!bound) throw new ServiceCertifiedCancelled(disposed);
        }
        let joint = null;
        if ((legacyD0 || rootConditional) && publication && preview) {
          if (acquired) acquired.requiresJoint = true;
          joint = await awaitCertifiedRunPreparation(readPreviewJoint(snapshot,publication,active.signal,legacyD0?.timedOff ?? null),active.signal,remainingMs());
          if (rootCandidate && !joint) throw new PreviewSourceError('joint','missing');
          if (acquired && !joint) delete acquired.requiresJoint;
        }
        if(!owns())throw new ServiceCertifiedCancelled(disposed);
        if (acquired && joint) acquired.joint = joint.sequence;
        if (retryOf?.stamp) {
          const before = retryOf.stamp;
          if (!acquired || (retryOf.requireAdvance && !advancedSource(before, acquired)) ||
              (before.requiresJoint && acquired.legacy !== undefined && acquired.joint === undefined))
            throw new PreviewSourceError('admission','changed');
        }
        client ??= (bindings.createClient ?? createServiceH14Client)();
        const requestInput = (bindings.projectInput ?? serviceCertifiedInput)(
          input, joint?.snapshot ?? snapshot, asOf, publication, forecastSource, joint ? undefined : legacyD0,
        );
        if(joint&&(legacyD0 || rootConditional)){requestInput.previewJoint=legacyD0 ?? {timedOff:null};requestInput.receivedEventIds=[];requestInput.computeMinimumWait=false;}
        const remaining = remainingMs();
        if (remaining <= 0) throw new Error("certified_total_deadline");
        submittedToClient = true;
        const run = await client.request(requestInput, {
          sessionId,
          ...(parentInputHash ? { parentInputHash } : {}),
          signal: active.signal,
          totalDeadlineMs: remaining,
          onCurrent: (output) => {
            if (legacyD0 || rootCandidate || !acceptingCurrent || !owns() || active.signal.aborted || !checkForecastBoundary()) return;
            try {
              checkpoint = (bindings.projectResult ?? projectServiceCertifiedResult)(input, output, false);
              if (adaptiveShell) checkpoint.result.certified.previewSourceStatus = snapshot.sourceStatus;
              onCurrent?.(checkpoint.result);
              retainVerifiedAcquisition(checkpoint.result, snapshot, publication, asOf, source, acquisitionProjection);
            } catch (failure) {
              checkpoint = undefined;
              projectionFailure = failure;
            }
          },
        });
        if (!owns()) throw new ServiceCertifiedCancelled(disposed);
        const live = checkForecastBoundary();
        if (!live) throw new ServiceCertifiedCancelled(disposed);
        if (projectionFailure) throw projectionFailure;
        // Explicit visibility cancellation may retain bound Current, but never future guidance.
        if (active.signal.aborted) {
          if (checkpoint && visibility?.cause) {
            checkpoint.result.certified.interruption = String(visibility.cause);
            return checkpoint;
          }
          throw new ServiceCertifiedCancelled();
        }
        // An interrupted D0 receipt is never an actionable legacy result.
        if (legacyD0 && !joint && (run.receipt.outputMode !== "result" || run.receipt.interruption !== null))
          throw new ServiceH14RuntimeError(run.receipt.interruption ?? "binding", run.receipt.interruptionReason ?? "service_h14_interrupted_legacy");
        const {outputMode,interruption,interruptionReason}=run.receipt;
        // A validated prefixDecision is separate from H14 adaptive and never
        // changes the stock-only Current eligibility of this final receipt.
        const prefix=outputMode==="result" && (interruption==="resource" || interruption==="memory" || interruption==="deadline") &&
          run.output.status==="incomplete" && !!run.output.reason && run.output.reason===interruptionReason &&
          !!run.output.current && run.output.records.length>0 && run.output.decision.status==="unavailable" &&
          !run.output.adaptive && run.output.sourceCertificate?.completedThrough===run.output.records.length-1;
        if(outputMode==="result" && interruption && run.output.status==="incomplete" && !prefix)
          throw new ServiceH14RuntimeError("binding","service_h14_partial_receipt_mismatch");
        const final = (bindings.projectResult ?? projectServiceCertifiedResult)(
          input, run.output, outputMode === "result" && (interruption === null || prefix), prefix,
        );
        if(joint) final.result.certified.previewConditional=true;
        else if (legacyD0) final.result.certified.previewLegacyD0 = true;
        if (run.receipt.interruption) {
          final.result.certified.interruption = run.receipt.interruption;
          if (run.receipt.interruptionReason) final.result.certified.interruptionReason = run.receipt.interruptionReason;
        }
        if (adaptiveShell) final.result.certified.previewSourceStatus = joint?.snapshot.sourceStatus ?? snapshot.sourceStatus;
        if ((!legacyD0 || joint) && !rootCandidate && adaptiveShell && final.result.certified.final &&
            run.output.status === "complete")
          final.result.certified.previewTimedSupply = previewTimedSupply(requestInput);
        if (!legacyD0 && !rootCandidate) retainVerifiedAcquisition(final.result, snapshot, publication, asOf, source, acquisitionProjection);
        return final;
      } catch (failure) {
        if (!owns()) throw new ServiceCertifiedCancelled(disposed);
        checkForecastBoundary();
        if (!owns()) throw new ServiceCertifiedCancelled(disposed);
        // Retry only before compute. A primary read/lease failure during
        // preparation hasn't consumed a parent. An admission rotation after
        // submission must independently prove advancement on the replacement.
        const rotated = submittedToClient
          ? failure instanceof ServiceH14RuntimeError && failure.code === "source_advanced"
          : failure instanceof Error && failure.message === "preview_source_advanced";
        const reacquire = !submittedToClient && failure instanceof PreviewSourceError && (failure.renewable || failure.reason === 'changed');
        if (preview && !retryOf && ((acquired && rotated) || reacquire) && !active.signal.aborted) {
          if (remainingMs() <= 0) throw new Error("certified_total_deadline");
          return solve(source, onCurrent, submitted, submittedToClient ? undefined : parentInputHash,
            submittedEpoch, { ...(acquired ? {stamp:acquired} : {}), requireAdvance:rotated, input });
        }
        if (preview && rotated) throw new PreviewSourceError('admission','changed');
        if (projectionFailure) throw projectionFailure;
        // Only a budget interruption can reuse this request's already validated checkpoint.
        // Binding/profile/input errors are not recoverable by retaining untrusted final advice.
        if (checkpoint && (isServiceH14Interruption(failure) || (visibility?.cause && failure === active.signal.reason))) {
          if (failure instanceof ServiceH14RuntimeError) checkpoint.result.certified.interruptionReason = failure.message;
          checkpoint.result.certified.interruption = failure instanceof ServiceH14RuntimeError ? failure.code : String(failure);
          return checkpoint;
        }
        if (active.signal.aborted && (isServiceH14Interruption(failure) || failure === active.signal.reason))
          throw new ServiceCertifiedCancelled();
        if (preview && failure instanceof ServiceH14RuntimeError && (failure.code === "resource" || failure.code === "memory"))
          throw new PreviewSolverResourceError(failure.code, failure.message);
        if (preview && failure instanceof ServiceH14RuntimeError && failure.code === "deadline")
          throw new Error("certified_total_deadline", {cause:failure});
        if (preview && failure instanceof ServiceH14RuntimeError && (failure.code === "worker" || failure.code === "binding"))
          throw new PreviewCalculationError(failure.code,failure.stage);
        if (preview && failure instanceof Error && (failure.message === 'service_h14_price_parent_mismatch' || failure.message === 'service_h14_price_lineage'))
          throw new PreviewCalculationError('binding',failure.message === 'service_h14_price_parent_mismatch' ? 'physical-parent' : 'physical-child');
        throw failure;
      } finally {
        if (preview) active.abort(); // Stop a preparation fetch that lost its deadline race.
        acceptingCurrent = false;
        visibility?.dispose();
        if (controller === active) controller = undefined;
      }
    },
  };
}
