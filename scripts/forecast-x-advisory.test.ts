import { describe, expect, it, vi } from "vitest";
import type { SupplyForecastCandidate } from "../shared/supplyForecastCandidate";
import {
  classifyXAdvisory,
  extractProfileStatusIds,
  fetchJinaPayload,
  fetchProfilePayload,
  fetchXApiPayload,
  normalizeNikStatusUrl,
  parseJinaPayload,
  parseSyndicationPayload,
  parseTweetResult,
  parseXApiPayload,
} from "./forecast-x-advisory";

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

const contemporaryStatusId = snowflakeId("2026-08-14T08:10:00.000Z");
const candidateWithCollaboration = {
  ...candidate,
  schedule: {
    ...candidate.schedule,
    collaborationPeriods: [
      {
        effectiveFrom: "2026-08-21T20:00:00.000Z",
        effectiveUntil: "2026-09-01T19:59:00.000Z",
      },
    ],
  },
} as SupplyForecastCandidate;

describe("X forecast advisory", () => {
  it("matches a contemporaneous official status carrying the Naver start date", () => {
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

  it("reports a conflict when a contemporaneous official post has a different date", () => {
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

  it("matches a collaboration post against the confirmed collaboration start", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "콜라보 이벤트는 8/22 시작됩니다.",
              url: "https://x.com/NIKKE_kr/status/125",
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidateWithCollaboration,
        "profile-html",
      ),
    ).toMatchObject({ status: "matching", reason: "matched_schedule" });
  });

  it("reports a conflicting collaboration start from a structured X source", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "콜라보 이벤트는 8/23 시작됩니다.",
              url: "https://x.com/NIKKE_kr/status/126",
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidateWithCollaboration,
        "profile-html",
      ),
    ).toMatchObject({ status: "conflict", reason: "schedule_conflict" });
  });

  it("keeps a verified recent URL for manual review when the date is not parseable", () => {
    expect(
      classifyXAdvisory(
        {
          posts: [
            {
              text: "솔로 레이드의 자세한 일정은 이미지를 확인해 주세요.",
              url: `https://x.com/NIKKE_kr/status/${contemporaryStatusId}`,
              publishedAt: "2026-08-14T08:10:00.000Z",
            },
          ],
          reason: null,
        },
        candidate,
        "x-api",
      ),
    ).toEqual({
      status: "unavailable",
      source: "x-api",
      reason: "schedule_not_verified",
      statusUrl: `https://x.com/NIKKE_kr/status/${contemporaryStatusId}`,
      excerpt: "솔로 레이드의 자세한 일정은 이미지를 확인해 주세요.",
    });
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
});

describe("official X API discovery", () => {
  it("parses official X API results only for the verified NIKKE author", () => {
    const payload = parseXApiPayload({
      data: [
        {
          id: contemporaryStatusId,
          author_id: "1452575629266743307",
          created_at: "2026-08-14T08:10:00.000Z",
          text: "솔로 레이드 시즌 40은 8월 20일 시작됩니다.",
        },
      ],
      includes: {
        users: [{ id: "1452575629266743307", username: "NIKKE_kr" }],
      },
    });

    expect(payload).toEqual({
      posts: [
        {
          text: "솔로 레이드 시즌 40은 8월 20일 시작됩니다.",
          url: `https://x.com/NIKKE_kr/status/${contemporaryStatusId}`,
          publishedAt: "2026-08-14T08:10:00.000Z",
        },
      ],
      reason: null,
    });
    expect(classifyXAdvisory(payload, candidate, "x-api")).toMatchObject({
      status: "matching",
      source: "x-api",
    });
  });

  it("fails closed when an X API result is not tied to the official author", () => {
    expect(
      parseXApiPayload({
        data: [
          {
            id: contemporaryStatusId,
            author_id: "999",
            created_at: "2026-08-14T08:10:00.000Z",
            text: "솔로 레이드 8/20 개최",
          },
        ],
        includes: {
          users: [{ id: "1452575629266743307", username: "NIKKE_kr" }],
        },
      }),
    ).toEqual({ posts: [], reason: "invalid_response" });
  });

  it("uses a bounded official recent-search request without exposing its token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: contemporaryStatusId,
            author_id: "1452575629266743307",
            created_at: "2026-08-14T08:10:00.000Z",
            text: "솔로 레이드 8/20 개최",
          },
        ],
        includes: { users: [{ id: "1452575629266743307", username: "NIKKE_kr" }] },
      }),
    );

    await expect(fetchXApiPayload("secret-token", fetcher)).resolves.toMatchObject({
      posts: [{ url: `https://x.com/NIKKE_kr/status/${contemporaryStatusId}` }],
    });
    const [requestUrl, init] = fetcher.mock.calls[0] ?? [];
    expect(requestUrl).toBeInstanceOf(URL);
    expect(String(requestUrl)).toContain("/2/tweets/search/recent?");
    expect(String(requestUrl)).toContain("from%3ANIKKE_kr");
    expect(init).toMatchObject({
      headers: { accept: "application/json", authorization: "Bearer secret-token" },
      signal: expect.any(AbortSignal),
    });
  });

  it("classifies rejected X API credentials without parsing the response body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));

    await expect(fetchXApiPayload("bad-token", fetcher)).resolves.toEqual({
      posts: [],
      reason: "authentication_failed",
    });
  });
});

describe("public X profile discovery", () => {
  it("extracts current status IDs and verifies each structured tweet result", async () => {
    const newerId = snowflakeId("2026-08-14T09:10:00.000Z");
    const profileHtml = [
      `TimelineTimelineEntry:tweet-${contemporaryStatusId}`,
      `TimelineTimelineEntry:tweet-${newerId}`,
      `TimelineTimelineEntry:tweet-${contemporaryStatusId}`,
    ].join(" ");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://x.com/NIKKE_kr") return new Response(profileHtml);
      const id = new URL(url).searchParams.get("id");
      return Response.json({
        id_str: id,
        text: id === newerId ? "일반 공지" : "솔로 레이드 8/20 개최",
        created_at: id === newerId ? "2026-08-14T09:10:00.000Z" : "2026-08-14T08:10:00.000Z",
        user: { screen_name: "NIKKE_kr" },
      });
    });

    expect(extractProfileStatusIds(profileHtml)).toEqual([newerId, contemporaryStatusId]);
    await expect(fetchProfilePayload(fetcher)).resolves.toEqual({
      posts: [
        {
          text: "일반 공지",
          url: `https://x.com/NIKKE_kr/status/${newerId}`,
          publishedAt: "2026-08-14T09:10:00.000Z",
        },
        {
          text: "솔로 레이드 8/20 개최",
          url: `https://x.com/NIKKE_kr/status/${contemporaryStatusId}`,
          publishedAt: "2026-08-14T08:10:00.000Z",
        },
      ],
      reason: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects a tweet-result response with a different ID or author", () => {
    expect(
      parseTweetResult(
        {
          id_str: contemporaryStatusId,
          text: "솔로 레이드 8/20 개최",
          created_at: "2026-08-14T08:10:00.000Z",
          user: { screen_name: "someone_else" },
        },
        contemporaryStatusId,
      ),
    ).toBeNull();
  });
});

describe("public X fallbacks", () => {
  it("parses the official profile syndication payload and ignores another author", () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          timeline: {
            entries: [
              {
                type: "tweet",
                content: {
                  tweet: {
                    id_str: contemporaryStatusId,
                    full_text: "솔로 레이드 8/20 개최",
                    created_at: "2026-08-14T08:10:00.000Z",
                    user: { screen_name: "NIKKE_kr" },
                  },
                },
              },
              {
                type: "tweet",
                content: {
                  tweet: {
                    id_str: "123",
                    full_text: "솔로 레이드 8/21 개최",
                    created_at: "2026-08-14T08:10:00.000Z",
                    user: { screen_name: "someone_else" },
                  },
                },
              },
            ],
          },
        },
      },
    })}</script>`;

    expect(parseSyndicationPayload(html)).toEqual({
      posts: [
        {
          text: "솔로 레이드 8/20 개최",
          url: `https://x.com/NIKKE_kr/status/${contemporaryStatusId}`,
          publishedAt: "2026-08-14T08:10:00.000Z",
        },
      ],
      reason: null,
    });
  });

  it("extracts exact NIKKE status links and their Snowflake time from Jina", async () => {
    const payload = parseJinaPayload(`
      Title: NIKKE
      솔로 레이드 시즌 40은 8월 20일 시작됩니다.
      https://x.com/NIKKE_kr/status/${contemporaryStatusId}
      다른 안내
      https://x.com/another/status/999
    `);

    expect(payload.posts).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("8월 20일"),
        url: `https://x.com/NIKKE_kr/status/${contemporaryStatusId}`,
        publishedAt: "2026-08-14T08:10:00.000Z",
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
      `솔로 레이드 8/21 개최 https://x.com/NIKKE_kr/status/${contemporaryStatusId}`,
    );

    expect(classifyXAdvisory(payload, candidate, "jina")).toMatchObject({
      status: "unavailable",
      source: "jina",
      reason: "schedule_not_verified",
      statusUrl: `https://x.com/NIKKE_kr/status/${contemporaryStatusId}`,
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
    ).toMatchObject({ status: "unavailable", statusUrl: null });
  });

  it("normalizes only exact NIKKE status URLs", () => {
    expect(normalizeNikStatusUrl("https://twitter.com/nikke_kr/status/123?utm_source=test")).toBe(
      "https://x.com/NIKKE_kr/status/123",
    );
    expect(normalizeNikStatusUrl("https://x.com/someone/status/123")).toBeNull();
    expect(normalizeNikStatusUrl("https://evil.example/NIKKE_kr/status/123")).toBeNull();
  });
});

function snowflakeId(timestamp: string) {
  return ((BigInt(Date.parse(timestamp)) - 1_288_834_974_657n) << 22n).toString();
}
