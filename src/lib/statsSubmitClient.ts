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

export async function loadTurnstileApi(): Promise<TurnstileApi> {
  const { loadTurnstileScriptApi } = await import("./turnstileScriptLoader");
  return loadTurnstileScriptApi();
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
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    ignoreExpectedError("Statistics fetch failed; raising retryable submission error.", error);
    if (!__STATS_DELIVERY_HEALTH_EMIT_ENABLED__) {
      throw new StatsSubmissionError("Statistics request failed.", true);
    }
    const failureClass =
      error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
        ? "timeout"
        : "network";
    throw new StatsSubmissionError("Statistics request failed.", true, failureClass);
  }
}

export async function readStatsError(response: Response): Promise<StatsSubmissionError> {
  const { parseStatsSubmissionError } = await import("./statsErrorResponse");
  return parseStatsSubmissionError(response);
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
    ...(event.kind === "kit_result" ? { sourceHost: statsSourceHost() } : {}),
    event,
  };
}

export function cleanupStatsSubmissionDom(
  providerRef: MutableValue<TurnstileTokenProvider | null>,
) {
  providerRef.current?.dispose();
  providerRef.current = null;
  for (const kind of [
    "kit_result",
    "runtime_invariant",
    "solver_diagnostic",
    "solver_recovery",
  ] as const) {
    document.getElementById(`turnstileContainer-${kind}`)?.remove();
  }
}
