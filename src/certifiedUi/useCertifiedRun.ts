import { useCallback, useEffect, useRef, useState } from "react";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import { toWire, type WireQ } from "../../shared/certifiedRational";
import { type CertifiedSupplySnapshot, certifiedCohortWeights } from "../../shared/certifiedSupply";
import type { PublicationBytes } from "../../shared/forecastPublicationBytes";
import { runtimeForecastEnvironment } from "../../shared/runtimeForecastMode";
import type { CertifiedInput, CertifiedOutput } from "../certified/types";
import type { LiveRecommendationGuidance } from "../certifiedRecommendation/liveGuidance";
import type { RecommendationResult } from "../certifiedRecommendation/policy";
import type { StableRuntimeRecommendation } from "../certifiedRecommendation/stableRuntime";
import { createBrowserCertifiedClient } from "../certifiedRuntime/browserClient";
import type { CertifiedMemory, CertifiedTiming } from "../certifiedRuntime/protocol";
import { prepareCertifiedForecast } from "../lib/certifiedForecast";
import { prepareLocalCertifiedForecast } from "../lib/certifiedLocalForecast";
import { localCertifiedForecastEnabled } from "../lib/certifiedLocalPolicy";
import { certifiedRunCacheKey } from "./certifiedRunCache";
import {
  certifiedBackgroundPartial,
  certifiedRunError,
  certifiedSilentCancellation,
} from "./runStatus";
import { awaitCertifiedRunPreparation, cancelCertifiedRunWhenHidden } from "./runVisibility";
import { type CertifiedSession, certifiedRequestReceivedEventIds } from "./session";

type FinishedRun = {
  output: CertifiedOutput; timing: CertifiedTiming; memory: CertifiedMemory;
  recommendation?: RecommendationResult | null;
  recommendationGuidance?: LiveRecommendationGuidance;
  stableRequested?: boolean;
  stableRecommendation?: StableRuntimeRecommendation;
};

function cacheable(output: CertifiedOutput): boolean {
  return (
    output.status === "completed" &&
    ["certified", "beyond_horizon"].includes(output.minimumWait?.status ?? "")
  );
}

function requestInput(
  session: CertifiedSession,
  snapshot: CertifiedSupplySnapshot,
  asOf: string,
  publication?: PublicationBytes,
): CertifiedInput {
  return {
    ...(publication
      ? { forecastPublication: publication }
      : localCertifiedForecastEnabled()
        ? { forecastSource: "local" as const }
        : {}),
    ...session.state,
    stock: session.stock,
    asOf,
    snapshot,
    cohortWeights: certifiedCohortWeights(undefined, snapshot.version).map(toWire) as
      | [WireQ, WireQ, WireQ]
      | [WireQ, WireQ, WireQ, WireQ],
    receivedEventIds: certifiedRequestReceivedEventIds(session, snapshot, asOf),
    computeWaiting: true,
    computeMinimumWait: true,
    batchLimit: 10,
  };
}

/** Online modes submit only a freshly verified publication; there is no bundled fallback. */
function prepareRunSnapshot(asOf: string, accept: (proof: PublicationBytes) => void) {
  return runtimeForecastEnvironment(import.meta.env.VITE_FORECAST_RUNTIME) !== null
    ? import("../lib/runtimeForecast")
        .then((module) => module.runtimeForecast.acquire(asOf))
        .then((runtime) => {
          if (!runtime) throw new Error("forecast_unavailable");
          accept(runtime.publication);
          return runtime.snapshot;
        })
    : (localCertifiedForecastEnabled() ? prepareLocalCertifiedForecast : prepareCertifiedForecast)(
        asOf,
      );
}

export function useCertifiedRun(
  session: CertifiedSession,
  snapshot: CertifiedSupplySnapshot | null,
  onSnapshot: (next: CertifiedSupplySnapshot) => void,
  target?: CertifiedInput["target"] | null,
  /** Internal replay-validation input only; does not replace the live deadline clock or forecast trust path. */
  options?: { asOf?: string; autoRecommendation?: boolean; stableRecommendation?: CertifiedInput["stableRecommendation"] },
) {
  const replayAsOf = options?.asOf;
  const autoRecommendation = options?.autoRecommendation === true;
  const stableRecommendation = options?.stableRecommendation;
  const client = useRef<ReturnType<typeof createBrowserCertifiedClient> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const [result, setResult] = useState<CertifiedOutput | null>(null);
  const [finished, setFinished] = useState<FinishedRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<false | "limit" | "error" | "background">(false);
  const previousSession = useRef(session);
  const previousStablePolicy = useRef(stableRecommendation);
  const cached = useRef<{ key: string; run: FinishedRun } | null>(null);
  useEffect(() => {
    if (previousSession.current === session && previousStablePolicy.current === stableRecommendation) return;
    previousSession.current = session;
    previousStablePolicy.current = stableRecommendation;
    ++sequence.current;
    abort.current?.abort("session_change");
    setResult(null);
    setFinished(null);
    setBusy(false);
    setError(false);
  }, [session, stableRecommendation]);
  useEffect(
    () => () => {
      ++sequence.current;
      abort.current?.abort("unmount");
      void client.current?.dispose();
    },
    [],
  );
  const calculate = useCallback(async () => {
    if (!snapshot || target === null) return;
    const ticket = ++sequence.current;
    const submitted = performance.now();
    abort.current?.abort("new_request");
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(false);
    setResult(null);
    setFinished(null);
    let acceptingCurrent = true;
    let visibility: ReturnType<typeof cancelCertifiedRunWhenHidden> | undefined;
    try {
      visibility = cancelCertifiedRunWhenHidden(
        controller,
        ticket,
        () => ticket === sequence.current,
      );
      controller.signal.throwIfAborted();
      const asOf = replayAsOf ?? new Date().toISOString();
      let publication: PublicationBytes | undefined;
      const preparation = prepareRunSnapshot(asOf, (value) => {
        publication = value;
      });
      const currentSnapshot = await awaitCertifiedRunPreparation(
        preparation,
        controller.signal,
        15_000 - (performance.now() - submitted),
      );
      if (ticket !== sequence.current) return;
      controller.signal.throwIfAborted();
      onSnapshot(currentSnapshot);
      const remaining = 15_000 - (performance.now() - submitted);
      if (remaining <= 0) throw new Error("certified_total_deadline");
      const cacheKey = certifiedRunCacheKey(session, currentSnapshot, asOf);
      if (!target && !autoRecommendation && !stableRecommendation && cached.current?.key === cacheKey) {
        setResult(cached.current.run.output);
        setFinished(cached.current.run);
        return;
      }
      client.current ??= createBrowserCertifiedClient();
      const input = requestInput(session, currentSnapshot, asOf, publication);
      if (target) input.target = target;
      if (autoRecommendation) input.autoRecommendation = true;
      if (stableRecommendation) {
        input.stableRecommendation = stableRecommendation;
        input.riskSummary = true;
        input.autoRecommendation = true;
      }
      const run = await client.current.request(input, {
        engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE,
        sessionId: session.id,
        signal: controller.signal,
        totalDeadlineMs: remaining,
        onCurrent: (partial) => {
          if (acceptingCurrent && ticket === sequence.current && !controller.signal.aborted) setResult(partial);
        },
      });
      if (ticket !== sequence.current) return;
      let recommendation: RecommendationResult | null = null;
      let recommendationGuidance: LiveRecommendationGuidance | undefined;
      if (autoRecommendation) {
        recommendation = run.output.autoRecommendation?.recommendation ?? null;
        recommendationGuidance = run.output.autoRecommendation?.guidance;
      }
      if (!target && !autoRecommendation && !stableRecommendation && cacheable(run.output)) cached.current = { key: cacheKey, run };
      setResult(run.output);
      if (
        certifiedBackgroundPartial(run.output, {
          signal: controller.signal,
          cause: visibility.cause,
        })
      )
        setError("background");
      setFinished({
        ...run,
        ...(stableRecommendation ? {
          stableRequested: true,
          ...(run.output.stableRecommendation ? { stableRecommendation: run.output.stableRecommendation } : {}),
        } : {}),
        ...(autoRecommendation ? { recommendation } : {}),
        ...(recommendationGuidance === undefined ? {} : { recommendationGuidance }),
        timing: { ...run.timing, totalMs: performance.now() - submitted },
      });
    } catch (failure) {
      if (ticket === sequence.current) {
        const kind = certifiedRunError(failure, {
          signal: controller.signal,
          cause: visibility?.cause,
        });
        if (certifiedSilentCancellation(failure, controller.signal, kind)) return;
        // A deadline after validated Current does not invalidate that checkpoint.
        // Other failures may represent an untrusted runtime output.
        if ((!autoRecommendation && !stableRecommendation) || kind !== "limit") setResult(null);
        setFinished(null);
        setError(kind);
      }
    } finally {
      acceptingCurrent = false;
      visibility?.dispose();
      if (abort.current === controller) abort.current = null;
      if (ticket === sequence.current) setBusy(false);
    }
  }, [session, snapshot, onSnapshot, target, replayAsOf, autoRecommendation, stableRecommendation]);
  return {
    result,
    finished,
    busy,
    error,
    calculate,
    invalidate: () => {
      ++sequence.current;
      abort.current?.abort("session_change");
      setResult(null);
      setFinished(null);
      setBusy(false);
      setError(false);
    },
    cancel: () => {
      ++sequence.current;
      abort.current?.abort("user_cancel");
      setFinished(null);
      setBusy(false);
    },
  };
}
