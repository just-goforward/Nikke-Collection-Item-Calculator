import { describe, expect, it } from "vitest";
import { validateKitResultSubmission } from "../cloudflare/src/event-validation-kit";
import { EventSubmissionSchema } from "../cloudflare/src/schemas";
import { REQUIRED_EXP } from "../shared/game";
import { applyCertifiedBatch } from "../src/certifiedUi/calculatorSessionActions";
import { makeCertifiedKitResultEvent } from "../src/certifiedUi/certifiedStats";
import { createCertifiedSession } from "../src/certifiedUi/session";

describe("certified batch statistics", () => {
  it("uses actual consumption when a normal batch stops at a level boundary", () => {
    const batch = {
      before: createCertifiedSession(
        "approved",
        { grade: "SR", level: 2, exp: REQUIRED_EXP.SR - 100 },
        [100, 20, 30],
      ),
      kit: "blue" as const,
      uses: 3,
      at: "2026-09-30T03:00:00Z",
    };
    const event = makeCertifiedKitResultEvent(batch, applyCertifiedBatch(batch, null), null);
    expect(event.recommendedUses).toBe(1);
    expect(event.stockAfter.blue).toBe(90);
    expect(() =>
      validateKitResultSubmission(
        { eventId: "certified-boundary-001", sourceHost: "direct", deliveryHealth: undefined },
        EventSubmissionSchema.parse({
          version: 1,
          eventId: "certified-boundary-001",
          turnstileToken: "test-token-for-schema-validation",
          event,
        }).event as typeof event,
      ),
    ).not.toThrow();
  });

  it.each([null, 1, 2, 3])("projects an accepted batch with success attempt %s", (attempt) => {
    const batch = {
      before: createCertifiedSession("approved", { grade: "SR", level: 2, exp: 0 }, [100, 20, 30]),
      kit: "blue" as const,
      uses: 3,
      at: "2026-09-30T03:00:00Z",
    };
    const next = applyCertifiedBatch(batch, attempt);
    const event = makeCertifiedKitResultEvent(batch, next, attempt);
    expect(Object.keys(event).sort()).toEqual(
      [
        "kind",
        "start",
        "kit",
        "recommendedUses",
        "outcome",
        "successAttempt",
        "stockBefore",
        "stockAfter",
        "resultState",
      ].sort(),
    );
    expect(event.stockAfter.blue).toBe(100 - (attempt ?? 3) * 10);
    expect(event.successAttempt).toBe(attempt);
    expect(() =>
      validateKitResultSubmission(
        { eventId: "certified-test-event-001", sourceHost: "direct", deliveryHealth: undefined },
        EventSubmissionSchema.parse({
          version: 1,
          eventId: "certified-test-event-001",
          turnstileToken: "test-token-for-schema-validation",
          event,
        }).event as typeof event,
      ),
    ).not.toThrow();
  });
});
