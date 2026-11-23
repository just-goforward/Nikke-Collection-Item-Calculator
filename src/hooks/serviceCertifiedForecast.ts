import { previewLegacyForecast } from "../lib/runtimeForecast";
import { rootCandidate } from "../lib/rootCandidate";
import { createCertifiedForecastIdentity, sameCertifiedForecastIdentity } from "../../shared/certifiedForecastIdentity";
import { isCertifiedEventClaimable, isCertifiedEventModeled, type CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { PointerStatement, PublicationBytes } from "../../shared/forecastPublicationBytes";
import { gameDayStartMs } from "../../shared/gameDay";
import { nextReceiptPhase, receiptDay } from "../../shared/receiptClock";
import { runtimeForecastEnvironment } from "../../shared/runtimeForecastMode";
import { prepareCertifiedForecast } from "../lib/certifiedForecast";
import { prepareLocalCertifiedForecast } from "../lib/certifiedLocalForecast";
import { localCertifiedForecastEnabled } from "../lib/certifiedLocalPolicy";
import type { RuntimeForecastStatus } from "../lib/runtimeForecast";
import { PreviewSourceError } from "../lib/previewSourceError";

type AcquiredForecast = {
  snapshot: CertifiedSupplySnapshot;
  publication: PublicationBytes;
};

/** Only use on publications already verified by acquisition. Channels have independent sequences. */
export function verifiedSequence(publication: PublicationBytes) {
  return (JSON.parse(publication.pointer.statement) as PointerStatement).sequence;
}

/**
 * Lifecycle comparison only; NEVER sent to the calculation client.
 * Audited time consumers: events.eventOffset/futureEvents, claimability/modeling,
 * viewCertifiedSupplySnapshot/ageMedianSnapshot, and WasmKernel.prepare.
 * The kernel receives discrete event days/rules, not wall-clock asOf. Exact asOf
 * remains in the real snapshot, request, trust hash and recommendation binding.
 *
 * Preserve the entire viewed snapshot, including coverage, prediction shifts,
 * sourceStatus, rules/laws and cancellation. Only query asOf is day-normalized.
 * The separate event predicates retain intraday opening/expiry and D0->D1 changes.
 * Source content is signed-byte-exact: metadata changes retire conservatively.
 */
function forecastComparison(value: AcquiredForecast) {
  const pointer = JSON.parse(value.publication.pointer.statement) as PointerStatement;
  const snapshot = value.snapshot;
  const now = Date.parse(snapshot.asOf);
  const normalized = { ...snapshot, asOf: new Date(Math.max(
    gameDayStartMs(now),
    snapshot.sourceAuthority ? Date.parse(snapshot.sourceAuthority.approvedAt) : -Infinity,
  )).toISOString() };
  const events = JSON.stringify(snapshot.events.map((event) => [
    event.id,
    Date.parse(event.at) <= now,
    Math.max(0,Math.min(15,receiptDay(now,Date.parse(event.at)))),
    isCertifiedEventModeled(snapshot, event, snapshot.asOf),
    isCertifiedEventClaimable(snapshot, event, snapshot.asOf),
  ]));
  return {
    phaseUntil: snapshot.events.reduce((end,e)=>Math.min(end,nextReceiptPhase(now,Date.parse(e.at))),
      gameDayStartMs(now)+86_400_000),
    source: JSON.stringify([pointer.environment, pointer.keyId, pointer.candidateId, pointer.contentHash]),
    normalized,
    events,
    // A synchronous action gate for the SAME signed source. Its property order
    // is inherited from that source; source byte changes are never normalized.
    clock: JSON.stringify([normalized, events]),
  };
}

/** Non-preview service policy: retire the recommendation when its live source changes. */
export async function createServiceForecastLifecycle(retire: () => void, isMounted: () => boolean) {
  if (runtimeForecastEnvironment(import.meta.env.VITE_FORECAST_RUNTIME) === null) return null;
  // The runtime client is a build-pinned online dependency, not a bundled/local acquisition fallback.
  const { runtimeForecast } = await import("../lib/runtimeForecast");
  if (!isMounted()) return null;
  type Bound = {
    comparison: ReturnType<typeof forecastComparison>;
    identity: ReturnType<typeof createCertifiedForecastIdentity>;
  };
  let bound: Bound | null = null;
  let disposed = false;
  let observation = 0;
  let status: RuntimeForecastStatus = "checking";
  let authorityTimer: ReturnType<typeof setTimeout> | undefined;
  const forget = () => {
    ++observation;
    bound = null;
    clearTimeout(authorityTimer);
    authorityTimer = undefined;
  };
  const invalidate = () => {
    if (disposed || !bound) return;
    forget();
    retire();
  };
  const currentComparison = () => {
    const active = status === "active" && runtimeForecast.peek(new Date().toISOString(), false);
    return active ? forecastComparison(active) : null;
  };
  const check = () => {
    if (disposed || !bound) return false;
    if(Date.now()>=bound.comparison.phaseUntil){ invalidate(); return false; }
    try {
      const current = currentComparison();
      if (current && current.source === bound.comparison.source && current.clock === bound.comparison.clock) {
        return true;
      }
    } catch {
      // An unprovable time/view equivalence cannot authorize an action.
    }
    invalidate();
    return false;
  };
  const scheduleAuthorityCheck = () => {
    clearTimeout(authorityTimer);
    const authority = bound?.comparison.normalized.sourceAuthority;
    if (!bound || disposed) return;
    if (!authority) {
      authorityTimer=setTimeout(invalidate,Math.max(0,bound.comparison.phaseUntil-Date.now()));
      return;
    }
    const boundary = Math.min(
      bound.comparison.phaseUntil,
      Date.parse(authority.freshUntil), Date.parse(authority.until),
      gameDayStartMs(Date.parse(authority.observedAt)) + 86_400_000,
      Date.now() + 60_000,
    );
    authorityTimer = setTimeout(() => {
      if (!check()) return;
      // Arm exact expiry BEFORE asynchronous eligibility refresh. A stalled
      // fetch cannot postpone expiry for an active or idle displayed result.
      scheduleAuthorityCheck();
      void runtimeForecast.refresh().then(() => { check(); });
    }, Math.max(0, boundary - Date.now()));
  };
  const observe = async () => {
    const ticket = ++observation;
    const previous = bound;
    if (disposed || !previous) return;
    try {
      const current = currentComparison();
      // Verified supersession is already decided by these complete synchronous
      // keys. Retire before yielding: a later unavailable observation must not
      // erase B merely by replacing this observation's asynchronous hash ticket.
      if (!current || current.source !== previous.comparison.source ||
          current.clock !== previous.comparison.clock) {
        invalidate();
        return;
      }
      const [before, after] = await Promise.all([
        previous.identity, createCertifiedForecastIdentity(current.normalized),
      ]);
      if (disposed || ticket !== observation || bound !== previous) return;
      if (!sameCertifiedForecastIdentity(before, after)) invalidate();
    } catch {
      if (!disposed && ticket === observation && bound === previous) invalidate();
    }
  };
  const stop = runtimeForecast.watch(document, (next) => {
    status = next;
    void observe();
  });
  return {
    forget,
    check,
    async bind(value: AcquiredForecast) {
      if (disposed) return false;
      forget();
      const comparison = forecastComparison(value);
      const candidate = {
        comparison, identity: createCertifiedForecastIdentity(comparison.normalized),
      };
      bound = candidate;
      scheduleAuthorityCheck();
      await candidate.identity;
      // B/off/disposal can arrive while A's identity is still being computed.
      return !disposed && bound === candidate && check();
    },
    dispose() {
      disposed = true;
      forget();
      stop();
    },
  };
}

/** Shared preparation for the actual adapter and solver-free production preflight.
 * Importing this module does not acquire a forecast or create a client.
 */
export async function prepareServiceForecast(asOf: string, signal?: AbortSignal): Promise<{
  snapshot: CertifiedSupplySnapshot;
  publication?: PublicationBytes;
  legacyD0?: { timedOff: PublicationBytes };
  rootConditional?: true;
  forecastSource?: "local";
}> {
  if (rootCandidate) {
    const basis = await previewLegacyForecast.acquire(asOf, true);
    signal?.throwIfAborted();
    if (!basis) throw new PreviewSourceError('legacy','missing');
    return { ...basis, rootConditional: true };
  }
  if (runtimeForecastEnvironment(import.meta.env.VITE_FORECAST_RUNTIME) !== null) {
    const { runtimeForecast, acquirePreviewLegacyD0 } = await import("../lib/runtimeForecast");
    const active = await runtimeForecast.acquire(asOf, import.meta.env.BASE_URL === "/preview/");
    signal?.throwIfAborted();
    if (active) return active;
    if (import.meta.env.BASE_URL === "/preview/") {
      if (!runtimeForecast.peekOff()) throw runtimeForecast.lastFailure?.() ?? new PreviewSourceError('timed','expired');
      const pair = await acquirePreviewLegacyD0(asOf, true);
      signal?.throwIfAborted();
      if (pair) return pair;
      throw new PreviewSourceError('legacy','missing');
    }
    throw new Error("forecast_unavailable");
  }
  if (import.meta.env.BASE_URL === "/preview/") throw new Error("forecast_unavailable");
  const local = localCertifiedForecastEnabled();
  const snapshot = await (local ? prepareLocalCertifiedForecast : prepareCertifiedForecast)(asOf);
  return { snapshot, ...(local ? { forecastSource: "local" as const } : {}) };
}
