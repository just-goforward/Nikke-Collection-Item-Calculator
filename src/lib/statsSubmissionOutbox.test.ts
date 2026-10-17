import { describe, expect, it } from "vitest";
import { StatsDeliveryHealthStore } from "./statsDeliveryHealth";
import {
  createStatsSubmissionOutbox,
  migrateStatsEndpointStorage,
  STATS_OUTBOX_MAX_EVENTS,
  STATS_OUTBOX_TTL_MS,
  type StatsSubmissionOutboxV2,
} from "./statsSubmissionOutbox";
import type { StatsSubmissionEnvelope } from "./statsSubmissionQueue";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function envelope(eventId: string): StatsSubmissionEnvelope {
  return {
    eventId,
    sourceHost: "direct",
    event: { kind: "kit_result" },
  };
}

function createOutbox(storage: MemoryStorage, key: string, now: () => number, legacyKey?: string) {
  return createStatsSubmissionOutbox(storage, key, now, legacyKey) as StatsSubmissionOutboxV2;
}

describe("statistics endpoint migration", () => {
  it("preserves active expiry reporting and bounds merged records", () => {
    const storage = new MemoryStorage();
    const endpoint = "https://nikkecollection.com";
    const prefix = "collection-kit-calculator.stats-outbox.v2:";
    const key = prefix + encodeURIComponent(endpoint);
    const source = createOutbox(
      storage,
      prefix + encodeURIComponent("https://collection-kit-stats.tbvj159.workers.dev"),
      () => 1000,
    );
    for (let index = 0; index < STATS_OUTBOX_MAX_EVENTS; index++) {
      source.put(envelope(`source-${index}`));
    }
    const active = createOutbox(storage, key, () => 0);
    active.put(envelope("expired-active"));
    migrateStatsEndpointStorage(storage, endpoint, STATS_OUTBOX_TTL_MS);
    expect(JSON.parse(storage.getItem(key) ?? "{}").records).toHaveLength(STATS_OUTBOX_MAX_EVENTS);
    const restored = createOutbox(storage, key, () => STATS_OUTBOX_TTL_MS);
    expect(restored.list()[0]?.envelope.eventId).toBe("source-1");
    expect(restored.drainExpired().map((record) => record.envelope.eventId)).toEqual([
      "expired-active",
    ]);
  });

  it.each([
    ["https://collection-kit-stats.tbvj159.workers.dev", "https://nikkecollection.com"],
    ["https://nikkecollection.com", "https://collection-kit-stats.tbvj159.workers.dev"],
    [
      "https://collection-kit-stats-staging.tbvj159.workers.dev",
      "https://staging.nikkecollection.com",
    ],
    [
      "https://staging.nikkecollection.com",
      "https://collection-kit-stats-staging.tbvj159.workers.dev",
    ],
  ])("migrates %s to %s without changing IDs or expiry", (source, target) => {
    const storage = new MemoryStorage();
    for (const version of [1, 2]) {
      const prefix = `collection-kit-calculator.stats-outbox.v${version}:`;
      const record = {
        envelope: envelope("preserved-id"),
        expiresAt: 2000,
        queuedAt: 1000,
        attempts: 2,
        lastFailureClass: "network",
      };
      storage.setItem(
        prefix + encodeURIComponent(source),
        JSON.stringify({
          version,
          records: [record, { ...record, envelope: envelope("expired"), expiresAt: 999 }],
        }),
      );
      migrateStatsEndpointStorage(storage, target, 1000);
      expect(storage.getItem(prefix + encodeURIComponent(source))).toBeNull();
      expect(
        JSON.parse(storage.getItem(prefix + encodeURIComponent(target)) ?? "{}").records,
      ).toEqual([record]);
    }
  });

  it("purges expired orphan records without moving live staging records into production", () => {
    const storage = new MemoryStorage();
    const key =
      "collection-kit-calculator.stats-outbox.v1:" +
      encodeURIComponent("https://staging.nikkecollection.com");
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        records: [
          { envelope: envelope("live-staging"), expiresAt: 2000 },
          { envelope: envelope("expired-staging"), expiresAt: 1000 },
        ],
      }),
    );
    migrateStatsEndpointStorage(storage, "https://nikkecollection.com", 1000);
    expect(JSON.parse(storage.getItem(key) ?? "{}").records).toHaveLength(1);
    expect(storage.values.size).toBe(1);
  });

  it("moves delivery health without changing its buckets or crossing environments", () => {
    const storage = new MemoryStorage();
    const prefix = "collection-kit-calculator.stats-delivery-health.v1:";
    const direct = prefix + encodeURIComponent("https://collection-kit-stats.tbvj159.workers.dev");
    const site = prefix + encodeURIComponent("https://nikkecollection.com");
    const item = {
      events: 2,
      age: "expired",
      outcome: "dropped_nonretryable",
      eventKind: "kit_result",
      appRevision: "unknown",
      attempts: "1",
      lastFailureClass: "unknown",
    };
    storage.setItem(direct, JSON.stringify({ version: 1, items: [item] }));
    migrateStatsEndpointStorage(storage, "https://nikkecollection.com", 1000);
    expect(storage.getItem(direct)).toBeNull();
    expect(JSON.parse(storage.getItem(site) ?? "{}").items).toEqual([item]);
    migrateStatsEndpointStorage(storage, "https://collection-kit-stats.tbvj159.workers.dev", 1000);
    expect(storage.getItem(site)).toBeNull();
    expect(JSON.parse(storage.getItem(direct) ?? "{}").items).toEqual([item]);
    storage.setItem(site, JSON.stringify({ version: 1, items: Array(30).fill(item) }));
    migrateStatsEndpointStorage(storage, "https://nikkecollection.com", 1000);
    expect(JSON.parse(storage.getItem(site) ?? "{}").items).toEqual([{ ...item, events: 20 }]);
  });
});

describe("StatsSubmissionOutbox", () => {
  it("deduplicates event ids and keeps only the newest bounded records", () => {
    const storage = new MemoryStorage();
    const outbox = createOutbox(storage, "stats", () => 1_000);

    for (let index = 0; index <= STATS_OUTBOX_MAX_EVENTS; index += 1) {
      outbox.put(envelope(`event-${index}`));
    }
    outbox.put(envelope("event-10"));

    const ids = outbox.list().map((item) => item.envelope.eventId);
    expect(ids).toHaveLength(STATS_OUTBOX_MAX_EVENTS);
    expect(ids[0]).toBe("event-1");
    expect(ids.at(-1)).toBe("event-10");
    expect(ids.filter((id) => id === "event-10")).toHaveLength(1);
  });

  it("expires old records without extending their ttl during reads", () => {
    let now = 5_000;
    const storage = new MemoryStorage();
    const outbox = createOutbox(storage, "stats", () => now);
    outbox.put(envelope("event-expiring"));

    now += STATS_OUTBOX_TTL_MS - 1;
    expect(outbox.list()).toHaveLength(1);

    now += 1;
    expect(outbox.list()).toEqual([]);
    expect(storage.values.has("stats")).toBe(false);
    const [expired] = outbox.drainExpired();
    expect(expired).toMatchObject({
      envelope: { eventId: "event-expiring" },
      queuedAt: 5_000,
      attempts: 0,
      lastFailureClass: null,
    });
    const delivery = new StatsDeliveryHealthStore(storage, "delivery", "c".repeat(40), () => now);
    delivery.record(expired ?? null, "dropped_nonretryable", 0, null);
    expect(delivery.pending()).toEqual({
      outcome: "dropped_nonretryable",
      eventKind: "kit_result",
      appRevision: "c".repeat(40),
      attempts: "1",
      age: "expired",
      lastFailureClass: "unknown",
      events: 1,
    });
  });

  it("removes committed events and discards malformed storage", () => {
    const storage = new MemoryStorage();
    const outbox = createOutbox(storage, "stats", () => 1_000);
    outbox.put(envelope("event-committed"));
    outbox.remove("event-committed");
    expect(outbox.list()).toEqual([]);

    storage.setItem("stats", JSON.stringify({ version: 1, records: [{ envelope: null }] }));
    expect(outbox.list()).toEqual([]);
  });

  it("restores both current and legacy envelopes", () => {
    const storage = new MemoryStorage();
    const outbox = createOutbox(storage, "stats", () => 1_000);
    const current = envelope("event-current");
    const legacy = {
      ...envelope("event-legacy"),
      clientTime: "2026-08-12T00:00:00.000Z",
    };

    outbox.put(current);
    outbox.put(legacy);

    expect(outbox.list().map((record) => record.envelope)).toEqual([current, legacy]);
  });

  it("migrates the v1 browser key without inventing delivery failures", () => {
    const storage = new MemoryStorage();
    const legacy = envelope("event-v1-migrate");
    storage.setItem(
      "stats-v1",
      JSON.stringify({
        version: 1,
        records: [{ envelope: legacy, expiresAt: 901_000 }],
      }),
    );
    const outbox = createOutbox(storage, "stats-v2", () => 1_000, "stats-v1");

    expect(outbox.list()).toEqual([
      {
        envelope: legacy,
        queuedAt: 1_000,
        attempts: 0,
        lastFailureClass: null,
        expiresAt: 901_000,
      },
    ]);
    expect(storage.values.has("stats-v1")).toBe(false);
  });

  it("does not report an immediate first-attempt success as recovered delivery", () => {
    const storage = new MemoryStorage();
    const outbox = createOutbox(storage, "stats", () => 10_000);
    const delivery = new StatsDeliveryHealthStore(storage, "delivery", "unknown", () => 10_001);
    outbox.put(envelope("event-immediate"));

    delivery.record(outbox.remove("event-immediate"), "retried_success", 1, null);

    expect(delivery.pending()).toBeUndefined();
  });

  it("preserves bucketed retry and drop health until a successful acknowledgement", () => {
    let now = 10_000;
    const storage = new MemoryStorage();
    const outbox = createOutbox(storage, "stats", () => now);
    const delivery = new StatsDeliveryHealthStore(storage, "delivery", "unknown", () => now);
    outbox.put(envelope("event-retry"));
    outbox.markFailure("event-retry", 2, "network");
    now += 6 * 60_000;
    const record = outbox.remove("event-retry");
    delivery.record(record, "retried_success", 1, record?.lastFailureClass ?? null);

    const health = delivery.pending();
    expect(health).toEqual({
      outcome: "retried_success",
      eventKind: "kit_result",
      appRevision: "unknown",
      attempts: "3_5",
      age: "5m_15m",
      lastFailureClass: "network",
      events: 1,
    });
    if (health) delivery.acknowledge(health);
    expect(delivery.pending()).toBeUndefined();
  });
});
