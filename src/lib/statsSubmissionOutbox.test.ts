import { describe, expect, it } from "vitest";
import {
  STATS_OUTBOX_MAX_EVENTS,
  STATS_OUTBOX_TTL_MS,
  StatsSubmissionOutbox,
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
    clientTime: "2026-08-12T00:00:00.000Z",
    sourceHost: "direct",
    event: { kind: "kit_result" },
  };
}

describe("StatsSubmissionOutbox", () => {
  it("deduplicates event ids and keeps only the newest bounded records", () => {
    const storage = new MemoryStorage();
    const outbox = new StatsSubmissionOutbox(storage, "stats", () => 1_000);

    for (let index = 0; index <= STATS_OUTBOX_MAX_EVENTS; index += 1) {
      outbox.put(envelope(`event-${index}`));
    }
    outbox.put(envelope("event-10"));

    const ids = outbox.list().map((item) => item.eventId);
    expect(ids).toHaveLength(STATS_OUTBOX_MAX_EVENTS);
    expect(ids[0]).toBe("event-1");
    expect(ids.at(-1)).toBe("event-10");
    expect(ids.filter((id) => id === "event-10")).toHaveLength(1);
  });

  it("expires old records without extending their ttl during reads", () => {
    let now = 5_000;
    const storage = new MemoryStorage();
    const outbox = new StatsSubmissionOutbox(storage, "stats", () => now);
    outbox.put(envelope("event-expiring"));

    now += STATS_OUTBOX_TTL_MS - 1;
    expect(outbox.list()).toHaveLength(1);

    now += 1;
    expect(outbox.list()).toEqual([]);
    expect(storage.values.has("stats")).toBe(false);
  });

  it("removes committed events and discards malformed storage", () => {
    const storage = new MemoryStorage();
    const outbox = new StatsSubmissionOutbox(storage, "stats", () => 1_000);
    outbox.put(envelope("event-committed"));
    outbox.remove("event-committed");
    expect(outbox.list()).toEqual([]);

    storage.setItem("stats", JSON.stringify({ version: 1, records: [{ envelope: null }] }));
    expect(outbox.list()).toEqual([]);
  });
});
