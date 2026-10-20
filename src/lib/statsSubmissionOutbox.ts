import {
  DELIVERY_FAILURE_CLASSES,
  type DeliveryFailureClass,
  SOLVER_RECOVERY_APP_REVISION_PATTERN,
  STATS_DELIVERY_EVENT_KINDS,
  type StatsDeliveryHealth,
} from "../../shared/solverRecoveryContract";
import { ignoreExpectedError } from "./errorHandling";
import type { StatsEventKind, StatsSubmissionEnvelope } from "./statsSubmissionQueue";

export const STATS_OUTBOX_MAX_EVENTS = 20;
export const STATS_OUTBOX_TTL_MS = 15 * 60 * 1000;
const STATS_OUTBOX_VERSION = 2;
const STATS_OUTBOX_KEY_PREFIX = "collection-kit-calculator.stats-outbox.v2:";
const LEGACY_OUTBOX_KEY_PREFIX = "collection-kit-calculator.stats-outbox.v1:";
const EVENT_KINDS = new Set<StatsEventKind>(STATS_DELIVERY_EVENT_KINDS);

export type StatsOutboxRecord = {
  envelope: StatsSubmissionEnvelope;
  queuedAt: number;
  attempts: number;
  lastFailureClass: DeliveryFailureClass | null;
  expiresAt: number;
};

export type StatsSubmissionOutboxV2 = {
  drainExpired: () => StatsOutboxRecord[];
  list: () => StatsOutboxRecord[];
  markFailure: (eventId: string, attempts: number, failureClass: DeliveryFailureClass) => void;
  put: (envelope: StatsSubmissionEnvelope) => StatsOutboxRecord;
  remove: (eventId: string) => StatsOutboxRecord | null;
};

type StoredOutbox = {
  version: typeof STATS_OUTBOX_VERSION;
  records: StatsOutboxRecord[];
};

type OutboxStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export type BrowserStatsOutbox = {
  drainExpired?: () => StatsOutboxRecord[];
  list: () => Array<StatsOutboxRecord | StatsSubmissionEnvelope>;
  markFailure?: (eventId: string, attempts: number, failureClass: DeliveryFailureClass) => void;
  put: (envelope: StatsSubmissionEnvelope) => StatsOutboxRecord | undefined;
  remove: (eventId: string) => StatsOutboxRecord | null | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isEnvelope(value: unknown): value is StatsSubmissionEnvelope {
  if (!isRecord(value) || !isRecord(value["event"])) return false;
  const event = value["event"];
  const eventId = value["eventId"];
  return (
    typeof eventId === "string" &&
    eventId.length > 0 &&
    eventId.length <= 128 &&
    (value["clientTime"] === undefined || typeof value["clientTime"] === "string") &&
    (value["sourceHost"] === undefined || typeof value["sourceHost"] === "string") &&
    typeof event["kind"] === "string" &&
    EVENT_KINDS.has(event["kind"] as StatsEventKind)
  );
}

function isStoredRecord(value: unknown): value is StatsOutboxRecord {
  return (
    isRecord(value) &&
    isEnvelope(value["envelope"]) &&
    value["envelope"].deliveryHealth === undefined &&
    Number.isFinite(value["queuedAt"]) &&
    Number.isSafeInteger(value["attempts"]) &&
    Number(value["attempts"]) >= 0 &&
    (value["lastFailureClass"] === null ||
      DELIVERY_FAILURE_CLASSES.includes(value["lastFailureClass"] as DeliveryFailureClass)) &&
    Number.isFinite(value["expiresAt"])
  );
}

function statsOutboxStorageKey(endpoint: string, prefix: string) {
  return `${prefix}${encodeURIComponent(endpoint)}`;
}

const STATS_ENDPOINT_PAIRS = [
  ["https://collection-kit-stats.tbvj159.workers.dev", "https://nikkecollection.com"],
  [
    "https://collection-kit-stats-staging.tbvj159.workers.dev",
    "https://staging.nikkecollection.com",
  ],
] as const;
const DELIVERY_HEALTH_KEY_PREFIX = "collection-kit-calculator.stats-delivery-health.v1:";

function readMigrationValue(storage: OutboxStorage, key: string): unknown {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    ignoreExpectedError("Malformed statistics storage was discarded.", error);
    storage.removeItem(key);
    return null;
  }
}

/** Only migrate known sibling endpoints; storage is still scoped to the browser origin. */
export function migrateStatsEndpointStorage(
  storage: OutboxStorage,
  endpoint: string,
  now = Date.now(),
) {
  const pair = STATS_ENDPOINT_PAIRS.find((values) => values.some((value) => value === endpoint));
  for (const endpoints of STATS_ENDPOINT_PAIRS) {
    for (const prefix of [LEGACY_OUTBOX_KEY_PREFIX, STATS_OUTBOX_KEY_PREFIX]) {
      const version = prefix === LEGACY_OUTBOX_KEY_PREFIX ? 1 : 2;
      const recordsByEndpoint = endpoints.map((value) => {
        const key = statsOutboxStorageKey(value, prefix);
        const parsed = readMigrationValue(storage, key);
        const records =
          isRecord(parsed) && parsed["version"] === version && Array.isArray(parsed["records"])
            ? parsed["records"].filter(
                (record): record is Record<string, unknown> =>
                  isRecord(record) &&
                  isEnvelope(record["envelope"]) &&
                  Number.isFinite(record["expiresAt"]) &&
                  (value === endpoint || Number(record["expiresAt"]) > now) &&
                  (version === 1 || isStoredRecord(record)),
              )
            : [];
        if (records.length) storage.setItem(key, JSON.stringify({ version, records }));
        else storage.removeItem(key);
        return records;
      });
      if (pair !== endpoints) continue;
      const target = endpoints[0] === endpoint ? 0 : 1;
      const source = target === 0 ? 1 : 0;
      const merged = new Map<string, Record<string, unknown>>();
      for (const record of [
        ...(recordsByEndpoint[source] ?? []),
        ...(recordsByEndpoint[target] ?? []),
      ]) {
        merged.delete((record["envelope"] as StatsSubmissionEnvelope).eventId);
        merged.set((record["envelope"] as StatsSubmissionEnvelope).eventId, record);
      }
      const records = [...merged.values()];
      const isLive = (record: Record<string, unknown>) => Number(record["expiresAt"]) > now;
      // Unexpired events keep the newest-wins cap; expired ones only fill whatever is left.
      const bounded = [
        ...records.filter(isLive).slice(-STATS_OUTBOX_MAX_EVENTS),
        ...records.filter((record) => !isLive(record)),
      ].slice(0, STATS_OUTBOX_MAX_EVENTS);
      const targetKey = statsOutboxStorageKey(endpoint, prefix);
      if (bounded.length) storage.setItem(targetKey, JSON.stringify({ version, records: bounded }));
      storage.removeItem(statsOutboxStorageKey(endpoints[source], prefix));
    }
  }
  if (!pair) return;
  const sibling = pair.find((value) => value !== endpoint);
  if (!sibling) return;
  const targetKey = statsOutboxStorageKey(endpoint, DELIVERY_HEALTH_KEY_PREFIX);
  const sourceKey = statsOutboxStorageKey(sibling, DELIVERY_HEALTH_KEY_PREFIX);
  const readItems = (key: string): unknown[] => {
    const parsed = readMigrationValue(storage, key);
    return isRecord(parsed) && parsed["version"] === 1 && Array.isArray(parsed["items"])
      ? parsed["items"]
      : [];
  };
  const items = mergeDeliveryHealth([...readItems(sourceKey), ...readItems(targetKey)]);
  if (items.length) {
    storage.setItem(targetKey, JSON.stringify({ version: 1, items }));
  } else storage.removeItem(targetKey);
  storage.removeItem(sourceKey);
}

function mergeDeliveryHealth(values: unknown[]): StatsDeliveryHealth[] {
  const items: StatsDeliveryHealth[] = [];
  for (const health of values.filter(isDeliveryHealth)) {
    const existing = items.find((value) => sameHealth(value, health));
    if (existing) {
      existing.events = Math.min(STATS_OUTBOX_MAX_EVENTS, existing.events + health.events);
    } else items.push({ ...health });
  }
  return items.slice(-STATS_OUTBOX_MAX_EVENTS);
}

export function isDeliveryHealth(value: unknown): value is StatsDeliveryHealth {
  if (!isRecord(value)) return false;
  return (
    (value["outcome"] === "retried_success" || value["outcome"] === "dropped_nonretryable") &&
    EVENT_KINDS.has(value["eventKind"] as never) &&
    typeof value["appRevision"] === "string" &&
    SOLVER_RECOVERY_APP_REVISION_PATTERN.test(value["appRevision"]) &&
    ["1", "2", "3_5", "6_plus"].includes(String(value["attempts"])) &&
    ["lt_30s", "30s_2m", "2m_5m", "5m_15m", "expired"].includes(String(value["age"])) &&
    DELIVERY_FAILURE_CLASSES.includes(value["lastFailureClass"] as DeliveryFailureClass) &&
    Number.isSafeInteger(value["events"]) &&
    Number(value["events"]) >= 1 &&
    Number(value["events"]) <= STATS_OUTBOX_MAX_EVENTS
  );
}

export function sameHealth(left: StatsDeliveryHealth, right: StatsDeliveryHealth) {
  return (
    left.outcome === right.outcome &&
    left.eventKind === right.eventKind &&
    left.appRevision === right.appRevision &&
    left.attempts === right.attempts &&
    left.age === right.age &&
    left.lastFailureClass === right.lastFailureClass
  );
}

class LegacyStatsSubmissionOutbox implements BrowserStatsOutbox {
  constructor(
    private readonly storage: OutboxStorage,
    private readonly storageKey: string,
    private readonly now: () => number = Date.now,
  ) {}

  list(): StatsSubmissionEnvelope[] {
    const records = this.read().filter((record) => record.expiresAt > this.now());
    this.write(records);
    return records.map((record) => record.envelope);
  }

  put(envelope: StatsSubmissionEnvelope): undefined {
    const records = this.read().filter(
      (record) => record.expiresAt > this.now() && record.envelope.eventId !== envelope.eventId,
    );
    records.push({ envelope, expiresAt: this.now() + STATS_OUTBOX_TTL_MS });
    this.write(records.slice(-STATS_OUTBOX_MAX_EVENTS));
    return undefined;
  }

  remove(eventId: string): undefined {
    this.write(this.read().filter((record) => record.envelope.eventId !== eventId));
    return undefined;
  }

  private read(): Array<{ envelope: StatsSubmissionEnvelope; expiresAt: number }> {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["records"])) {
        this.storage.removeItem(this.storageKey);
        return [];
      }
      return parsed["records"].filter(
        (value): value is { envelope: StatsSubmissionEnvelope; expiresAt: number } =>
          isRecord(value) && isEnvelope(value["envelope"]) && Number.isFinite(value["expiresAt"]),
      );
    } catch (error) {
      ignoreExpectedError("Statistics outbox could not be read.", error);
      return [];
    }
  }

  private write(records: Array<{ envelope: StatsSubmissionEnvelope; expiresAt: number }>): void {
    try {
      if (records.length === 0) this.storage.removeItem(this.storageKey);
      else this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, records }));
    } catch (error) {
      ignoreExpectedError(
        "Statistics outbox could not be written; keep the in-memory submission path.",
        error,
      );
    }
  }
}

class StatsSubmissionOutbox implements StatsSubmissionOutboxV2 {
  private expiredRecords: StatsOutboxRecord[] = [];

  constructor(
    private readonly storage: OutboxStorage,
    private readonly storageKey: string,
    private readonly now: () => number = Date.now,
    private readonly legacyStorageKey?: string,
  ) {}

  list(): StatsOutboxRecord[] {
    const state = this.read();
    state.records = state.records.filter((record) => this.keepActive(record));
    this.write(state);
    return state.records;
  }

  drainExpired(): StatsOutboxRecord[] {
    return this.expiredRecords.splice(0);
  }

  put(envelope: StatsSubmissionEnvelope): StatsOutboxRecord {
    const state = this.read();
    state.records = state.records.filter(
      (record) => this.keepActive(record) && record.envelope.eventId !== envelope.eventId,
    );
    const now = this.now();
    const { deliveryHealth: _ignoredDeliveryHealth, ...persistedEnvelope } = envelope;
    const record: StatsOutboxRecord = {
      envelope: persistedEnvelope,
      queuedAt: now,
      attempts: 0,
      lastFailureClass: null,
      expiresAt: now + STATS_OUTBOX_TTL_MS,
    };
    state.records.push(record);
    state.records = state.records.slice(-STATS_OUTBOX_MAX_EVENTS);
    this.write(state);
    return record;
  }

  markFailure(eventId: string, attempts: number, failureClass: DeliveryFailureClass): void {
    const state = this.read();
    const record = state.records.find((item) => item.envelope.eventId === eventId);
    if (!record) return;
    record.attempts += Math.max(1, Math.trunc(attempts));
    record.lastFailureClass = failureClass;
    this.write(state);
  }

  remove(eventId: string): StatsOutboxRecord | null {
    const state = this.read();
    const record = state.records.find((item) => item.envelope.eventId === eventId) ?? null;
    state.records = state.records.filter((item) => item.envelope.eventId !== eventId);
    this.write(state);
    return record;
  }

  private keepActive(record: StatsOutboxRecord) {
    if (record.expiresAt > this.now()) return true;
    this.expiredRecords.push(record);
    this.expiredRecords = this.expiredRecords.slice(-STATS_OUTBOX_MAX_EVENTS);
    return false;
  }

  private read(): StoredOutbox {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (raw) return parseCurrent(raw);
      return this.readLegacy();
    } catch (error) {
      ignoreExpectedError("Statistics outbox could not be read.", error);
      return emptyState();
    }
  }

  private readLegacy(): StoredOutbox {
    if (!this.legacyStorageKey) return emptyState();
    const raw = this.storage.getItem(this.legacyStorageKey);
    if (!raw) return emptyState();
    const parsed: unknown = JSON.parse(raw);
    this.storage.removeItem(this.legacyStorageKey);
    if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["records"])) {
      return emptyState();
    }
    const records = parsed["records"].flatMap((value): StatsOutboxRecord[] => {
      if (
        !isRecord(value) ||
        !isEnvelope(value["envelope"]) ||
        !Number.isFinite(value["expiresAt"])
      ) {
        return [];
      }
      const expiresAt = Number(value["expiresAt"]);
      return [
        {
          envelope: value["envelope"],
          queuedAt: expiresAt - STATS_OUTBOX_TTL_MS,
          attempts: 0,
          lastFailureClass: null,
          expiresAt,
        },
      ];
    });
    const state: StoredOutbox = { version: STATS_OUTBOX_VERSION, records };
    this.write(state);
    return state;
  }

  private write(state: StoredOutbox): void {
    try {
      if (state.records.length === 0) {
        this.storage.removeItem(this.storageKey);
        return;
      }
      this.storage.setItem(this.storageKey, JSON.stringify(state));
    } catch (error) {
      ignoreExpectedError(
        "Statistics outbox could not be written; keep the in-memory submission path.",
        error,
      );
    }
  }
}

function parseCurrent(raw: string): StoredOutbox {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed["version"] !== STATS_OUTBOX_VERSION) return emptyState();
  return {
    version: STATS_OUTBOX_VERSION,
    records: Array.isArray(parsed["records"]) ? parsed["records"].filter(isStoredRecord) : [],
  };
}

function emptyState(): StoredOutbox {
  return { version: STATS_OUTBOX_VERSION, records: [] };
}

export function createBrowserStatsOutbox(endpoint: string): BrowserStatsOutbox | null {
  try {
    const storage = window.localStorage;
    try {
      migrateStatsEndpointStorage(storage, endpoint);
    } catch (error) {
      // A failed merge must not disable submissions for the whole page session.
      ignoreExpectedError("Statistics endpoint migration could not complete.", error);
    }
    const legacyStorageKey = statsOutboxStorageKey(endpoint, LEGACY_OUTBOX_KEY_PREFIX);
    if (!__STATS_DELIVERY_HEALTH_EMIT_ENABLED__) {
      return new LegacyStatsSubmissionOutbox(storage, legacyStorageKey);
    }
    return createStatsSubmissionOutbox(
      storage,
      statsOutboxStorageKey(endpoint, STATS_OUTBOX_KEY_PREFIX),
      Date.now,
      legacyStorageKey,
    );
  } catch (error) {
    ignoreExpectedError("Browser storage is unavailable for the statistics outbox.", error);
    return null;
  }
}

export function createStatsSubmissionOutbox(
  storage: OutboxStorage,
  storageKey: string,
  now: () => number = Date.now,
  legacyStorageKey?: string,
): BrowserStatsOutbox {
  if (!__STATS_DELIVERY_HEALTH_EMIT_ENABLED__) {
    return new LegacyStatsSubmissionOutbox(storage, legacyStorageKey ?? storageKey, now);
  }
  return new StatsSubmissionOutbox(storage, storageKey, now, legacyStorageKey);
}
