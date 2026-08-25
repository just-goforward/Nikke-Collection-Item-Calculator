import { describe, expect, it, vi } from "vitest";
import type { SupplyForecastCandidate } from "../shared/supplyForecastCandidate";
import { classifyXAdvisory, fetchJinaPayload, parseJinaPayload } from "./forecast-x-advisory";

const candidate = {
  generatedAt: "2026-08-14T08:00:00.000Z",
  sourceEvidence: [
    {
      source: "naver-board-56",
      publishedAt: "2026-08-14T08:00:00.000Z",
    },
  ],
  schedule: { soloStart: "2026-08-20T03:00:00.000Z" },
} as SupplyForecastCandidate;

describe("X forecast advisory", () => {
  it("matches a relevant status carrying the Naver start date", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "솔로 레이드 시즌 40은 8월 20일 시작됩니다.",
              url: "https://x.com/NIKKE_kr/status/123",
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidate,
      ),
    ).toMatchObject({ status: "matching", reason: "matched_schedule" });
  });

  it("reports a conflict when a relevant post has a different date", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "솔로 레이드 8/21 개최",
              url: "https://x.com/NIKKE_kr/status/124",
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidate,
      ),
    ).toMatchObject({ status: "conflict", reason: "schedule_conflict" });
  });

  it("keeps rate limits as an unavailable advisory", () => {
    expect(classifyXAdvisory({ posts: [], reason: "rate_limited" }, candidate)).toEqual({
      status: "unavailable",
      source: null,
      reason: "rate_limited",
      statusUrl: null,
      excerpt: null,
    });
  });

  it("extracts allowlisted NIKKE status links from a Jina Reader response", async () => {
    const payload = parseJinaPayload(`
      Title: NIKKE
      솔로 레이드 시즌 40은 8월 20일 시작됩니다.
      https://x.com/NIKKE_kr/status/1234567890
      다른 안내
      https://x.com/another/status/999
    `);

    expect(payload.posts).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("8월 20일"),
        url: "https://x.com/NIKKE_kr/status/1234567890",
        publishedAt: null,
      }),
    ]);
    expect(classifyXAdvisory(payload, candidate, "jina")).toMatchObject({
      status: "matching",
      source: "jina",
    });
  });

  it("uses a bounded cached Jina request and classifies abuse blocking as rate limited", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("AbuseAlleviationError: Too many requests", {
        status: 403,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(fetchJinaPayload(fetcher)).resolves.toEqual({
      posts: [],
      reason: "rate_limited",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://r.jina.ai/https://x.com/NIKKE_kr",
      expect.objectContaining({
        headers: { accept: "text/plain", "x-cache-tolerance": "300" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects an oversized Jina response before parsing it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("ignored", {
        status: 200,
        headers: { "content-length": String(128 * 1024 + 1) },
      }),
    );

    await expect(fetchJinaPayload(fetcher)).resolves.toEqual({
      posts: [],
      reason: "navigation_error",
    });
  });

  it("keeps a Jina timeout as an unavailable advisory reason", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));

    await expect(fetchJinaPayload(fetcher)).resolves.toEqual({
      posts: [],
      reason: "timeout",
    });
  });

  it("does not let a cached Jina result create a schedule conflict", () => {
    const payload = parseJinaPayload(
      "솔로 레이드 8/21 개최 https://x.com/NIKKE_kr/status/1234567891",
    );

    expect(classifyXAdvisory(payload, candidate, "jina")).toMatchObject({
      status: "unavailable",
      source: "jina",
    });
  });

  it("does not turn a different event type into a Solo Raid conflict", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "협동 작전은 8/21 개최됩니다.",
              url: "https://x.com/NIKKE_kr/status/125",
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidate,
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("does not treat an old Solo Raid announcement as a current conflict", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "솔로 레이드 7/21 개최",
              url: "https://x.com/NIKKE_kr/status/126",
              publishedAt: "2026-07-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidate,
      ),
    ).toMatchObject({ status: "unavailable" });
  });
});
