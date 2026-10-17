import { describe, expect, it, vi } from "vitest";
import { buildManualReviewRequest, resolveManualReview } from "./resolve-forecast-manual-review";

const binding = {
  generation: 1,
  sourceRevision: 1,
  contentHash: "a".repeat(64),
  revisionHash: "b".repeat(64),
  contextHash: "c".repeat(64),
};
const env = {
  FORECAST_COLLECTOR_URL: "https://collector.example",
  FORECAST_COLLECTOR_ADMIN_TOKEN: "secret-token",
  FORECAST_MANUAL_REVIEW_ID: `mr-${"d".repeat(32)}`,
  FORECAST_MANUAL_REVIEW_DECISION: "manual_event",
  FORECAST_MANUAL_REVIEW_REASON: "confirmed",
  GITHUB_RUN_ID: "12",
};
describe("typed manual review CLI", () => {
  it.each([
    { kind: "suspend", round: 38, cutoff: "2026-06-23T04:59:59+09:00", binding },
    {
      kind: "reopen",
      round: 38,
      from: "2026-07-03T12:00:00+09:00",
      until: "2026-07-08T04:59:00+09:00",
      binding,
    },
    {
      kind: "grant",
      grantGameDate: "2026-06-23",
      kits: [{ law: "box-ii-v1", count: 130 }],
      claimUntil: null,
      binding,
    },
    { kind: "restatement", targetGrantId: "grant:naver-board-11:7833931:2026-06-23:1", binding },
  ])("forwards $kind without legacy fields", async (resolution) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ secret: "secret-token" }));
    const settings = { ...env, FORECAST_MANUAL_TYPED_RESOLUTION: JSON.stringify(resolution) };
    const result = await resolveManualReview(settings, fetcher);
    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({ event: null, resolution });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    const first = buildManualReviewRequest(settings).body.requestId;
    expect(buildManualReviewRequest(settings).body.requestId).toBe(first);
    expect(
      buildManualReviewRequest({
        ...settings,
        FORECAST_MANUAL_TYPED_RESOLUTION: JSON.stringify({
          ...resolution,
          binding: { ...binding, generation: 2 },
        }),
      }).body.requestId,
    ).not.toBe(first);
  });
  it.each([
    "secret-token",
    JSON.stringify({ kind: "suspend", round: 38 }),
    JSON.stringify({
      kind: "grant",
      grantGameDate: "2026-02-30",
      kits: [{ law: "box-ii-v1", count: 1 }],
      claimUntil: null,
      binding,
    }),
  ])("rejects malformed resolutions without echoing input", async (raw) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      resolveManualReview({ ...env, FORECAST_MANUAL_TYPED_RESOLUTION: raw }, fetcher),
    ).rejects.toThrow("Invalid typed manual review resolution.");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects typed ignore and hides server error bodies", async () => {
    expect(() =>
      buildManualReviewRequest({
        ...env,
        FORECAST_MANUAL_REVIEW_DECISION: "ignore",
        FORECAST_MANUAL_TYPED_RESOLUTION: "{}",
      }),
    ).toThrow("requires manual_event");
    await expect(
      resolveManualReview(
        { ...env, FORECAST_MANUAL_REVIEW_DECISION: "ignore" },
        async () => new Response("secret-token", { status: 400 }),
      ),
    ).rejects.toThrow("status 400.");
  });
  it("preserves legacy event requests", () => {
    expect(
      buildManualReviewRequest({
        ...env,
        FORECAST_MANUAL_EVENT_TYPE: "solo",
        FORECAST_MANUAL_STARTS_AT_KST: "2026-07-03T12:00",
        FORECAST_MANUAL_SCHEDULE_STATUS: "confirmed",
      }).body.event,
    ).toEqual({
      eventType: "solo",
      startsAtKst: "2026-07-03T12:00",
      endsAtKst: null,
      scheduleStatus: "confirmed",
    });
  });
});
