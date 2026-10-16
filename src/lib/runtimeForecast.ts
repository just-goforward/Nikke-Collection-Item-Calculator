import { viewCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import {
  createPublicationSequenceGuard,
  type PublicationBytes,
  type PublicationByteTrust,
  verifyPublicationBytes,
} from "../../shared/forecastPublicationBytes";
import { CERTIFIED_RUNTIME_PAYLOAD_CEILING } from "../certifiedRuntime/protocol";
import { runtimeForecastConfig } from "./runtimeForecastConfig";

export type RuntimeForecastStatus = "bundled" | "checking" | "active" | "off" | "unavailable";
type Trust = Omit<PublicationByteTrust, "minimumSequence">;
type Visibility = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
const REFRESH_INTERVAL_MS = 5 * 60_000;

async function readForecast(path: string, signal: AbortSignal, request: typeof fetch) {
  const response = await request(path, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
    throw new Error("forecast_unavailable");
  if (!response.body) throw new Error("forecast_empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > CERTIFIED_RUNTIME_PAYLOAD_CEILING) throw new Error("forecast_size");
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as {
      pointer: PublicationBytes["pointer"];
      artifact?: PublicationBytes["artifact"];
      remainingMs: number;
    };
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function readPublication(
  request: typeof fetch,
  signal: AbortSignal,
  current: PublicationBytes | null,
  trust: Trust,
  sequence: ReturnType<typeof createPublicationSequenceGuard>,
) {
  const version = await readForecast("/api/forecast/version", signal, request);
  const same =
    current &&
    ((current.pointer.statement === version.pointer.statement &&
      current.pointer.signature === version.pointer.signature) ||
      (current.artifact &&
        JSON.parse(current.pointer.statement).contentHash ===
          JSON.parse(version.pointer.statement).contentHash));
  const body = same
    ? { ...version, artifact: current.artifact }
    : await readForecast("/api/forecast", signal, request);
  if (!Number.isFinite(body.remainingMs) || body.remainingMs > 60_000)
    throw new Error("forecast_invalid_freshness");
  if (
    body.remainingMs <= 0 ||
    body.pointer.statement !== version.pointer.statement ||
    body.pointer.signature !== version.pointer.signature
  )
    throw new Error("forecast_freshness");
  const envelope = { pointer: body.pointer, artifact: body.artifact ?? null };
  const verified = await verifyPublicationBytes(envelope, {
    ...trust,
    minimumSequence: sequence.minimumSequence,
    onPointer: sequence.observe,
  });
  sequence.accept(verified.pointer.sequence);
  return {
    envelope,
    verified,
    remainingMs: body.remainingMs,
  };
}

function watchVisibleForecast(visibility: Visibility, refresh: () => Promise<void>) {
  const visible = () => {
    if (visibility.visibilityState === "visible") void refresh();
  };
  visibility.addEventListener("visibilitychange", visible);
  const interval = setInterval(visible, REFRESH_INTERVAL_MS);
  void refresh();
  return () => {
    visibility.removeEventListener("visibilitychange", visible);
    clearInterval(interval);
  };
}

/** One bounded in-memory entry; never persist a candidate or use stale-on-error data.
 * The version and envelope endpoints share a primary-read deadline, not a sliding TTL.
 * remainingMs is transport freshness metadata, not part of the signed publication.
 */
export function createRuntimeForecastClient(options: {
  enabled: boolean;
  trust: Trust;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => performance.now());
  const listeners = new Set<(status: RuntimeForecastStatus) => void>();
  let status: RuntimeForecastStatus = options.enabled ? "checking" : "bundled";
  let current: PublicationBytes | null = null;
  let snapshot: Awaited<ReturnType<typeof verifyPublicationBytes>>["snapshot"] = null;
  let nextPollAt = 0;
  const sequence = createPublicationSequenceGuard();
  let pending: Promise<void> | null = null;

  function publish(next: RuntimeForecastStatus) {
    status = next;
    for (const listener of listeners) listener(next);
  }

  async function check() {
    const controller = new AbortController();
    const started = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("forecast_timeout"));
        }, 5_000);
      });
      const work = async () => {
        const accepted = await readPublication(
          request,
          controller.signal,
          current,
          options.trust,
          sequence,
        );
        const deadline = started + accepted.remainingMs;
        if (now() >= deadline) throw new Error("forecast_freshness");
        return accepted;
      };
      const attempt = work().catch((error: unknown) => {
        if (error instanceof Error && error.message === "forecast_freshness") return work();
        throw error;
      });
      const accepted = await Promise.race([attempt, timeout]);
      // A timed-out verification may finish later, but it cannot publish anything.
      current = accepted.envelope;
      snapshot = accepted.verified.snapshot;
      publish(current.artifact ? "active" : "off");
    } catch {
      current = null;
      snapshot = null;
      publish("unavailable");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  function refresh(): Promise<void> {
    if (!options.enabled) return Promise.resolve();
    if (!pending) nextPollAt = now() + REFRESH_INTERVAL_MS;
    pending ??= check().finally(() => {
      pending = null;
    });
    return pending;
  }

  function peek(asOf: string) {
    // Server freshness bounds admission, not the polling cadence. Display reads
    // retain the verified artifact; explicit acquisition/resume always refresh.
    if (current && now() >= nextPollAt && globalThis.document?.visibilityState === "visible")
      void refresh();
    if (!current || !snapshot) return null;
    return {
      publication: structuredClone(current),
      snapshot: viewCertifiedSupplySnapshot(structuredClone(snapshot), asOf),
    };
  }

  function subscribe(listener: (value: RuntimeForecastStatus) => void) {
    listeners.add(listener);
    listener(status);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    refresh,
    peek,
    subscribe,
    /** Detached, per-calculation value. Later checks cannot mutate an acquired identity. */
    async acquire(asOf: string) {
      await refresh();
      return peek(asOf);
    },
    watch(visibility: Visibility, listener: (value: RuntimeForecastStatus) => void) {
      const unsubscribe = subscribe(listener);
      if (!options.enabled) return unsubscribe;
      const unwatch = watchVisibleForecast(visibility, refresh);
      return () => {
        unsubscribe();
        unwatch();
      };
    },
  };
}

// Build-pinned trust only. API-provided keys and URL/query overrides are never accepted.
// Production builds omit the staging opt-in. No real public key is committed.
export const runtimeForecast = createRuntimeForecastClient(runtimeForecastConfig);
