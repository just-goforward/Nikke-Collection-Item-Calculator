import { createCertifiedForecastIdentity, sameCertifiedForecastIdentity } from "../../shared/certifiedForecastIdentity";
import { isCertifiedEventClaimable, isCertifiedEventModeled, viewCertifiedSupplySnapshot, type CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { PointerStatement, PublicationBytes } from "../../shared/forecastPublicationBytes";
import { gameDayStartMs } from "../../shared/gameDay";
import { runtimeForecastEnvironment } from "../../shared/runtimeForecastMode";
import { prepareCertifiedForecast } from "../lib/certifiedForecast";
import { prepareLocalCertifiedForecast } from "../lib/certifiedLocalForecast";
import { localCertifiedForecastEnabled } from "../lib/certifiedLocalPolicy";
import type { RuntimeForecastStatus } from "../lib/runtimeForecast";

type AcquiredForecast = { snapshot: CertifiedSupplySnapshot; publication: PublicationBytes };

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
  const normalized = { ...snapshot, asOf: new Date(gameDayStartMs(now)).toISOString() };
  const events = JSON.stringify(snapshot.events.map((event) => [
    event.id,
    Date.parse(event.at) <= now,
    isCertifiedEventModeled(snapshot, event, snapshot.asOf),
    isCertifiedEventClaimable(snapshot, event, snapshot.asOf),
  ]));
  return {
    source: JSON.stringify([pointer.environment, pointer.keyId, pointer.candidateId, pointer.contentHash]),
    normalized,
    events,
    // A synchronous action gate for the SAME signed source. Its property order
    // is inherited from that source; source byte changes are never normalized.
    clock: JSON.stringify([normalized, events]),
  };
}

/** One subscription owned by the service hook's adapter, started on Calculate.
 * The bound value is request evidence, never an acquisition fallback/cache.
 */
export async function createServiceForecastLifecycle(retire: () => void, isMounted: () => boolean) {
  if (runtimeForecastEnvironment(import.meta.env.VITE_FORECAST_RUNTIME) === null) return null;
  const { runtimeForecast } = await import("../lib/runtimeForecast");
  if (!isMounted()) return null;
  type Bound = {
    value: AcquiredForecast;
    comparison: ReturnType<typeof forecastComparison>;
    identity: ReturnType<typeof createCertifiedForecastIdentity>;
  };
  let bound: Bound | null = null;
  let disposed = false;
  let observation = 0;
  let status: RuntimeForecastStatus = "checking";
  const forget = () => { ++observation; bound = null; };
  const invalidate = () => {
    if (disposed || !bound) return;
    forget();
    retire();
  };
  const currentView = (previous: Bound) => {
    const asOf = new Date().toISOString();
    // Pure peek: a listener/action must never start a refresh loop.
    const active = runtimeForecast.peek(asOf, false);
    return active ?? {
      publication: previous.value.publication,
      snapshot: viewCertifiedSupplySnapshot(previous.value.snapshot, asOf),
    };
  };
  const check = () => {
    if (disposed || !bound) return false;
    if (status === "off") { invalidate(); return false; }
    try {
      const current = forecastComparison(currentView(bound));
      if (current.source === bound.comparison.source && current.clock === bound.comparison.clock)
        return true;
    } catch {
      // An unprovable time/view equivalence cannot authorize an action.
    }
    invalidate();
    return false;
  };
  const observe = async () => {
    const ticket = ++observation;
    const previous = bound;
    if (disposed || !previous) return;
    if (status === "off") { invalidate(); return; }
    try {
      const current = forecastComparison(currentView(previous));
      // Verified supersession is already decided by these complete synchronous
      // keys. Retire before yielding: a later unavailable observation must not
      // erase B merely by replacing this observation's asynchronous hash ticket.
      if (current.source !== previous.comparison.source ||
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
      ++observation;
      const comparison = forecastComparison(value);
      const candidate = {
        value, comparison, identity: createCertifiedForecastIdentity(comparison.normalized),
      };
      bound = candidate;
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
export async function prepareServiceForecast(asOf: string): Promise<{
  snapshot: CertifiedSupplySnapshot;
  publication?: PublicationBytes;
  forecastSource?: "local";
}> {
  if (runtimeForecastEnvironment(import.meta.env.VITE_FORECAST_RUNTIME) !== null) {
    const { runtimeForecast } = await import("../lib/runtimeForecast");
    const acquired = await runtimeForecast.acquire(asOf);
    if (!acquired) throw new Error("forecast_unavailable");
    return { snapshot: acquired.snapshot, publication: acquired.publication };
  }
  const local = localCertifiedForecastEnabled();
  const snapshot = await (local ? prepareLocalCertifiedForecast : prepareCertifiedForecast)(asOf);
  return { snapshot, ...(local ? { forecastSource: "local" as const } : {}) };
}
