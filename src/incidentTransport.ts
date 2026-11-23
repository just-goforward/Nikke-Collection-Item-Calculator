import { incidentOrigin, incidentPath, type IncidentReason, type IncidentStage } from '../shared/recalculationIncident';
import { SERVICE_H14_BUILD } from './serviceH14/generated/build';

export function reportRecalculationFailure(reason: IncidentReason, stage: IncidentStage): void {
  if (location.origin !== incidentOrigin || /^\/preview(?:\/|$)/.test(location.pathname)) return;
  // Reporting must never interrupt failure recovery, even if transport is unavailable.
  void (async () => {
    await fetch(incidentPath, { method: 'POST', credentials: 'omit', redirect: 'error',
      mode: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', keepalive: true,
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ v: 1, attempt: crypto.randomUUID(), build: SERVICE_H14_BUILD.codeHash, reason, stage }) });
  })().catch(() => {});
}
