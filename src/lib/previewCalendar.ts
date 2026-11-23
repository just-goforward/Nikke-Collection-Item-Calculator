import { GAME_DAY_MS, gameDayKey, gameDayStartMs } from '../../shared/gameDay.ts';
import { decodePublicationBase64, verifyPublicationSignature } from '../../shared/forecastPublicationBytes.ts';
import trust from '../../preview-gateway/trust.json' with { type: 'json' };

const limit = 32 * 1024;
export type CollectedEvent = { kind: 'cooperation' | 'solo'; startsAt: string; endsAt: string; sourceUrl: string; sourceHash: string };
export type CollectedCalendar = { sequence: number; issuedAt: number; expiresAt: number; gameDay: string;
  status: 'partial' | 'unavailable'; events: CollectedEvent[] };
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('preview_calendar_invalid');
}
function fields(value: unknown, keys: string): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
}
function iso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value);

// The high water mark belongs to one reader, and survives expiry, network errors and visibility changes.
// Equal-sequence reuse is allowed only for the exact same signed statement.
function signedVerifier<T>(key: CryptoKey, expectedDomain: string, decode: (doc: Record<string, unknown>) => T) {
  let sequence = 0, statement = '';
  return async (wire: unknown, now: number) => {
    requireValid(fields(wire, 'remainingMs,signature,statement'));
    const { remainingMs, signature, statement: next } = wire;
    requireValid(integer(remainingMs) && remainingMs > 0 && remainingMs <= 60_000 &&
      typeof signature === 'string' && signature.length === 88 && typeof next === 'string' && next.length <= limit);
    await verifyPublicationSignature({ statement: next, signature }, key);
    const doc: unknown = JSON.parse(next);
    requireValid(doc && typeof doc === 'object' && !Array.isArray(doc));
    const record = doc as Record<string, unknown>;
    const { domain, environment, keyId, gameDay, issuedAt, expiresAt, sequence: s } = record;
    requireValid(domain === expectedDomain && environment === trust.environment && keyId === trust.keyId &&
      integer(s) && s > 0 && s >= sequence && (s !== sequence || statement === next) && integer(issuedAt) && integer(expiresAt) &&
      issuedAt > 0 && issuedAt <= now && now < expiresAt && gameDay === gameDayKey(issuedAt) && gameDay === gameDayKey(now) &&
      expiresAt <= Math.min(issuedAt + 900_000, gameDayStartMs(issuedAt) + GAME_DAY_MS));
    const calendar = decode(record);
    sequence = s; statement = next;
    return { calendar, remainingMs };
  };
}

function validateEvents(events: unknown): asserts events is CollectedEvent[] {
    requireValid(Array.isArray(events) && events.length <= 64);
    let previousStart = '';
    const seen = new Set<string>();
    for (const event of events as unknown[]) {
      requireValid(fields(event, 'endsAt,kind,sourceHash,sourceUrl,startsAt'));
      const { endsAt, kind, sourceHash, sourceUrl, startsAt } = event;
      requireValid((kind === 'solo' || kind === 'cooperation') && iso(startsAt) && iso(endsAt) && startsAt <= endsAt &&
        startsAt >= previousStart && typeof sourceHash === 'string' && /^[a-f0-9]{64}$/.test(sourceHash) &&
        typeof sourceUrl === 'string' && /^https:\/\/game\.naver\.com\/lounge\/nikke\/board\/detail\/[1-9]\d{0,19}$/.test(sourceUrl));
      const id = `${kind}:${startsAt}:${endsAt}`;
      requireValid(!seen.has(id)); seen.add(id); previousStart = startsAt;
    }
}

export function createCalendarVerifier(key: CryptoKey) {
  return signedVerifier(key, 'nikke.preview.collected-calendar.v1', doc => {
    requireValid(fields(doc, 'domain,environment,events,expiresAt,gameDay,issuedAt,keyId,sequence,status'));
    const {events, status} = doc;
    validateEvents(events);
    requireValid(status === 'partial' ? events.length > 0 : status === 'unavailable' && !events.length);
    return doc as unknown as CollectedCalendar;
  });
}

type ReaderValue = { expiresAt: number };
export type PreviewInvalidation = 'superseded' | 'unavailable';
export type PreviewReader<T> = (signal: AbortSignal) => Promise<{
  calendar: T;
  ttl: number;
  observe?: (invalidate: (reason: PreviewInvalidation) => void) => () => void;
}>;
function createReader<T extends ReaderValue>(path: string, factory: (key: CryptoKey) =>
  (wire: unknown, now: number) => Promise<{calendar: T; remainingMs: number}>): PreviewReader<T> {
  const verifier = crypto.subtle.importKey('raw', decodePublicationBase64(trust.publicKeyBase64), 'Ed25519', false, ['verify'])
    .then(factory);
  return async (signal: AbortSignal) => {
    const verify = await verifier;
    const started = performance.now();
    const response = await fetch(path, { method: 'GET', credentials: 'omit',
      cache: 'no-store', redirect: 'error', signal });
    requireValid(response.status === 200 && response.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json' && response.body);
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0, text = '';
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength; requireValid(size <= limit);
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel(); reader.releaseLock(); }
    const { calendar, remainingMs } = await verify(JSON.parse(text), Date.now());
    const ttl = Math.min(started + remainingMs - performance.now(), calendar.expiresAt - Date.now());
    requireValid(!signal.aborted && ttl > 0);
    return { calendar, ttl };
  };
}

export const createCollectedCalendarReader = () => createReader('/preview/api/collected-calendar', createCalendarVerifier);

// V1 compatibility verifier for the legacy publication/route tests only.
type Pieces = [number, number, number];
type SupplySource = 'dispatch' | 'weekly' | 'normal-shop' | 'solo';
type ConditionalSupply = {
  sequence: number; issuedAt: number; expiresAt: number; gameDay: string; status: 'partial';
  basis: { sequence: number; candidateId: string; contentHash: string; ruleId: string };
  events: CollectedEvent[];
  days: { day: number; gameDay: string; daily: Pieces; cumulative: Pieces; sources: SupplySource[] }[];
};
const pieces = (v: unknown): v is Pieces => Array.isArray(v) && v.length === 3 &&
  v.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER);
export function createSupplyVerifier(key: CryptoKey) {
  return signedVerifier(key, 'nikke.preview.conditional-supply.v1', doc => {
    requireValid(fields(doc, 'basis,days,domain,environment,events,expiresAt,gameDay,issuedAt,keyId,sequence,status'));
    const {basis, days, events, issuedAt, status} = doc;
    requireValid(status === 'partial' && integer(issuedAt) && fields(basis, 'candidateId,contentHash,ruleId,sequence'));
    const {sequence, candidateId, contentHash, ruleId} = basis;
    requireValid(integer(sequence) && sequence > 0 && typeof candidateId === 'string' && candidateId.length > 0 &&
      typeof contentHash === 'string' && /^[a-f0-9]{64}$/.test(contentHash) &&
      ruleId === 'schedule-kit-v4:documented-physical-supply-v2' && Array.isArray(days) && days.length === 14);
    validateEvents(events);
    const sum: Pieces = [0, 0, 0];
    for (const [i,row] of days.entries()) {
      requireValid(fields(row, 'cumulative,daily,day,gameDay,sources'));
      const {day, gameDay, daily, cumulative, sources} = row;
      requireValid(day === i+1 && gameDay === gameDayKey(issuedAt + (i+1)*GAME_DAY_MS) && pieces(daily) && pieces(cumulative) &&
        Array.isArray(sources) && sources.every(s => ['dispatch','weekly','normal-shop','solo'].includes(s)) &&
        new Set(sources).size === sources.length);
      for (const k of [0,1,2] as const) {
        sum[k] += daily[k];
        requireValid(Math.abs(cumulative[k]-sum[k]) <= 1e-8 + 32 * Number.EPSILON * sum[k]);
      }
    }
    return doc as unknown as ConditionalSupply;
  });
}
