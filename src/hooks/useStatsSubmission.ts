import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { statsSubmissionConfig } from "../lib/statsRuntime";
import {
  type StatsSubmissionEnvelope,
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

  const queueStatsEvent = useCallback(
    (event: StatsSubmissionEvent): void => {
      if (!statsSubmissionConfig()) return;
      const envelope = makeStatsSubmissionEnvelope(event);
      void queue
        .enqueue(envelope)
        .then(() => {
          if (event.kind === "kit_result") callbackRef.current();
        })
        .catch((error) => {
          console.warn("Statistics event was not submitted.", error);
        });
    },
    [queue],
  );

  useEffect(
    () => () => {
      cleanupStatsSubmissionDom(providerRef);
    },
    [],
  );

  return queueStatsEvent;
}
