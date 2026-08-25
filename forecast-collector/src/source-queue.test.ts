import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import schemaSql from "../schema.sql?raw";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import { sha256Hex } from "./crypto";
import { pollNaverSource, processSourceQueue } from "./source-queue";
import type { CollectorEnv, NormalizedSourceItem, ScheduleEvent } from "./types";

const testEnv = env as unknown as CollectorEnv;

beforeEach(async () => {
  await reset();
  for (const statement of schemaSql
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    await testEnv.FORECAST_DB.prepare(statement).run();
  }
});

describe("lightweight Naver source queue", () => {
  it("queues only shallow metadata and advances the cursor in the same poll", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["102", "101"]));

    await expect(pollNaverSource(testEnv.FORECAST_DB, 56, fetcher)).resolves.toBe(2);

    const queue = await testEnv.FORECAST_DB.prepare(
      "SELECT item_id, title FROM source_queue ORDER BY item_id",
    ).all<{ item_id: string; title: string }>();
    const state = await testEnv.FORECAST_DB.prepare(
      "SELECT committed_item_id, next_offset FROM source_poll_state WHERE source = 'naver-board-56'",
    ).first<{ committed_item_id: string; next_offset: number }>();
    expect(queue.results).toEqual([
      { item_id: "101", title: "공지 101" },
      { item_id: "102", title: "공지 102" },
    ]);
    expect(state).toEqual({ committed_item_id: "102", next_offset: 0 });
    expect(JSON.stringify(queue.results)).not.toContain("contents");
  });

  it("walks one page per invocation until it finds a missing cursor", async () => {
    const initial = vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["100"]));
    await pollNaverSource(testEnv.FORECAST_DB, 48, initial);
    const pageOne = Array.from({ length: 10 }, (_, index) => String(111 - index));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(feedResponse(pageOne))
      .mockResolvedValueOnce(feedResponse(["101", "100", "99"]));

    await expect(pollNaverSource(testEnv.FORECAST_DB, 48, fetcher)).resolves.toBe(10);
    const scanning = await pollState("naver-board-48");
    expect(scanning).toMatchObject({
      committed_item_id: "100",
      scan_head_item_id: "111",
      next_offset: 8,
    });

    await expect(pollNaverSource(testEnv.FORECAST_DB, 48, fetcher)).resolves.toBe(1);
    const committed = await pollState("naver-board-48");
    expect(committed).toMatchObject({
      committed_item_id: "111",
      scan_head_item_id: null,
      next_offset: 0,
    });
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get("offset")).toBe("8");
  });

  it("keeps retries pending and moves the third failure to manual review", async () => {
    await pollNaverSource(
      testEnv.FORECAST_DB,
      56,
      vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["200"])),
    );
    const request = {
      mode: "queue",
      results: [
        {
          source: "naver-board-56",
          itemId: "200",
          outcome: "retry",
          errorCode: "naver_timeout",
        },
      ],
    } as const;
    await processSourceQueue(testEnv.FORECAST_DB, request);
    await processSourceQueue(testEnv.FORECAST_DB, request);
    await processSourceQueue(testEnv.FORECAST_DB, request);

    const row = await testEnv.FORECAST_DB.prepare(
      "SELECT status, attempts, error_code FROM source_queue WHERE item_id = '200'",
    ).first<{ status: string; attempts: number; error_code: string }>();
    expect(row).toEqual({ status: "manual_review", attempts: 3, error_code: "naver_timeout" });
  });

  it("atomically stores a processed item, event, candidate, and queue result", async () => {
    const item = await sourceItem();
    const event = soloEvent(item);
    await pollNaverSource(
      testEnv.FORECAST_DB,
      56,
      vi.fn<typeof fetch>().mockResolvedValue(
        feedResponse([item.itemId], {
          title: item.title,
          createdDate: "20260818120000",
          url: item.url,
        }),
      ),
    );
    const resolved = resolveSoloSchedule([event], Date.parse("2026-08-24T00:00:00Z"));
    if (!resolved) throw new Error("Expected a resolved schedule.");
    const candidate = await buildForecastCandidate(
      resolved,
      [],
      { status: "x_unavailable", sourceItem: null, reason: "actions_advisory_pending" },
      Date.parse("2026-08-24T00:00:00Z"),
      1,
    );

    await expect(
      processSourceQueue(testEnv.FORECAST_DB, {
        mode: "queue",
        results: [
          {
            source: item.source,
            itemId: item.itemId,
            outcome: "processed",
            item,
            event,
          },
        ],
        candidate: {
          eventId: event.eventId,
          gameDay: "2026-08-24",
          revision: 1,
          envelope: candidate,
        },
      }),
    ).resolves.toEqual({ processed: 1, candidateCreated: true });

    const stored = await testEnv.FORECAST_DB.prepare(
      `SELECT q.status, s.content_hash, e.event_id, c.payload_hash
       FROM source_queue q
       JOIN source_items s ON s.source = q.source AND s.item_id = q.item_id
       JOIN schedule_events e ON e.source = q.source AND e.source_item_id = q.item_id
       JOIN forecast_candidates c ON c.schedule_event_id = e.event_id
       WHERE q.source = ? AND q.item_id = ?`,
    )
      .bind(item.source, item.itemId)
      .first<{
        status: string;
        content_hash: string;
        event_id: string;
        payload_hash: string;
      }>();
    expect(stored).toEqual({
      status: "processed",
      content_hash: item.contentHash,
      event_id: event.eventId,
      payload_hash: candidate.payloadHash,
    });
  });
});

async function pollState(source: string) {
  return testEnv.FORECAST_DB.prepare(
    `SELECT committed_item_id, scan_head_item_id, next_offset
     FROM source_poll_state WHERE source = ?`,
  )
    .bind(source)
    .first();
}

function feedResponse(
  itemIds: readonly string[],
  overrides: { title?: string; createdDate?: string; url?: string } = {},
) {
  return Response.json({
    code: 200,
    content: {
      feeds: itemIds.map((itemId, index) => ({
        feed: {
          feedId: Number(itemId),
          title: overrides.title ?? `공지 ${itemId}`,
          createdDate:
            overrides.createdDate ?? `202608${String(24 - index).padStart(2, "0")}120000`,
          contents: "본문은 경량 poll에서 읽지 않아야 합니다.",
        },
        user: { userRoleCode: "game_manager" },
        feedLink: {
          pc: overrides.url ?? `https://game.naver.com/lounge/nikke/board/detail/${itemId}`,
        },
      })),
    },
  });
}

async function sourceItem(): Promise<NormalizedSourceItem> {
  const normalizedText = "8월 솔로 레이드 솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59";
  return {
    source: "naver-board-56",
    itemId: "8060044",
    url: "https://game.naver.com/lounge/nikke/board/detail/8060044",
    title: "8월 솔로 레이드",
    excerpt: "솔로 레이드 8월 20일 12:00 ~ 8월 27일 4:59",
    normalizedText,
    publishedAt: "2026-08-18T03:00:00.000Z",
    contentHash: await sha256Hex(normalizedText),
    structured: true,
    official: true,
  };
}

function soloEvent(item: NormalizedSourceItem): ScheduleEvent {
  return {
    eventId: `${item.source}:${item.itemId}:solo`,
    eventType: "solo",
    sourceItem: item,
    startsAt: "2026-08-20T03:00:00.000Z",
    endsAt: "2026-08-26T19:59:00.000Z",
    scheduleStatus: "confirmed",
    manualReview: false,
    reason: null,
  };
}
