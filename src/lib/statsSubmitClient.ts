import { ignoreExpectedError } from "./errorHandling";
import { makeStatsEventId, statsSourceHost, statsSubmissionConfig } from "./statsRuntime";
import {
  type StatsSubmissionEnvelope,
  StatsSubmissionError,
  type StatsSubmissionEvent,
} from "./statsSubmissionQueue";
import { type TurnstileApi, TurnstileTokenProvider } from "./turnstileTokenProvider";

type MutableValue<T> = {
  current: T;
};

type SubmissionConfig = {
  endpoint: string;
  turnstileSiteKey: string;
};

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

function createTurnstileScriptPromise(): Promise<TurnstileApi> {
  return new Promise<TurnstileApi>((resolve, reject) => {
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
  });
}

export async function loadTurnstileApi(
  readyPromiseRef: MutableValue<Promise<TurnstileApi> | null>,
): Promise<TurnstileApi> {
  if (window.turnstile) return window.turnstile;
  if (!readyPromiseRef.current) {
    readyPromiseRef.current = createTurnstileScriptPromise().catch((error) => {
      readyPromiseRef.current = null;
      throw error;
    });
  }
  return readyPromiseRef.current;
}

export function statsSubmissionProvider(
  providerRef: MutableValue<TurnstileTokenProvider | null>,
  providerSiteKeyRef: MutableValue<string | null>,
  loadTurnstile: () => Promise<TurnstileApi>,
): TurnstileTokenProvider {
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
}

async function postStatsEnvelope(
  config: SubmissionConfig,
  envelope: StatsSubmissionEnvelope,
  turnstileToken: string,
): Promise<Response> {
  try {
    return await fetch(`${config.endpoint}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        ...envelope,
        turnstileToken,
      }),
      keepalive: true,
    });
  } catch (error) {
    ignoreExpectedError("Statistics fetch failed; raising retryable submission error.", error);
    throw new StatsSubmissionError("Statistics request failed.", true);
  }
}

async function readStatsError(response: Response): Promise<StatsSubmissionError> {
  let message = response.statusText || "Statistics request failed.";
  let retryable = false;
  try {
    const body = (await response.json()) as { error?: unknown; retryable?: unknown };
    if (typeof body.error === "string") message = body.error;
    retryable = body.retryable === true;
  } catch (error) {
    ignoreExpectedError(
      "Malformed statistics error response; keep the response status text.",
      error,
    );
  }
  return new StatsSubmissionError(message, retryable);
}

export async function submitStatsEnvelope(
  envelope: StatsSubmissionEnvelope,
  provider: TurnstileTokenProvider,
): Promise<void> {
  const config = statsSubmissionConfig();
  if (!config) return;
  try {
    const turnstileToken = await provider.issueToken(envelope.event.kind);
    const response = await postStatsEnvelope(config, envelope, turnstileToken);
    if (!response.ok) throw await readStatsError(response);
  } finally {
    provider.reset(envelope.event.kind);
  }
}

export function makeStatsSubmissionEnvelope(event: StatsSubmissionEvent): StatsSubmissionEnvelope {
  return {
    eventId: makeStatsEventId(),
    clientTime: new Date().toISOString(),
    sourceHost: statsSourceHost(),
    event,
  };
}

export function cleanupStatsSubmissionDom(
  providerRef: MutableValue<TurnstileTokenProvider | null>,
) {
  providerRef.current?.dispose();
  providerRef.current = null;
  for (const kind of ["kit_result", "solver_diagnostic", "solver_recovery"] as const) {
    document.getElementById(`turnstileContainer-${kind}`)?.remove();
  }
}
