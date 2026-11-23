import { prepareServiceForecast } from '../hooks/serviceCertifiedForecast';
import { nextSupplyTimelineChange, previewTimedSupply } from '../hooks/previewExpectedSupply';
import type { PreviewTimedSupply } from '../ui-types';
import { samePointer } from './forecastRead';
import type { PreviewInvalidation, PreviewReader } from './previewCalendar';
import { readPreviewJoint } from './previewJoint';
import { PreviewSourceError } from './previewSourceError';
import { previewLegacyForecast, runtimeForecast } from './runtimeForecast';

/** Live browsing is a fresh projection, not new authority for a retained result. */
export const readPreviewTimedSupply: PreviewReader<PreviewTimedSupply> = async signal => {
  const asOf = new Date().toISOString();
  const { snapshot, publication, legacyD0 } = await prepareServiceForecast(asOf, signal).catch((error: unknown) => {
    if (error instanceof PreviewSourceError && error.reason === 'changed') throw new Error('preview_source_advanced', { cause: error });
    throw error;
  });
  if (!publication?.artifact) throw new Error('preview_supply_unavailable');
  const joint = legacyD0 ? await readPreviewJoint(snapshot, publication, signal, legacyD0.timedOff) : null;
  if (legacyD0 && !joint) throw new Error('preview_supply_unavailable');
  const source = joint?.snapshot ?? snapshot;
  const calendar = previewTimedSupply({ asOf, snapshot: source,
    forecastPublication: publication, ...(legacyD0 ? { previewJoint: legacyD0 } : {}) });
  if (!calendar) throw new Error('preview_supply_unavailable');

  // A verified successor in the same channel can replace the displayed table.
  // OFF/revocation, loss of the primary, or an expired joint are not successors.
  const invalidation = (): PreviewInvalidation | undefined => {
    if (joint && (performance.now() >= joint.until || Date.now() >= joint.wallUntil)) return 'unavailable';
    if (legacyD0) {
      const off = runtimeForecast.peekOff();
      if (!off) return runtimeForecast.lastFailure()?.reason === 'changed' ? 'superseded' : 'unavailable';
      if (previewLegacyForecast.peekOff()) return 'unavailable';
      const failure = previewLegacyForecast.lastFailure();
      if (failure) return failure.reason === 'changed' ? 'superseded' : 'unavailable';
      // The legacy client's old entry is bound to the old OFF slot, so peek()
      // can already be empty while its successor's legacy/joint reads are pending.
      if (!samePointer(off.pointer, legacyD0.timedOff.pointer)) return 'superseded';
    }
    const current = (legacyD0 ? previewLegacyForecast : runtimeForecast).peek(asOf, false);
    if (!current) return !legacyD0 && runtimeForecast.lastFailure()?.reason === 'changed' ? 'superseded' : 'unavailable';
    if (!samePointer(current.publication.pointer, publication.pointer)) return 'superseded';
  };
  const phase = nextSupplyTimelineChange({ asOf, snapshot: source });
  const leaseTtl = Math.min(45_000, joint ? joint.until - performance.now() : Infinity,
    joint ? joint.wallUntil - Date.now() : Infinity);
  signal.throwIfAborted();
  const reason = invalidation();
  if (reason === 'superseded') throw new Error('preview_source_advanced');
  if (reason || leaseTtl <= 0) throw new Error('preview_supply_expired');
  const ttl = Math.max(0, Math.min(leaseTtl, phase - Date.now()));
  return {
    calendar, ttl,
    observe(invalidate) {
      const check = () => { const reason = invalidation(); if (reason) invalidate(reason); };
      const timed = runtimeForecast.subscribe(check);
      const legacy = legacyD0 ? previewLegacyForecast.subscribe(check) : undefined;
      return () => { timed(); legacy?.(); };
    },
  };
};
