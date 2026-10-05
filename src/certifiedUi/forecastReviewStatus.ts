// Approved public collector: repository Actions FORECAST_COLLECTOR_STAGING_URL,
// resolved by the repository owner on 2026-09-30. GET /health is public metadata;
// this client has no admin credential, candidate body, or adoption capability.
const REVIEW_HEALTH_URL =
  "https://collection-kit-forecast-collector-staging.tbvj159.workers.dev/health";
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const REFRESH_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export type ForecastReviewStatus = "checking" | "current" | "review_pending" | "unknown";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_review_metadata");
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validChangedSource(value: unknown): boolean {
  const source = record(value);
  return (
    boundedText(source["source"]) &&
    boundedText(source["itemId"]) &&
    Number.isSafeInteger(source["generation"]) &&
    Number(source["generation"]) >= 0 &&
    (source["errorCode"] === null || boundedText(source["errorCode"]))
  );
}

// Return only the advisory state. Extra health fields cannot become forecast data.
export function parseForecastReviewStatus(value: unknown): "current" | "review_pending" {
  const review = record(record(value)["sourceReview"]);
  const state = review["state"];
  const sources = review["changedSources"];
  if ((state !== "current" && state !== "review_pending") || review["processingBlocked"]) {
    throw new Error("invalid_review_state");
  }
  if (!Array.isArray(sources) || sources.length > 20 || !sources.every(validChangedSource)) {
    throw new Error("invalid_changed_sources");
  }
  if ((state === "current") !== (sources.length === 0)) {
    throw new Error("inconsistent_review_state");
  }
  return state;
}

async function readBoundedHealth(response: Response): Promise<unknown> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("unavailable_review_health");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > RESPONSE_LIMIT_BYTES || !response.body) {
    throw new Error("review_health_size_limit");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_LIMIT_BYTES) {
        await reader.cancel("review_health_size_limit");
        throw new Error("review_health_size_limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

type VisibilitySource = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

export function watchForecastReviewStatus(options: {
  onStatus: (status: ForecastReviewStatus) => void;
  visibility: VisibilitySource;
  fetch?: typeof fetch;
  now?: () => number;
}): () => void {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let disposed = false;
  let failures = 0;
  let nextAttemptAt = 0;
  let active: { controller: AbortController; timer: ReturnType<typeof setTimeout> } | null = null;

  async function refresh() {
    if (disposed || active || now() < nextAttemptAt) return;
    nextAttemptAt = now() + REFRESH_INTERVAL_MS;
    const controller = new AbortController();
    let rejectAbort: (error: Error) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(new Error("review_request_aborted"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    active = { controller, timer };
    try {
      const health = request(REVIEW_HEALTH_URL, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      }).then(readBoundedHealth);
      const status = parseForecastReviewStatus(await Promise.race([health, aborted]));
      if (!disposed) {
        failures = 0;
        options.onStatus(status);
      }
    } catch {
      if (!disposed) {
        failures = Math.min(failures + 1, 4);
        nextAttemptAt = now() + Math.min(REFRESH_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
        options.onStatus("unknown");
      }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      // Also release a native fetch body rejected before it was consumed.
      controller.abort();
      active = null;
    }
  }

  const onVisible = () => {
    if (options.visibility.visibilityState === "visible") void refresh();
  };
  options.visibility.addEventListener("visibilitychange", onVisible);
  void refresh();
  return () => {
    disposed = true;
    options.visibility.removeEventListener("visibilitychange", onVisible);
    if (active) {
      clearTimeout(active.timer);
      active.controller.abort();
    }
  };
}
