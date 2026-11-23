import { rootCandidate } from "./rootCandidate";
import type { PublicationBytes } from '../../shared/forecastPublicationBytes';
import { decodePublicationBase64, verifyPublicationSignature } from '../../shared/forecastPublicationBytes';
import { previewLegacyD0Trust, runtimeForecastConfig } from './runtimeForecastConfig';
import { CERTIFIED_RUNTIME_PAYLOAD_CEILING } from '../certifiedRuntime/protocol';
import { PreviewSourceError } from './previewSourceError';

export const PREVIEW_TIMED_FEED = rootCandidate ? '/api/forecast/timed-v1' : '/preview/api/collected-forecast/timed-v1';
export const PREVIEW_LEGACY_FEED = rootCandidate ? '/api/forecast' : '/preview/api/current-forecast/legacy';
export function samePointer(a: PublicationBytes['pointer'], b: PublicationBytes['pointer']) {
  return a.statement === b.statement && a.signature === b.signature;
}

export async function readForecast(path: string, signal: AbortSignal, request: typeof fetch, layer?: 'version' | 'body') {
  const ceiling = layer === 'version' ? 4096 : CERTIFIED_RUNTIME_PAYLOAD_CEILING;
  const source = path.startsWith(PREVIEW_LEGACY_FEED) ? 'legacy' : 'timed';
  function transport(error: unknown): never {
    if (!layer) throw error;
    if (signal.aborted && signal.reason?.name !== 'TimeoutError') throw signal.reason;
    throw new PreviewSourceError(source, signal.aborted ? 'timeout' : 'network');
  }
  const response = await request(path, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal }).catch(transport);
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json') || !response.body) {
    void response.body?.cancel().catch(() => {});
    if (layer) throw new PreviewSourceError(source, [502,503,504].includes(response.status) ? 'network' : response.ok ? 'invalid' : 'missing');
    throw new Error('forecast_unavailable');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', size = 0;
  try {
    while (true) {
      const part = await reader.read().catch(transport);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > ceiling) throw new Error('forecast_size');
      text += decoder.decode(part.value, { stream: true });
    }
    const value = JSON.parse(text + decoder.decode()) as { pointer: PublicationBytes['pointer']; artifact?: PublicationBytes['artifact']; remainingMs: number };
    if (layer) {
      // Do not turn an omitted artifact into signed OFF evidence, or treat a full envelope as a version read.
      if (!value || typeof value !== 'object' || !value.pointer || !Number.isSafeInteger(value.remainingMs) ||
          Object.keys(value.pointer).sort().join(',') !== 'signature,statement' ||
          Object.hasOwn(value, 'artifact') !== (layer === 'body')) throw new Error('forecast_invalid_envelope');
      for (const key in value) if (key !== 'pointer' && key !== 'remainingMs' && key !== 'artifact')
        throw new Error('forecast_invalid_envelope');
    }
    return value;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Compare a verified pointer to the fixed primary reader. Never accept lease metadata from a solver request. */
export async function previewHeadLease(base: typeof PREVIEW_TIMED_FEED | typeof PREVIEW_LEGACY_FEED, pointer: PublicationBytes['pointer']) {
  const start = performance.now(), wallStart = Date.now();
  const source = base === PREVIEW_TIMED_FEED ? 'timed' : 'legacy';
  try {
    const head = await readForecast(`${base}/version`, AbortSignal.timeout(5000), fetch, 'version');
    if (!Number.isSafeInteger(head.remainingMs) || head.remainingMs < 0 || head.remainingMs > 60_000)
      throw new PreviewSourceError(source, 'invalid');
    if (!samePointer(head.pointer, pointer)) {
      const trust = base === PREVIEW_TIMED_FEED ? runtimeForecastConfig.trust : previewLegacyD0Trust;
      const key = await crypto.subtle.importKey('raw', decodePublicationBase64(trust.publicKeyBase64), 'Ed25519', false, ['verify']);
      await verifyPublicationSignature(head.pointer, key);
      const next = JSON.parse(head.pointer.statement), prior = JSON.parse(pointer.statement);
      if (next.environment === prior.environment && next.keyId === prior.keyId && next.domain === prior.domain &&
          Number.isSafeInteger(next.sequence) && next.sequence > prior.sequence && next.issuedAt <= Date.now() &&
          performance.now() < start + head.remainingMs && Date.now() < wallStart + head.remainingMs)
        throw new Error('preview_source_advanced');
      throw new PreviewSourceError(source,'invalid');
    }
    const until = start + head.remainingMs, wallUntil = wallStart + head.remainingMs;
    if (Date.now() < wallStart || JSON.parse(head.pointer.statement).issuedAt > Date.now()) throw new PreviewSourceError(source, 'clock');
    if (performance.now() >= until || Date.now() >= wallUntil) throw new PreviewSourceError(source, 'expired');
    return { until, wallUntil };
  } catch (error) {
    if (error instanceof PreviewSourceError || (error instanceof Error && error.message === 'preview_source_advanced')) throw error;
    throw new PreviewSourceError(source,'invalid');
  }
}
