import { useCallback, useEffect, useRef } from "react";

import { makeStatsEventId, statsSourceHost, statsSubmissionConfig } from "../lib/statsRuntime";
import {
  type StatsSubmissionEnvelope,
  StatsSubmissionError,
  type StatsSubmissionEvent,
  StatsSubmissionQueue,
} from "../lib/statsSubmissionQueue";
import { type TurnstileApi, TurnstileTokenProvider } from "../lib/turnstileTokenProvider";

function turnstileContainer(kind: StatsSubmissionEvent["kind"]): HTMLElement {
  const id = `turnstileContainer-${kind}`;
  let container = document.getElementById(id);
  if (!container) {
    container = document.createElement("div");
    container.id = id;
    container.hidden = true;
    document.body.append(container);
  }
  return container;
}

export function useStatsSubmission(onKitResultCommitted: () => void) {
  const callbackRef = useRef(onKitResultCommitted);
  const turnstileReadyPromiseRef = useRef<Promise<TurnstileApi> | null>(null);
  const providerRef = useRef<TurnstileTokenProvider | null>(null);
  const providerSiteKeyRef = useRef<string | null>(null);
  const submitAttemptRef = useRef<(envelope: StatsSubmissionEnvelope) => Promise<void>>(
    async () => undefined,
  );
  const queueRef = useRef<StatsSubmissionQueue | null>(null);

  callbackRef.current = onKitResultCommitted;

  const loadTurnstile = useCallback(async (): Promise<TurnstileApi> => {
    if (window.turnstile) return window.turnstile;
    if (!turnstileReadyPromiseRef.current) {
      turnstileReadyPromiseRef.current = new Promise<TurnstileApi>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(
          'script[src*="challenges.cloudflare.com/turnstile"]',
        );
        existing?.remove();
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.addEventListener(
          "load",
          () => {
            if (window.turnstile) resolve(window.turnstile);
            else reject(new Error("Turnstile script loaded without an API."));
          },
          { once: true },
        );
        script.addEventListener("error", () => reject(new Error("Turnstile script failed.")), {
          once: true,
        });
        document.head.append(script);
      }).catch((error) => {
        turnstileReadyPromiseRef.current = null;
        throw error;
      });
    }
    return turnstileReadyPromiseRef.current;
  }, []);

  const getProvider = useCallback((): TurnstileTokenProvider => {
    const config = statsSubmissionConfig();
    if (!config) throw new StatsSubmissionError("Statistics submission is not configured.");
    if (!providerRef.current || providerSiteKeyRef.current !== config.turnstileSiteKey) {
      providerRef.current?.dispose();
      providerRef.current = new TurnstileTokenProvider(
        config.turnstileSiteKey,
        loadTurnstile,
        turnstileContainer,
      );
      providerSiteKeyRef.current = config.turnstileSiteKey;
    }
    return providerRef.current;
  }, [loadTurnstile]);

  const submitAttempt = useCallback(
    async (envelope: StatsSubmissionEnvelope): Promise<void> => {
      const config = statsSubmissionConfig();
      if (!config) return;
      const provider = getProvider();
      try {
        const turnstileToken = await provider.issueToken(envelope.event.kind);
        let response: Response;
        try {
          response = await fetch(`${config.endpoint}/api/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: 1,
              ...envelope,
              turnstileToken,
            }),
            keepalive: true,
          });
        } catch {
          throw new StatsSubmissionError("Statistics request failed.", true);
        }
        if (!response.ok) {
          let message = response.statusText || "Statistics request failed.";
          let retryable = false;
          try {
            const body = (await response.json()) as { error?: unknown; retryable?: unknown };
            if (typeof body.error === "string") message = body.error;
            retryable = body.retryable === true;
          } catch {
            // A malformed error response is not safe to retry automatically.
          }
          throw new StatsSubmissionError(message, retryable);
        }
      } finally {
        provider.reset(envelope.event.kind);
      }
    },
    [getProvider],
  );

  submitAttemptRef.current = submitAttempt;
  if (!queueRef.current) {
    queueRef.current = new StatsSubmissionQueue((envelope) => submitAttemptRef.current(envelope));
  }

  const queueStatsEvent = useCallback((event: StatsSubmissionEvent): void => {
    if (!statsSubmissionConfig()) return;
    const envelope: StatsSubmissionEnvelope = {
      eventId: makeStatsEventId(),
      clientTime: new Date().toISOString(),
      sourceHost: statsSourceHost(),
      event,
    };
    void queueRef.current
      ?.enqueue(envelope)
      .then(() => {
        if (event.kind === "kit_result") callbackRef.current();
      })
      .catch((error) => {
        console.warn("Statistics event was not submitted.", error);
      });
  }, []);

  useEffect(
    () => () => {
      providerRef.current?.dispose();
      providerRef.current = null;
      for (const kind of ["kit_result", "solver_diagnostic"] as const) {
        document.getElementById(`turnstileContainer-${kind}`)?.remove();
      }
    },
    [],
  );

  return queueStatsEvent;
}
