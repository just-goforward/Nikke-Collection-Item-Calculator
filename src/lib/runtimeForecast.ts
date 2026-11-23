import { rootCandidate } from "./rootCandidate";
import { viewCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import {
  createPublicationSequenceGuard,
  type PublicationBytes,
  type PublicationByteTrust,
  decodePublicationBase64, verifyPublicationSignature,
  verifyPublicationBytes,
} from "../../shared/forecastPublicationBytes";
import { PREVIEW_LEGACY_FEED, readForecast, samePointer } from "./forecastRead";
import { previewLegacyD0Enabled, previewLegacyD0Trust, runtimeForecastConfig } from "./runtimeForecastConfig";
import { PreviewSourceError } from "./previewSourceError";

export type RuntimeForecastStatus = "bundled" | "checking" | "active" | "off" | "unavailable";
type Trust = Omit<PublicationByteTrust, "minimumSequence">;
type Visibility = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
const REFRESH_INTERVAL_MS = 5 * 60_000;


type RuntimeSequence = {
  readonly minimumSequence: number;
  observe(n: number): void;
  accept(n: number): void;
  last?: { sequence: number; statement: string };
};

async function readPublication(
  request: typeof fetch,
  signal: AbortSignal,
  current: PublicationBytes | null,
  trust: Trust,
  sequence: RuntimeSequence,
  off: PublicationBytes | null,
) {
  // New preview tabs never ask for the retained fixture API; old tabs keep their original URL and key.
  const prefix = import.meta.env?.BASE_URL ?? "/";
  const feed = prefix === "/preview/" ? "collected-forecast" : "forecast";
  const legacyD0 = trust === previewLegacyD0Trust;
  const source = legacyD0 ? 'legacy' : 'timed';
  const base = legacyD0 ? PREVIEW_LEGACY_FEED : `${prefix}api/${feed}${trust.channel === "timed-v1" ? "/timed-v1" : ""}`;
  const version = await readForecast(`${base}/version`, signal, request, (rootCandidate || previewLegacyD0Enabled) ? "version" : undefined);
  if (off && !isCurrentOff(off)) throw lostOff();
  if (!Number.isFinite(version.remainingMs) || version.remainingMs < 0 || version.remainingMs > 60_000) throw new Error("forecast_invalid_freshness");
  const same =
    current &&
    ((current.pointer.statement === version.pointer.statement &&
      current.pointer.signature === version.pointer.signature) ||
      (current.artifact &&
        JSON.parse(current.pointer.statement).contentHash ===
          JSON.parse(version.pointer.statement).contentHash));
  const body = same
    ? { ...version, artifact: current.artifact }
    : await readForecast(base, signal, request, (rootCandidate || previewLegacyD0Enabled) ? "body" : undefined);
  if (!Number.isFinite(body.remainingMs) || body.remainingMs < 0 || body.remainingMs > 60_000)
    throw new Error("forecast_invalid_freshness");
  const changed = !samePointer(version.pointer, body.pointer);
  if (changed && !(rootCandidate || previewLegacyD0Enabled)) throw new Error("forecast_freshness");
  if (changed) {
    // A torn version/body read is recoverable only across two genuine, ordered
    // pointers. A corrupt version must not become a successful second attempt.
    const key = await crypto.subtle.importKey('raw', decodePublicationBase64(trust.publicKeyBase64), 'Ed25519', false, ['verify']);
    await verifyPublicationSignature(version.pointer, key);
    const first = JSON.parse(version.pointer.statement), last = JSON.parse(body.pointer.statement);
    if (first.domain !== last.domain || first.environment !== last.environment || first.keyId !== last.keyId ||
        !Number.isSafeInteger(first.sequence) || first.sequence < Math.max(1,sequence.minimumSequence) ||
        !(last.sequence > first.sequence)) throw new PreviewSourceError(source,'invalid');
  }
  const envelope = { pointer: body.pointer, artifact: body.artifact ?? null };
  const verified = await verifyPublicationBytes(envelope, {
    ...trust,
    minimumSequence: legacyD0 ? Math.max(10, sequence.minimumSequence) : sequence.minimumSequence,
    onPointer: n => {
      signal.throwIfAborted();
      if ((rootCandidate || previewLegacyD0Enabled) && sequence.last?.sequence === n && sequence.last.statement !== body.pointer.statement)
        throw new PreviewSourceError(source,'invalid');
      sequence.observe(n);
      if ((rootCandidate || previewLegacyD0Enabled)) sequence.last = { sequence:n, statement:body.pointer.statement };
    },
  });
  signal.throwIfAborted();
  sequence.accept(verified.pointer.sequence);
  if ((rootCandidate || previewLegacyD0Enabled) && verified.pointer.issuedAt > Date.now()) throw new PreviewSourceError(source,'clock');
  if (changed) throw new PreviewSourceError(source,'changed');
  if (off && !isCurrentOff(off)) throw lostOff();
  return {
    envelope,
    verified,
    remainingMs: Math.min(version.remainingMs, body.remainingMs),
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
  const legacyD0 = options.trust === previewLegacyD0Trust;
  let boundOff: PublicationBytes | null = null;
  let status: RuntimeForecastStatus = options.enabled ? "checking" : "bundled";
  const source = legacyD0 ? 'legacy' : 'timed';
  let problem: PreviewSourceError | null = null;
  let current: PublicationBytes | null = null;
  let snapshot: Awaited<ReturnType<typeof verifyPublicationBytes>>["snapshot"] = null;
  let nextPollAt = 0;
  // Leases authorize acquisitions/actions, not historical display. Use both clocks:
  // some browsers pause performance.now() across system sleep.
  const collectedPreview = rootCandidate || import.meta.env?.BASE_URL === "/preview/";
  let leaseUntil = 0;
  let wallLeaseStart = 0;
  let wallLeaseUntil = 0;
  let renew: ReturnType<typeof setTimeout> | undefined;
  let expire: ReturnType<typeof setTimeout> | undefined;
  const sequence: RuntimeSequence = createPublicationSequenceGuard();
  let pending: Promise<void> | null = null;

  function publish(next: RuntimeForecastStatus) {
    status = next;
    for (const listener of listeners) listener(next);
  }

  function unavailable(reason = new PreviewSourceError(source,'expired')) {
    problem = reason;
    clearTimeout(renew);
    clearTimeout(expire);
    current = null;
    snapshot = null;
    boundOff = null;
    publish("unavailable");
  }

  async function check() {
    const controller = new AbortController();
    const started = now();
    const wallStarted = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("forecast_timeout"));
        }, 5_000);
      });
      const off = legacyD0 ? freshTimedOff() : null;
      if (legacyD0 && !rootCandidate && !off) throw lostOff();
      const work = async () => {
        if (off && !isCurrentOff(off)) throw lostOff();
        const accepted = await readPublication(
          request,
          controller.signal,
          current,
          options.trust,
          sequence,
          off,
        );
        const deadline = started + accepted.remainingMs;
        if (now() >= deadline || (collectedPreview && Date.now() >= wallStarted + accepted.remainingMs))
          throw collectedPreview ? new PreviewSourceError(source,'expired') : new Error("forecast_freshness");
        if (collectedPreview && Date.now() < wallStarted) throw new PreviewSourceError(source,'clock');
        return accepted;
      };
      const attempt = work().catch((error: unknown) => {
        if (!collectedPreview && error instanceof Error && error.message === "forecast_freshness") return work();
        throw error;
      });
      const accepted = await Promise.race([attempt, timeout]);
      // A timed-out verification may finish later, but it cannot publish anything.
      if (off && !isCurrentOff(off)) throw lostOff();
      boundOff = off;
      current = accepted.envelope;
      snapshot = accepted.verified.snapshot;
      if (collectedPreview) {
        clearTimeout(renew); clearTimeout(expire);
        leaseUntil = started + accepted.remainingMs;
        wallLeaseStart = wallStarted;
        wallLeaseUntil = wallStarted + accepted.remainingMs;
        if (current.artifact || previewLegacyD0Enabled) {
          const ttl = Math.min(leaseUntil - now(), wallLeaseUntil - Date.now());
          if (ttl <= 0) throw new PreviewSourceError(source,'expired');
          expire = setTimeout(unavailable, Math.ceil(ttl));
          if (ttl > 6000) renew = setTimeout(() => {
            if (listeners.size && globalThis.document?.visibilityState === "visible") void refresh();
          }, ttl - 5000);
        }
      }
      problem = null;
      publish(current.artifact ? "active" : "off");
    } catch (error) {
      unavailable(error instanceof PreviewSourceError ? error :
        new PreviewSourceError(source,error instanceof Error && error.message === 'forecast_timeout' ? 'timeout' : 'invalid'));
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

  function peek(asOf: string, refreshIfDue = true) {
    // A suspended tab's expiry timer may not have fired. Do not return its
    // expired snapshot even to synchronous action-boundary reads on resume.
    if (collectedPreview && current?.artifact && (now() >= leaseUntil || Date.now() < wallLeaseStart || Date.now() >= wallLeaseUntil)) return null;
    if (legacyD0 && !rootCandidate && (!boundOff || !isCurrentOff(boundOff))) return null;
    if (refreshIfDue && current && now() >= nextPollAt && globalThis.document?.visibilityState === "visible")
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
    lastFailure: () => problem,
    peekOff(): PublicationBytes | null {
      return status === "off" && current && !current.artifact && now() < leaseUntil && Date.now() >= wallLeaseStart && Date.now() < wallLeaseUntil ? structuredClone(current) : null;
    },
    subscribe,
    /** Detached, per-calculation value. Later checks cannot mutate an acquired identity. */
    async acquire(asOf: string, strict = false) {
      await refresh();
      if (strict && (Date.now() < wallLeaseStart || Date.parse(asOf) > Date.now())) throw new PreviewSourceError(source,'clock');
      const value = peek(asOf, false);
      if (strict && !value) {
        if (problem) throw problem;
        if (!current || (status !== 'off' || now() >= leaseUntil || Date.now() >= wallLeaseUntil))
          throw new PreviewSourceError(source,'expired');
      }
      return value;
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
// The default build is bundled; online builds explicitly pin their environment and key.
export const runtimeForecast = createRuntimeForecastClient(runtimeForecastConfig);
function freshTimedOff(): PublicationBytes | null {
  return previewLegacyD0Enabled ? runtimeForecast.peekOff() : null;
}
function isCurrentOff(previous: PublicationBytes): boolean {
  const current = freshTimedOff();
  return !!current && samePointer(previous.pointer, current.pointer);
}
export const previewLegacyForecast = createRuntimeForecastClient({
  enabled: rootCandidate || previewLegacyD0Enabled, trust: previewLegacyD0Trust,
});
export function peekPreviewLegacyD0(asOf: string) {
  const timedOff = freshTimedOff();
  if (!timedOff) return null;
  const legacy = previewLegacyForecast.peek(asOf, false);
  return legacy && { ...legacy, legacyD0: { timedOff } };
}
function lostOff() { return runtimeForecast.lastFailure() ?? new PreviewSourceError('timed','changed'); }
export async function acquirePreviewLegacyD0(asOf: string, strict = false) {
  const before = freshTimedOff();
  if (before) {
    const active = await previewLegacyForecast.acquire(asOf, strict);
    const after = freshTimedOff();
    if (active && after && samePointer(after.pointer, before.pointer))
      return { ...active, legacyD0: { timedOff: after } };
    if (strict && after && samePointer(after.pointer,before.pointer)) throw new PreviewSourceError('legacy','missing');
  }
  if (strict) throw lostOff();
  return null;
}
