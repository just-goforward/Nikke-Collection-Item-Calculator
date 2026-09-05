import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { statsSubmissionConfig } from "../lib/statsRuntime";
import {
  type BrowserStatsOutbox,
  createBrowserStatsOutbox,
  type StatsOutboxRecord,
} from "../lib/statsSubmissionOutbox";
import {
  type StatsSubmissionEnvelope,
  StatsSubmissionError,
  type StatsSubmissionEvent,
  StatsSubmissionQueue,
  type StatsSubmissionResult,
} from "../lib/statsSubmissionQueue";
import {
  cleanupStatsSubmissionDom,
  loadTurnstileApi,
  makeStatsSubmissionEnvelope,
  statsSubmissionProvider,
  submitStatsEnvelope,
} from "../lib/statsSubmitClient";
import type { TurnstileApi, TurnstileTokenProvider } from "../lib/turnstileTokenProvider";

type DeliveryHealthStore = import("../lib/statsDeliveryHealth").StatsDeliveryHealthStore;
type DeliveryHealthStoreProvider = () => Promise<DeliveryHealthStore | null>;
type SubmitEnvelope = (envelope: StatsSubmissionEnvelope, persist: boolean) => void;

function useStatsDeliveryHealthStore(statsEndpoint: string | null): DeliveryHealthStoreProvider {
  const storeRef = useRef<Promise<DeliveryHealthStore | null> | null>(null);
  return useCallback(() => {
    if (!__STATS_DELIVERY_HEALTH_EMIT_ENABLED__ || !statsEndpoint) {
      return Promise.resolve(null);
    }
    storeRef.current ??= import("../lib/statsDeliveryHealth").then((module) =>
      module.createBrowserStatsDeliveryHealth(statsEndpoint),
    );
    return storeRef.current;
  }, [statsEndpoint]);
}

function useStatsOutboxRetry(
  outbox: BrowserStatsOutbox | null,
  submitEnvelope: SubmitEnvelope,
  getDeliveryHealthStore: DeliveryHealthStoreProvider,
) {
  useEffect(() => {
    if (!outbox) return undefined;
    const retryPending = () => {
      if (navigator.onLine === false || document.visibilityState === "hidden") return;
      for (const item of outbox.list()) {
        const envelope = __STATS_DELIVERY_HEALTH_EMIT_ENABLED__
          ? (item as StatsOutboxRecord).envelope
          : (item as StatsSubmissionEnvelope);
        submitEnvelope(envelope, false);
      }
      if (__STATS_DELIVERY_HEALTH_EMIT_ENABLED__) {
        const expired = outbox.drainExpired?.() ?? [];
        if (expired.length > 0) {
          void getDeliveryHealthStore().then((deliveryStore) => {
            for (const record of expired) {
              deliveryStore?.record(record, "dropped_nonretryable", 0, record.lastFailureClass);
            }
          });
        }
      }
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
  }, [getDeliveryHealthStore, outbox, submitEnvelope]);
}

function useStatsSubmissionCleanup(providerRef: { current: TurnstileTokenProvider | null }) {
  useEffect(
    () => () => {
      cleanupStatsSubmissionDom(providerRef);
    },
    [providerRef],
  );
}

export function useStatsSubmission(onKitResultCommitted: () => void) {
  const callbackRef = useRef(onKitResultCommitted);
  const providerRef = useRef<TurnstileTokenProvider | null>(null);
  const providerSiteKeyRef = useRef<string | null>(null);
  const activeEventIdsRef = useRef(new Set<string>());
  const warnedEventIdsRef = useRef(new Set<string>());
  const [statsEndpoint] = useState(() => statsSubmissionConfig()?.endpoint ?? null);
  const [outbox] = useState(() => {
    return statsEndpoint ? createBrowserStatsOutbox(statsEndpoint) : null;
  });

  const getDeliveryHealthStore = useStatsDeliveryHealthStore(statsEndpoint);

  const loadTurnstile = useCallback(async (): Promise<TurnstileApi> => {
    return loadTurnstileApi();
  }, []);

  const getProvider = useCallback((): TurnstileTokenProvider => {
    return statsSubmissionProvider(providerRef, providerSiteKeyRef, loadTurnstile);
  }, [loadTurnstile]);

  const submitAttempt = useCallback(
    async (envelope: StatsSubmissionEnvelope): Promise<void> => {
      if (!__STATS_DELIVERY_HEALTH_EMIT_ENABLED__) {
        await submitStatsEnvelope(envelope, getProvider());
        return;
      }
      const deliveryStore = await getDeliveryHealthStore();
      const deliveryHealth = deliveryStore?.pending();
      await submitStatsEnvelope(
        deliveryHealth ? { ...envelope, deliveryHealth } : envelope,
        getProvider(),
      );
      if (deliveryHealth && deliveryStore) deliveryStore.acknowledge(deliveryHealth);
    },
    [getDeliveryHealthStore, getProvider],
  );
  const submitAttemptRef = useRef(submitAttempt);

  useLayoutEffect(() => {
    callbackRef.current = onKitResultCommitted;
    submitAttemptRef.current = submitAttempt;
  }, [onKitResultCommitted, submitAttempt]);

  const [queue] = useState(
    () => new StatsSubmissionQueue((envelope) => submitAttemptRef.current(envelope)),
  );
  const submitEnvelope = useCallback(
    (envelope: StatsSubmissionEnvelope, persist: boolean): void => {
      if (activeEventIdsRef.current.has(envelope.eventId)) return;
      if (persist) outbox?.put(envelope);
      activeEventIdsRef.current.add(envelope.eventId);
      void queue
        .enqueue(envelope)
        .then(async (result) => {
          const removed = outbox?.remove(envelope.eventId);
          if (__STATS_DELIVERY_HEALTH_EMIT_ENABLED__) {
            const record = (removed ?? null) as StatsOutboxRecord | null;
            const deliveryResult = result as StatsSubmissionResult;
            const deliveryStore = await getDeliveryHealthStore();
            deliveryStore?.record(
              record,
              "retried_success",
              deliveryResult.attempts,
              deliveryResult.lastFailureClass ?? record?.lastFailureClass ?? null,
            );
          }
          warnedEventIdsRef.current.delete(envelope.eventId);
          if (envelope.event.kind === "kit_result") callbackRef.current();
        })
        .catch(async (error) => {
          if (error instanceof StatsSubmissionError && !error.retryable) {
            const removed = outbox?.remove(envelope.eventId);
            if (__STATS_DELIVERY_HEALTH_EMIT_ENABLED__) {
              const record = (removed ?? null) as StatsOutboxRecord | null;
              const deliveryStore = await getDeliveryHealthStore();
              deliveryStore?.record(
                record,
                "dropped_nonretryable",
                error.attempts,
                error.failureClass,
              );
            }
          } else if (
            __STATS_DELIVERY_HEALTH_EMIT_ENABLED__ &&
            error instanceof StatsSubmissionError
          ) {
            outbox?.markFailure?.(envelope.eventId, error.attempts, error.failureClass);
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
    [getDeliveryHealthStore, outbox, queue],
  );

  const queueStatsEvent = useCallback(
    (event: StatsSubmissionEvent): void => {
      if (!statsSubmissionConfig()) return;
      submitEnvelope(makeStatsSubmissionEnvelope(event), true);
    },
    [submitEnvelope],
  );

  useStatsOutboxRetry(outbox, submitEnvelope, getDeliveryHealthStore);

  useStatsSubmissionCleanup(providerRef);

  return queueStatsEvent;
}
