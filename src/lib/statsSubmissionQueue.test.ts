import { describe, expect, it } from "vitest";

import {
  type StatsSubmissionEnvelope,
  StatsSubmissionError,
  StatsSubmissionQueue,
} from "./statsSubmissionQueue";

function envelope(
  eventId: string,
  kind: "kit_result" | "solver_diagnostic",
): StatsSubmissionEnvelope {
  return {
    eventId,
    clientTime: "2026-05-26T00:00:00.000Z",
    sourceHost: "direct",
    event: { kind },
  };
}

describe("StatsSubmissionQueue", () => {
  it("submits queued events serially in FIFO order", async () => {
    const started: string[] = [];
    const completed: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const queue = new StatsSubmissionQueue(async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.push(item.eventId);
      await Promise.resolve();
      completed.push(item.eventId);
      active -= 1;
    });

    await Promise.all([
      queue.enqueue(envelope("result-event-0001", "kit_result")),
      queue.enqueue(envelope("diagnostic-event-01", "solver_diagnostic")),
    ]);

    expect(started).toEqual(["result-event-0001", "diagnostic-event-01"]);
    expect(completed).toEqual(["result-event-0001", "diagnostic-event-01"]);
    expect(maximumActive).toBe(1);
  });

  it("retries a retryable failure once with the same envelope", async () => {
    const submitted: StatsSubmissionEnvelope[] = [];
    const queue = new StatsSubmissionQueue(async (item) => {
      submitted.push(item);
      if (submitted.length === 1) throw new StatsSubmissionError("temporary", true);
    });
    const item = envelope("retry-event-id-0001", "kit_result");

    await expect(queue.enqueue(item)).resolves.toBeUndefined();

    expect(submitted).toHaveLength(2);
    expect(submitted[0]).toBe(item);
    expect(submitted[1]).toBe(item);
    expect(submitted[1].eventId).toBe("retry-event-id-0001");
  });

  it("does not retry non-retryable failures or a second failure", async () => {
    let nonRetryableAttempts = 0;
    const nonRetryable = new StatsSubmissionQueue(async () => {
      nonRetryableAttempts += 1;
      throw new StatsSubmissionError("invalid", false);
    });

    await expect(
      nonRetryable.enqueue(envelope("invalid-event-id01", "kit_result")),
    ).rejects.toThrow("invalid");
    expect(nonRetryableAttempts).toBe(1);

    let retryableAttempts = 0;
    const retryable = new StatsSubmissionQueue(async () => {
      retryableAttempts += 1;
      throw new StatsSubmissionError("temporary", true);
    });

    await expect(
      retryable.enqueue(envelope("failed-event-id01", "solver_diagnostic")),
    ).rejects.toThrow("temporary");
    expect(retryableAttempts).toBe(2);
  });

  it("continues processing later events after an earlier event rejects", async () => {
    const completed: string[] = [];
    const queue = new StatsSubmissionQueue(async (item) => {
      if (item.eventId === "failed-event-id01") {
        throw new StatsSubmissionError("invalid", false);
      }
      completed.push(item.eventId);
    });

    await expect(queue.enqueue(envelope("failed-event-id01", "kit_result"))).rejects.toThrow(
      "invalid",
    );
    await expect(
      queue.enqueue(envelope("next-event-id0001", "solver_diagnostic")),
    ).resolves.toBeUndefined();

    expect(completed).toEqual(["next-event-id0001"]);
  });
});
