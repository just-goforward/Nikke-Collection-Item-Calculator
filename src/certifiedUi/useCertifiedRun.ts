import { useCallback, useEffect, useRef, useState } from "react";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { PublicationBytes } from "../../shared/forecastPublicationBytes";
import type { CertifiedInput, CertifiedOutput } from "../certified/types";
import { createBrowserCertifiedClient } from "../certifiedRuntime/browserClient";
import type { CertifiedMemory, CertifiedTiming } from "../certifiedRuntime/protocol";
import { prepareCertifiedForecast } from "../lib/certifiedForecast";
import { certifiedRunCacheKey } from "./certifiedRunCache";
import {
  certifiedBackgroundPartial,
  certifiedRunError,
  certifiedSilentCancellation,
} from "./runStatus";
import { awaitCertifiedRunPreparation, cancelCertifiedRunWhenHidden } from "./runVisibility";
import { activeCertifiedReceiptIds, type CertifiedSession } from "./session";

type FinishedRun = { output: CertifiedOutput; timing: CertifiedTiming; memory: CertifiedMemory };

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
    ...(publication ? { forecastPublication: publication } : {}),
    ...session.state,
    stock: session.stock,
    asOf,
    snapshot,
    cohortWeights: session.cohortWeights,
    receivedEventIds: activeCertifiedReceiptIds(session, snapshot.events),
    computeWaiting: true,
    computeMinimumWait: true,
    batchLimit: 10,
  };
}

/** Staging submits only a freshly acquired, verified publication; there is no bundled fallback. */
function prepareRunSnapshot(asOf: string, accept: (proof: PublicationBytes) => void) {
  return import.meta.env.VITE_FORECAST_RUNTIME === "staging"
    ? import("../lib/runtimeForecast")
        .then((module) => module.runtimeForecast.acquire(asOf))
        .then((runtime) => {
          if (!runtime) throw new Error("forecast_unavailable");
          accept(runtime.publication);
          return runtime.snapshot;
        })
    : prepareCertifiedForecast(asOf);
}

export function useCertifiedRun(
  session: CertifiedSession,
  snapshot: CertifiedSupplySnapshot | null,
  onSnapshot: (next: CertifiedSupplySnapshot) => void,
) {
  const client = useRef<ReturnType<typeof createBrowserCertifiedClient> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const [result, setResult] = useState<CertifiedOutput | null>(null);
  const [finished, setFinished] = useState<FinishedRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<false | "limit" | "error" | "background">(false);
  const previousSession = useRef(session);
  const cached = useRef<{ key: string; run: FinishedRun } | null>(null);
  useEffect(() => {
    if (previousSession.current === session) return;
    previousSession.current = session;
    ++sequence.current;
    abort.current?.abort("session_change");
    setResult(null);
    setFinished(null);
    setBusy(false);
    setError(false);
  }, [session]);
  useEffect(
    () => () => {
      ++sequence.current;
      abort.current?.abort("unmount");
      void client.current?.dispose();
    },
    [],
  );
  const calculate = useCallback(async () => {
    if (!snapshot) return;
    const ticket = ++sequence.current;
    const submitted = performance.now();
    abort.current?.abort("new_request");
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(false);
    setResult(null);
    setFinished(null);
    let visibility: ReturnType<typeof cancelCertifiedRunWhenHidden> | undefined;
    try {
      visibility = cancelCertifiedRunWhenHidden(
        controller,
        ticket,
        () => ticket === sequence.current,
      );
      controller.signal.throwIfAborted();
      const asOf = new Date().toISOString();
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
      if (cached.current?.key === cacheKey) {
        setResult(cached.current.run.output);
        setFinished(cached.current.run);
        return;
      }
      client.current ??= createBrowserCertifiedClient();
      const input = requestInput(session, currentSnapshot, asOf, publication);
      const run = await client.current.request(input, {
        engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE,
        sessionId: session.id,
        signal: controller.signal,
        totalDeadlineMs: remaining,
        onCurrent: (partial) => {
          if (ticket === sequence.current && !controller.signal.aborted) setResult(partial);
        },
      });
      if (ticket !== sequence.current) return;
      if (cacheable(run.output)) cached.current = { key: cacheKey, run };
      setResult(run.output);
      if (
        certifiedBackgroundPartial(run.output, {
          signal: controller.signal,
          cause: visibility.cause,
        })
      )
        setError("background");
      setFinished({ ...run, timing: { ...run.timing, totalMs: performance.now() - submitted } });
    } catch (failure) {
      if (ticket === sequence.current) {
        const kind = certifiedRunError(failure, {
          signal: controller.signal,
          cause: visibility?.cause,
        });
        if (certifiedSilentCancellation(failure, controller.signal, kind)) return;
        setResult(null);
        setFinished(null);
        setError(kind);
      }
    } finally {
      visibility?.dispose();
      if (abort.current === controller) abort.current = null;
      if (ticket === sequence.current) setBusy(false);
    }
  }, [session, snapshot, onSnapshot]);
  return {
    result,
    finished,
    busy,
    error,
    calculate,
    cancel: () => abort.current?.abort("user_cancel"),
  };
}
