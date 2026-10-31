import { describe, expect, it } from "vitest";
import { DISPATCH_EXPECTED_PIECES } from "../../shared/certifiedDispatchExpectations";
import { add, div, mul, q, ZERO } from "../../shared/certifiedRational";
import { assertCertifiedRuntimeSupplySnapshot } from "../../shared/certifiedSupply";
import {
  assertLedgerForecastProfiles,
  projectSupplyReference,
} from "../../shared/supplyForecastProjection";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import type { NormalizedSourceItem, ScheduleEvent } from "./types";

const sourceItem: NormalizedSourceItem = {
  source: "naver-board-56",
  itemId: "8060044",
  url: "https://game.naver.com/lounge/nikke/board/detail/8060044",
  title: "8월 솔로 레이드",
  excerpt: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
  normalizedText: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
  publishedAt: "2026-08-18T03:00:00.000Z",
  contentHash: "a".repeat(64),
  structured: true,
  official: true,
};

const soloEvent: ScheduleEvent = {
  eventId: "naver-board-56:8060044:solo",
  eventType: "solo",
  sourceItem,
  startsAt: "2026-08-20T03:00:00.000Z",
  endsAt: "2026-08-26T19:59:00.000Z",
  scheduleStatus: "confirmed",
  manualReview: false,
  reason: null,
};

describe("forecast candidate model", () => {
  it("projects the exact 1:2:3 dispatch mix plus Tuesday boxes and Wednesday kits", async () => {
    const now = Date.parse("2026-08-28T00:00:00Z");
    const resolved = resolveSoloSchedule([soloEvent], now);
    if (!resolved) throw new Error("Expected a resolved schedule.");
    const result = await buildForecastCandidate(
      resolved,
      [],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      now,
      1,
    );
    const snapshot = assertCertifiedRuntimeSupplySnapshot(result.candidate.certifiedSnapshot);
    const from = Date.parse(snapshot.asOf);
    const projection = projectSupplyReference(snapshot, {
      from,
      until: from + 7 * 86_400_000,
      scheduleStatus: "confirmed",
    });
    if (!projection.available) throw new Error(projection.reason);
    const daily = [0, 1, 2].map((color) =>
      div(
        // V5 removes the fourth cohort; the remaining fixed weights sum to six.
        DISPATCH_EXPECTED_PIECES.slice(0, 3).reduce(
          (total, row, cohort) => add(total, mul(row[color] ?? ZERO, q([1, 2, 3][cohort] ?? 0))),
          ZERO,
        ),
        q(6),
      ),
    );
    expect(projection.expected).toEqual(
      daily.map((value, color) => add(mul(value, q(7)), [q(55, 2), q(12), q(1)][color] ?? ZERO)),
    );
  });

  it("keeps an active Solo Raid after day 3 and supplies later estimated cycles", async () => {
    const resolved = resolveSoloSchedule([soloEvent], Date.parse("2026-08-24T00:00:00Z"));
    if (!resolved) throw new Error("Expected a resolved schedule.");
    expect(resolved.scheduleStatus).toBe("confirmed");
    expect(resolved.event.eventId).toBe(soloEvent.eventId);
    expect(resolved.soloEvents.some((event) => event.scheduleStatus === "estimated")).toBe(true);
    const result = await buildForecastCandidate(
      resolved,
      [],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      Date.parse("2026-08-24T00:00:00Z"),
      1,
    );

    expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.candidate.forecastId).toBe("supply-2026-08-24-v1");
    expect(result.candidate.profiles.at(-1)?.effectiveUntil).not.toBeNull();
    // The fixed-dispatch policy has its own v5 snapshot/rules and payload-6 identity.
    expect(result.candidate.rulesVersion).toBe("schedule-kit-v5");
    expect(result.candidate.payloadVersion).toBe(6);
    const ledger = assertCertifiedRuntimeSupplySnapshot(result.candidate.certifiedSnapshot);
    expect(ledger.version).toBe("certified-daily-v5");
    expect(() =>
      assertLedgerForecastProfiles(result.candidate.forecastId, ledger, result.candidate.profiles),
    ).not.toThrow();
    expect(result.candidate.schedule.soloPeriods).toContainEqual({
      round: 40,
      segment: 1,
      effectiveFrom: soloEvent.startsAt,
      effectiveUntil: soloEvent.endsAt,
      scheduleStatus: "confirmed",
    });
    expect(
      result.candidate.schedule.soloPeriods.some(
        (period) =>
          (period.round ?? 0) > 40 && period.segment === 1 && period.scheduleStatus === "estimated",
      ),
    ).toBe(true);
    expect(result.candidate.warnings).toContain(
      "X is advisory and is evaluated during proposal review.",
    );
    expect(result.candidate.profiles[0]?.expectedGain.blue).toBeGreaterThan(0);
  });

  it("keeps the ending Solo through 04:59 and changes focus at the 05:00 game-day boundary", () => {
    const nextSolo: ScheduleEvent = {
      ...soloEvent,
      eventId: "solo-next",
      startsAt: "2026-09-17T03:00:00.000Z",
      endsAt: "2026-09-23T19:59:00.000Z",
    };

    const beforeReset = resolveSoloSchedule(
      [soloEvent, nextSolo],
      Date.parse("2026-08-27T04:59:59+09:00"),
    );
    const afterReset = resolveSoloSchedule(
      [soloEvent, nextSolo],
      Date.parse("2026-08-27T05:00:00+09:00"),
    );

    expect(beforeReset?.event.eventId).toBe(soloEvent.eventId);
    expect(afterReset?.event.eventId).toBe(nextSolo.eventId);
  });

  it("estimates the next new round from the all-round median", () => {
    const starts = [
      "2026-03-19",
      "2026-04-16",
      "2026-05-14",
      "2026-06-11",
      "2026-07-09",
      "2026-08-06",
    ];
    const events = starts.map((date, index): ScheduleEvent => {
      const start = Date.parse(`${date}T12:00:00+09:00`);
      return {
        ...soloEvent,
        eventId: `solo-${index}`,
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 7 * 86_400_000 - 7 * 60 * 60 * 1000 - 60 * 1000).toISOString(),
      };
    });

    const resolved = resolveSoloSchedule(events, Date.parse("2026-08-20T00:00:00Z"));

    expect(resolved?.scheduleStatus).toBe("estimated");
    expect(resolved?.cadenceDays).toBe(28);
    expect(resolved?.event.startsAt).toBe("2026-09-03T03:00:00.000Z");
    expect(resolved?.evidenceEvents).toHaveLength(6);
  });

  it("uses the forecast game date in candidate identity", async () => {
    const resolved = resolveSoloSchedule([soloEvent], Date.parse("2026-08-19T00:00:00Z"));
    if (!resolved) throw new Error("Expected a resolved schedule.");
    const first = await buildForecastCandidate(
      resolved,
      [],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      Date.parse("2026-08-19T00:00:00Z"),
      1,
    );
    const nextDay = await buildForecastCandidate(
      resolved,
      [],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      Date.parse("2026-08-20T00:00:00Z"),
      1,
    );

    expect(first.candidate.candidateId).not.toBe(nextDay.candidate.candidateId);
  });

  it("keeps same-content identity across revision allocation and changes it for new evidence", async () => {
    const now = Date.parse("2026-08-24T00:00:00Z");
    const resolved = resolveSoloSchedule([soloEvent], now);
    if (!resolved) throw new Error("Expected a resolved schedule.");
    const probe = { status: "x_unavailable" as const, sourceItem: null, reason: "test" };
    const first = await buildForecastCandidate(resolved, [], probe, now, 1);
    const replay = await buildForecastCandidate(resolved, [], probe, now + 1000, 2);
    expect(replay.candidate.candidateId).toBe(first.candidate.candidateId);
    expect(replay.candidate.certifiedSnapshot).toEqual(first.candidate.certifiedSnapshot);
    const changed = await buildForecastCandidate(
      {
        ...resolved,
        evidenceEvents: [
          { ...soloEvent, sourceItem: { ...sourceItem, contentHash: "b".repeat(64) } },
        ],
      },
      [],
      probe,
      now,
      2,
    );
    expect(changed.candidate.candidateId).not.toBe(first.candidate.candidateId);
  });

  it("ignores regular Co-op dates and doubles only confirmed collaboration Tuesdays", async () => {
    const now = Date.parse("2026-08-22T00:00:00Z");
    const resolved = resolveSoloSchedule([soloEvent], now);
    if (!resolved) throw new Error("Expected a resolved schedule.");
    const collaborationCooperation: ScheduleEvent = {
      ...soloEvent,
      eventId: "cooperation-september",
      eventType: "cooperation",
      startsAt: "2026-09-11T03:00:00.000Z",
      endsAt: "2026-09-15T19:59:00.000Z",
      sourceItem: {
        ...sourceItem,
        itemId: "cooperation-september",
        normalizedText: "콜라보 협동 작전 9월 11일 12:00 ~ 9월 16일 4:59",
      },
    };
    const regularCooperation: ScheduleEvent = {
      ...collaborationCooperation,
      eventId: "regular-cooperation-september",
      sourceItem: {
        ...collaborationCooperation.sourceItem,
        itemId: "regular-cooperation-september",
        normalizedText: "협동 작전 9월 11일 12:00 ~ 9월 16일 4:59",
      },
    };
    const estimatedCollaboration: ScheduleEvent = {
      ...collaborationCooperation,
      eventId: "estimated-collaboration-september",
      scheduleStatus: "estimated",
    };
    const base = await buildForecastCandidate(
      resolved,
      [],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      now,
      1,
    );
    const regular = await buildForecastCandidate(
      resolved,
      [regularCooperation],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      now,
      1,
    );
    const scheduled = await buildForecastCandidate(
      resolved,
      [collaborationCooperation],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      now,
      1,
    );
    const unpublished = await buildForecastCandidate(
      resolved,
      [estimatedCollaboration],
      { status: "x_unavailable", sourceItem: null, reason: "test" },
      now,
      1,
    );

    expect(regular.candidate.profiles).toEqual(base.candidate.profiles);
    expect(regular.candidate.candidateId).toBe(base.candidate.candidateId);
    expect(unpublished.candidate.profiles).toEqual(base.candidate.profiles);
    expect(scheduled.candidate.schedule).not.toHaveProperty("cooperationPeriods");
    expect(scheduled.candidate.schedule.collaborationPeriods).toHaveLength(1);
    expect(scheduled.candidate.profiles[0]?.expectedGain.blue).toBeCloseTo(
      (base.candidate.profiles[0]?.expectedGain.blue ?? 0) + 17.5,
      9,
    );
  });

  it("does not feed a previously estimated round back into cadence history", () => {
    const staleEstimate: ScheduleEvent = {
      ...soloEvent,
      eventId: "solo-estimated",
      startsAt: "2026-09-21T03:00:00.000Z",
      endsAt: "2026-09-27T19:59:00.000Z",
      scheduleStatus: "estimated",
      reason: "full_round_history_median",
    };

    const resolved = resolveSoloSchedule(
      [soloEvent, staleEstimate],
      Date.parse("2026-08-28T00:00:00Z"),
    );

    expect(resolved?.scheduleStatus).toBe("estimated");
    expect(resolved?.event.startsAt).toBe("2026-09-17T03:00:00.000Z");
    expect(resolved?.evidenceEvents).toEqual([soloEvent]);
  });

  it("blocks a confirmed new-round cadence outside the validated 21-35 day range", () => {
    const previous: ScheduleEvent = {
      ...soloEvent,
      eventId: "solo-previous",
      startsAt: "2026-07-31T03:00:00.000Z",
      endsAt: "2026-08-06T19:59:00.000Z",
    };

    expect(() =>
      resolveSoloSchedule([previous, soloEvent], Date.parse("2026-08-19T00:00:00Z")),
    ).toThrow("confirmed_solo_cadence_out_of_range");
  });
});
