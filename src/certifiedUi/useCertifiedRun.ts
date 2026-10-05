import { useCallback, useEffect, useRef, useState } from "react";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { CertifiedOutput } from "../certified/types";
import { createBrowserCertifiedClient } from "../certifiedRuntime/browserClient";
import type { CertifiedMemory, CertifiedTiming } from "../certifiedRuntime/protocol";
import { prepareCertifiedForecast } from "../lib/certifiedForecast";
import {
  certifiedBackgroundPartial,
  certifiedRunError,
  certifiedSilentCancellation,
} from "./runStatus";
import { awaitCertifiedRunPreparation, cancelCertifiedRunWhenHidden } from "./runVisibility";
import type { CertifiedSession } from "./session";

type FinishedRun = { output: CertifiedOutput; timing: CertifiedTiming; memory: CertifiedMemory };

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
      const currentSnapshot = await awaitCertifiedRunPreparation(
        prepareCertifiedForecast(asOf),
        controller.signal,
        15_000 - (performance.now() - submitted),
      );
      if (ticket !== sequence.current) return;
      controller.signal.throwIfAborted();
      onSnapshot(currentSnapshot);
      const remaining = 15_000 - (performance.now() - submitted);
      if (remaining <= 0) throw new Error("certified_total_deadline");
      client.current ??= createBrowserCertifiedClient();
      const run = await client.current.request(
        {
          ...session.state,
          stock: session.stock,
          asOf,
          snapshot: currentSnapshot,
          cohortWeights: session.cohortWeights,
          receivedEventIds: session.receipts.map((r) => r.eventId),
          computeWaiting: true,
          batchLimit: 10,
        },
        {
          engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE,
          sessionId: session.id,
          signal: controller.signal,
          totalDeadlineMs: remaining,
          onCurrent: (partial) => {
            if (ticket === sequence.current && !controller.signal.aborted) setResult(partial);
          },
        },
      );
      if (ticket !== sequence.current) return;
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
