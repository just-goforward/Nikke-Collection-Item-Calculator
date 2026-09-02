import {
  bucketDeliveryAge,
  bucketDeliveryAttempts,
  DELIVERY_FAILURE_CLASSES,
  type DeliveryFailureClass,
  SOLVER_RECOVERY_APP_REVISION_PATTERN,
  STATS_DELIVERY_EVENT_KINDS,
  type StatsDeliveryHealth,
} from "../../shared/solverRecoveryContract";
import { ignoreExpectedError } from "./errorHandling";
import { STATS_OUTBOX_MAX_EVENTS, type StatsOutboxRecord } from "./statsSubmissionOutbox";

const STORAGE_VERSION = 1;
const KEY_PREFIX = "collection-kit-calculator.stats-delivery-health.v1:";
const FAILURE_CLASSES = new Set<DeliveryFailureClass>(DELIVERY_FAILURE_CLASSES);
const EVENT_KINDS = new Set(STATS_DELIVERY_EVENT_KINDS);
type HealthStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export class StatsDeliveryHealthStore {
  constructor(
    private readonly storage: HealthStorage,
    private readonly key: string,
    private readonly appRevision = "unknown",
    private readonly now: () => number = Date.now,
  ) {}

  pending(): StatsDeliveryHealth | undefined {
    return this.read()[0];
  }

  acknowledge(sent: StatsDeliveryHealth): void {
    const values = this.read();
    const index = values.findIndex((value) => sameHealth(value, sent));
    if (index >= 0) values.splice(index, 1);
    this.write(values);
  }

  record(
    record: StatsOutboxRecord | null,
    outcome: StatsDeliveryHealth["outcome"],
    attempts: number,
    failureClass: DeliveryFailureClass | null,
  ): void {
    if (!record) return;
    const totalAttempts = record.attempts + attempts;
    const recordedFailureClass = failureClass ?? record.lastFailureClass;
    const normalizedFailureClass =
      recordedFailureClass === null
        ? null
        : FAILURE_CLASSES.has(recordedFailureClass)
          ? recordedFailureClass
          : "unknown";
    if (
      outcome === "retried_success" &&
      totalAttempts <= 1 &&
      normalizedFailureClass === null &&
      this.now() - record.queuedAt < 5 * 60_000
    ) {
      return;
    }
    const health = healthFor(
      {
        ...record,
        attempts: totalAttempts,
        lastFailureClass: normalizedFailureClass,
      },
      outcome,
      this.now(),
      this.appRevision,
    );
    const values = this.read();
    const existing = values.find((value) => sameHealth(value, health));
    if (existing) existing.events = Math.min(STATS_OUTBOX_MAX_EVENTS, existing.events + 1);
    else values.push(health);
    this.write(values.slice(-STATS_OUTBOX_MAX_EVENTS));
  }

  private read(): StatsDeliveryHealth[] {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) &&
        parsed["version"] === STORAGE_VERSION &&
        Array.isArray(parsed["items"])
        ? parsed["items"].filter(isDeliveryHealth)
        : [];
    } catch (error) {
      ignoreExpectedError("Statistics delivery health could not be read.", error);
      return [];
    }
  }

  private write(items: StatsDeliveryHealth[]): void {
    try {
      if (items.length === 0) this.storage.removeItem(this.key);
      else this.storage.setItem(this.key, JSON.stringify({ version: STORAGE_VERSION, items }));
    } catch (error) {
      ignoreExpectedError("Statistics delivery health could not be written.", error);
    }
  }
}

export function createBrowserStatsDeliveryHealth(endpoint: string) {
  const revision = typeof __APP_REVISION__ === "string" ? __APP_REVISION__ : "unknown";
  return new StatsDeliveryHealthStore(
    window.localStorage,
    `${KEY_PREFIX}${encodeURIComponent(endpoint)}`,
    normalizedRevision(revision),
  );
}

function healthFor(
  record: StatsOutboxRecord,
  outcome: StatsDeliveryHealth["outcome"],
  now: number,
  fallbackRevision: string,
): StatsDeliveryHealth {
  const eventRevision = record.envelope.event["appRevision"];
  return {
    outcome,
    eventKind: record.envelope.event.kind,
    appRevision:
      typeof eventRevision === "string" && SOLVER_RECOVERY_APP_REVISION_PATTERN.test(eventRevision)
        ? eventRevision
        : fallbackRevision,
    attempts: bucketDeliveryAttempts(record.attempts),
    age: bucketDeliveryAge(Math.max(0, now - record.queuedAt)),
    lastFailureClass: record.lastFailureClass ?? "unknown",
    events: 1,
  };
}

function isDeliveryHealth(value: unknown): value is StatsDeliveryHealth {
  if (!isRecord(value)) return false;
  return (
    (value["outcome"] === "retried_success" || value["outcome"] === "dropped_nonretryable") &&
    EVENT_KINDS.has(value["eventKind"] as never) &&
    typeof value["appRevision"] === "string" &&
    SOLVER_RECOVERY_APP_REVISION_PATTERN.test(value["appRevision"]) &&
    ["1", "2", "3_5", "6_plus"].includes(String(value["attempts"])) &&
    ["lt_30s", "30s_2m", "2m_5m", "5m_15m", "expired"].includes(String(value["age"])) &&
    FAILURE_CLASSES.has(value["lastFailureClass"] as DeliveryFailureClass) &&
    Number.isSafeInteger(value["events"]) &&
    Number(value["events"]) >= 1 &&
    Number(value["events"]) <= STATS_OUTBOX_MAX_EVENTS
  );
}

function sameHealth(left: StatsDeliveryHealth, right: StatsDeliveryHealth) {
  return (
    left.outcome === right.outcome &&
    left.eventKind === right.eventKind &&
    left.appRevision === right.appRevision &&
    left.attempts === right.attempts &&
    left.age === right.age &&
    left.lastFailureClass === right.lastFailureClass
  );
}

function normalizedRevision(value: string) {
  return SOLVER_RECOVERY_APP_REVISION_PATTERN.test(value) ? value : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
