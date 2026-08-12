import { ignoreExpectedError } from "./errorHandling";
import type { StatsEventKind, StatsSubmissionEnvelope } from "./statsSubmissionQueue";

export const STATS_OUTBOX_MAX_EVENTS = 20;
export const STATS_OUTBOX_TTL_MS = 15 * 60 * 1000;
const STATS_OUTBOX_VERSION = 1;
const STATS_OUTBOX_KEY_PREFIX = "collection-kit-calculator.stats-outbox.v1:";
const EVENT_KINDS = new Set<StatsEventKind>([
  "kit_result",
  "runtime_invariant",
  "solver_diagnostic",
  "solver_recovery",
]);

type StoredOutboxRecord = {
  envelope: StatsSubmissionEnvelope;
  expiresAt: number;
};

type StoredOutbox = {
  version: typeof STATS_OUTBOX_VERSION;
  records: StoredOutboxRecord[];
};

type OutboxStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

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
    typeof value["clientTime"] === "string" &&
    typeof value["sourceHost"] === "string" &&
    typeof event["kind"] === "string" &&
    EVENT_KINDS.has(event["kind"] as StatsEventKind)
  );
}

function isStoredRecord(value: unknown): value is StoredOutboxRecord {
  return isRecord(value) && Number.isFinite(value["expiresAt"]) && isEnvelope(value["envelope"]);
}

function statsOutboxStorageKey(endpoint: string) {
  return `${STATS_OUTBOX_KEY_PREFIX}${encodeURIComponent(endpoint)}`;
}

export class StatsSubmissionOutbox {
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

  put(envelope: StatsSubmissionEnvelope): void {
    const records = this.read().filter(
      (record) => record.expiresAt > this.now() && record.envelope.eventId !== envelope.eventId,
    );
    records.push({ envelope, expiresAt: this.now() + STATS_OUTBOX_TTL_MS });
    this.write(records.slice(-STATS_OUTBOX_MAX_EVENTS));
  }

  remove(eventId: string): void {
    this.write(this.read().filter((record) => record.envelope.eventId !== eventId));
  }

  private read(): StoredOutboxRecord[] {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (
        !isRecord(parsed) ||
        parsed["version"] !== STATS_OUTBOX_VERSION ||
        !Array.isArray(parsed["records"])
      ) {
        this.storage.removeItem(this.storageKey);
        return [];
      }
      return parsed["records"].filter(isStoredRecord);
    } catch (error) {
      ignoreExpectedError("Statistics outbox could not be read.", error);
      return [];
    }
  }

  private write(records: StoredOutboxRecord[]): void {
    try {
      if (records.length === 0) {
        this.storage.removeItem(this.storageKey);
        return;
      }
      const payload: StoredOutbox = { version: STATS_OUTBOX_VERSION, records };
      this.storage.setItem(this.storageKey, JSON.stringify(payload));
    } catch (error) {
      ignoreExpectedError(
        "Statistics outbox could not be written; keep the in-memory submission path.",
        error,
      );
    }
  }
}

export function createBrowserStatsOutbox(endpoint: string): StatsSubmissionOutbox | null {
  try {
    return new StatsSubmissionOutbox(window.localStorage, statsOutboxStorageKey(endpoint));
  } catch (error) {
    ignoreExpectedError("Browser storage is unavailable for the statistics outbox.", error);
    return null;
  }
}
