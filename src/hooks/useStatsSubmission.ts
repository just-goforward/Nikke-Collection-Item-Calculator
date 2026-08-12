import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { statsSubmissionConfig } from "../lib/statsRuntime";
import { createBrowserStatsOutbox } from "../lib/statsSubmissionOutbox";
import {
  type StatsSubmissionEnvelope,
  StatsSubmissionError,
  type StatsSubmissionEvent,
  StatsSubmissionQueue,
} from "../lib/statsSubmissionQueue";
import {
  cleanupStatsSubmissionDom,
  loadTurnstileApi,
  makeStatsSubmissionEnvelope,
  statsSubmissionProvider,
  submitStatsEnvelope,
} from "../lib/statsSubmitClient";
import type { TurnstileApi, TurnstileTokenProvider } from "../lib/turnstileTokenProvider";

export function useStatsSubmission(onKitResultCommitted: () => void) {
  const callbackRef = useRef(onKitResultCommitted);
  const turnstileReadyPromiseRef = useRef<Promise<TurnstileApi> | null>(null);
  const providerRef = useRef<TurnstileTokenProvider | null>(null);
  const providerSiteKeyRef = useRef<string | null>(null);
  const activeEventIdsRef = useRef(new Set<string>());
  const warnedEventIdsRef = useRef(new Set<string>());

  const loadTurnstile = useCallback(async (): Promise<TurnstileApi> => {
    return loadTurnstileApi(turnstileReadyPromiseRef);
  }, []);

  const getProvider = useCallback((): TurnstileTokenProvider => {
    return statsSubmissionProvider(providerRef, providerSiteKeyRef, loadTurnstile);
  }, [loadTurnstile]);

  const submitAttempt = useCallback(
    async (envelope: StatsSubmissionEnvelope): Promise<void> => {
      await submitStatsEnvelope(envelope, getProvider());
    },
    [getProvider],
  );
  const submitAttemptRef = useRef(submitAttempt);

  useLayoutEffect(() => {
    callbackRef.current = onKitResultCommitted;
    submitAttemptRef.current = submitAttempt;
  }, [onKitResultCommitted, submitAttempt]);

  const [queue] = useState(
    () => new StatsSubmissionQueue((envelope) => submitAttemptRef.current(envelope)),
  );
  const [outbox] = useState(() => {
    const config = statsSubmissionConfig();
    return config ? createBrowserStatsOutbox(config.endpoint) : null;
  });

  const submitEnvelope = useCallback(
    (envelope: StatsSubmissionEnvelope, persist: boolean): void => {
      if (activeEventIdsRef.current.has(envelope.eventId)) return;
      if (persist) outbox?.put(envelope);
      activeEventIdsRef.current.add(envelope.eventId);
      void queue
        .enqueue(envelope)
        .then(() => {
          outbox?.remove(envelope.eventId);
          warnedEventIdsRef.current.delete(envelope.eventId);
          if (envelope.event.kind === "kit_result") callbackRef.current();
        })
        .catch((error) => {
          if (error instanceof StatsSubmissionError && !error.retryable) {
            outbox?.remove(envelope.eventId);
          }
          if (!warnedEventIdsRef.current.has(envelope.eventId)) {
            warnedEventIdsRef.current.add(envelope.eventId);
            console.warn("Statistics event was not submitted.", error);
          }
        })
        .finally(() => {
          activeEventIdsRef.current.delete(envelope.eventId);
        });
    },
    [outbox, queue],
  );

  const queueStatsEvent = useCallback(
    (event: StatsSubmissionEvent): void => {
      if (!statsSubmissionConfig()) return;
      submitEnvelope(makeStatsSubmissionEnvelope(event), true);
    },
    [submitEnvelope],
  );

  useEffect(() => {
    if (!outbox) return undefined;
    const retryPending = () => {
      if (navigator.onLine === false || document.visibilityState === "hidden") return;
      for (const envelope of outbox.list()) submitEnvelope(envelope, false);
    };
    const handleVisibilityChange = () => retryPending();
    retryPending();
    const interval = window.setInterval(retryPending, 30_000);
    window.addEventListener("online", retryPending);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", retryPending);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [outbox, submitEnvelope]);

  useEffect(
    () => () => {
      cleanupStatsSubmissionDom(providerRef);
    },
    [],
  );

  return queueStatsEvent;
}
