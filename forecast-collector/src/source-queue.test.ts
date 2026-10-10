import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import schemaSql from "../schema.sql?raw";
import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import { runCollection } from "./collector";
import { sha256Hex } from "./crypto";
import {
  finishInvocation,
  invocationCircuitState,
  pollNaverSource,
  processSourceQueue,
  recoverNaverBoundary,
  startInvocation,
} from "./source-queue";
import type { CollectorEnv, NormalizedSourceItem, ScheduleEvent } from "./types";

const testEnv = env as unknown as CollectorEnv;

beforeEach(async () => {
  await reset();
  await executeTestSql(testEnv.FORECAST_DB, schemaSql, applyD1Migrations);
});

describe("lightweight Naver source queue", () => {
  it("queues only shallow metadata and advances the cursor in the same poll", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(feedResponse(["102", "101"], { boardId: 56 }));

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
});

describe("Naver metadata schema boundary", () => {
  it.each(["board", "lounge"] as const)(
    "rejects metadata belonging to another %s without queue or cursor writes",
    async (kind) => {
      const payload = (await feedResponse(["120"]).json()) as {
        content: { feeds: Array<{ feed: { loungeId: string }; board: { boardId: number } }> };
      };
      const row = payload.content.feeds[0];
      if (!row) throw new Error("Missing fixture row");
      if (kind === "board") row.board.boardId = 132;
      else row.feed.loungeId = "other";
      await expect(
        pollNaverSource(
          testEnv.FORECAST_DB,
          48,
          vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
        ),
      ).rejects.toThrow("naver_partial_schema_drift");
      expect(await pollState("naver-board-48")).toBeNull();
      expect(
        await testEnv.FORECAST_DB.prepare("SELECT item_id FROM source_queue").first(),
      ).toBeNull();
    },
  );

  it("fails closed without queue or cursor writes when one feed row has an unknown shape", async () => {
    const payload = (await feedResponse(["120", "119"], { boardId: 56 }).json()) as {
      content: { feeds: unknown[] };
    };
    payload.content.feeds.splice(1, 0, { mystery: { changed: true }, rowKind: "unknown" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));

    await expect(pollNaverSource(testEnv.FORECAST_DB, 56, fetcher)).rejects.toThrow(
      "naver_partial_schema_drift",
    );

    const queueCount = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM source_queue",
    ).first<{ count: number }>();
    const cursorCount = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM source_poll_state",
    ).first<{ count: number }>();
    expect(queueCount?.count).toBe(0);
    expect(cursorCount?.count).toBe(0);
  });
});

describe("Naver scan recovery", () => {
  it.each(["empty", "short", "recognized-only"] as const)(
    "holds the committed boundary and requires proven manual recovery after a %s tail",
    async (tail) => {
      await pollNaverSource(
        testEnv.FORECAST_DB,
        48,
        vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["100"])),
      );
      await testEnv.FORECAST_DB.prepare(
        `UPDATE source_poll_state
         SET scan_head_item_id = '140', scan_head_published_at = committed_published_at,
             next_offset = 2 WHERE source = 'naver-board-48'`,
      ).run();
      let response: Response;
      if (tail === "recognized-only") {
        response = Response.json({ code: 200, content: { feeds: [{ type: "banner" }] } });
      } else {
        response = feedResponse(tail === "empty" ? [] : ["101"]);
      }
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(pollNaverSource(testEnv.FORECAST_DB, 48, fetcher)).rejects.toMatchObject({
        message: "naver_scan_boundary_missing",
        queuedItems: tail === "short" ? 1 : 0,
      });
      expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("offset")).toBe("2");
      expect(await pollState("naver-board-48")).toEqual({
        committed_item_id: "100",
        scan_head_item_id: "140",
        next_offset: 0,
      });
      const reanchor = vi
        .fn<typeof fetch>()
        .mockResolvedValue(feedResponse(["141", "100"], { createdDate: "20260824120000" }));
      await expect(pollNaverSource(testEnv.FORECAST_DB, 48, reanchor)).rejects.toThrow(
        "naver_boundary_held",
      );
      expect(reanchor).not.toHaveBeenCalled();
      await expect(
        recoverNaverBoundary(
          testEnv.FORECAST_DB,
          "staging",
          {
            mode: "recover-boundary",
            environment: "staging",
            source: "naver-board-48",
            expectedCommittedItemId: "100",
          },
          reanchor,
        ),
      ).resolves.toEqual({ recovered: true, source: "naver-board-48", queuedItems: 1 });
      expect(new URL(String(reanchor.mock.calls[0]?.[0])).searchParams.get("offset")).toBe("0");
      expect(await pollState("naver-board-48")).toMatchObject({ committed_item_id: "141" });
      const hold = await testEnv.FORECAST_DB.prepare(
        `SELECT state, context_json FROM forecast_ops_alerts
         WHERE alert_key = 'naver-boundary:staging:48'`,
      ).first<{ state: string; context_json: string }>();
      expect(hold?.state).toBe("resolved");
      expect(JSON.parse(hold?.context_json ?? "{}")).toMatchObject({
        committedItemId: "100",
        scanHeadItemId: "140",
        terminalOffset: 2,
        recoveredHeadItemId: "141",
      });
    },
  );

  it("rejects an empty first page without creating a cursor", async () => {
    await expect(
      pollNaverSource(
        testEnv.FORECAST_DB,
        48,
        vi.fn<typeof fetch>().mockResolvedValue(feedResponse([])),
      ),
    ).rejects.toThrow("naver_empty_feed");
    expect(await pollState("naver-board-48")).toBeNull();
  });

  it.each(["mixed", "recognized-only"] as const)(
    "uses raw row count to continue a full %s page until the saved boundary",
    async (kind) => {
      await pollNaverSource(
        testEnv.FORECAST_DB,
        48,
        vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["100"])),
      );
      const payload = (await feedResponse(kind === "mixed" ? ["110"] : []).json()) as {
        content: { feeds: unknown[] };
      };
      while (payload.content.feeds.length < 10) payload.content.feeds.push({ type: "banner" });
      await expect(
        pollNaverSource(
          testEnv.FORECAST_DB,
          48,
          vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
        ),
      ).resolves.toBe(kind === "mixed" ? 1 : 0);
      expect(await pollState("naver-board-48")).toEqual({
        committed_item_id: "100",
        scan_head_item_id: kind === "mixed" ? "110" : null,
        next_offset: 1,
      });
      await expect(
        pollNaverSource(
          testEnv.FORECAST_DB,
          48,
          vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["109", "100"])),
        ),
      ).resolves.toBe(1);
      expect(await pollState("naver-board-48")).toEqual({
        committed_item_id: kind === "mixed" ? "110" : "109",
        scan_head_item_id: null,
        next_offset: 0,
      });
    },
  );

  it.each(["schema", "network"] as const)(
    "does not treat %s uncertainty as successful tail evidence",
    async (kind) => {
      await pollNaverSource(
        testEnv.FORECAST_DB,
        48,
        vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["100"])),
      );
      await testEnv.FORECAST_DB.prepare(
        `UPDATE source_poll_state
         SET scan_head_item_id = '140', scan_head_published_at = committed_published_at,
             next_offset = 2 WHERE source = 'naver-board-48'`,
      ).run();
      const fetcher = vi.fn<typeof fetch>();
      if (kind === "schema") {
        fetcher.mockResolvedValue(Response.json({ code: 200, content: { feeds: [{}] } }));
      } else {
        fetcher.mockRejectedValue(new Error("offline"));
      }
      await expect(pollNaverSource(testEnv.FORECAST_DB, 48, fetcher)).rejects.toThrow(
        kind === "schema" ? "naver_partial_schema_drift" : "naver_network",
      );
      expect(await pollState("naver-board-48")).toEqual({
        committed_item_id: "100",
        scan_head_item_id: "140",
        next_offset: 2,
      });
    },
  );
});

describe("collector invocation recovery", () => {
  it.each([48, 56] as const)(
    "continues other boards and preserves queued counts when board %s misses its boundary",
    async (failedBoard) => {
      await pollNaverSource(
        testEnv.FORECAST_DB,
        failedBoard,
        vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["100"], { boardId: failedBoard })),
      );
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const board = new URL(String(input)).searchParams.get("boardId");
        return feedResponse(board === String(failedBoard) ? ["110"] : ["210", "209"], {
          boardId: Number(board) as 48 | 56,
        });
      });
      vi.stubGlobal("fetch", fetcher);
      try {
        const nowMs = Date.parse("2026-10-09T05:10:00Z");
        await expect(runCollection(testEnv, { nowMs })).resolves.toEqual({
          outcome: "held",
          polledSources: 2,
          queuedItems: 3,
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
        const invocation = await testEnv.FORECAST_DB.prepare(
          "SELECT status, queued_count, error_code FROM collector_invocations",
        ).first();
        expect(invocation).toEqual({
          status: "failure",
          queued_count: 3,
          error_code: "naver_scan_boundary_missing",
        });
        expect(await pollState(`naver-board-${failedBoard}`)).toMatchObject({
          committed_item_id: "100",
          next_offset: 0,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("holds a permanently missing boundary without starving a healthy board or hiding its outages", async () => {
    await pollNaverSource(
      testEnv.FORECAST_DB,
      48,
      vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["100"])),
    );
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const board = new URL(String(input)).searchParams.get("boardId");
      return feedResponse(board === "48" ? ["110"] : ["210", "209"], {
        boardId: Number(board) as 48 | 56,
      });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const nowMs = Date.parse("2026-10-09T05:10:00Z");
      for (let index = 0; index < 5; index += 1) {
        await expect(
          runCollection(testEnv, { nowMs: nowMs + index * 60_000 }),
        ).resolves.toMatchObject({
          outcome: "held",
          queuedItems: index === 0 ? 3 : 0,
        });
        expect(await invocationCircuitState(testEnv.FORECAST_DB, nowMs + index * 60_000)).toEqual({
          failures: 0,
          open: false,
          nextRetryAt: null,
        });
      }
      expect(
        fetcher.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("boardId")),
      ).toEqual(["48", "56", "56", "56", "56", "56"]);
      const before = await testEnv.FORECAST_DB.prepare(
        "SELECT * FROM forecast_ops_alerts WHERE alert_key = 'naver-boundary:staging:48'",
      ).first();
      expect(before).toMatchObject({ state: "open", occurrence_count: 1 });
      await expect(
        recoverNaverBoundary(
          testEnv.FORECAST_DB,
          "staging",
          {
            mode: "recover-boundary",
            environment: "staging",
            source: "naver-board-48",
            expectedCommittedItemId: "100",
          },
          vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["111"])),
        ),
      ).rejects.toThrow("naver_scan_boundary_missing");
      expect(await pollState("naver-board-48")).toEqual({
        committed_item_id: "100",
        scan_head_item_id: "110",
        next_offset: 0,
      });
      expect(
        await testEnv.FORECAST_DB.prepare(
          "SELECT * FROM forecast_ops_alerts WHERE alert_key = 'naver-boundary:staging:48'",
        ).first(),
      ).toEqual(before);
      fetcher.mockRejectedValue(new Error("offline"));
      await expect(runCollection(testEnv, { nowMs: nowMs + 5 * 60_000 })).resolves.toMatchObject({
        outcome: "failure",
      });
      expect(await invocationCircuitState(testEnv.FORECAST_DB, nowMs + 5 * 60_000)).toMatchObject({
        failures: 1,
      });
      const last = await testEnv.FORECAST_DB.prepare(
        "SELECT error_code, next_retry_at FROM collector_invocations ORDER BY scheduled_at DESC LIMIT 1",
      ).first();
      expect(last).toMatchObject({ error_code: "naver_network" });
      expect(last?.["next_retry_at"]).not.toBeNull();
      for (let index = 0; index < 13; index += 1) {
        const heldTime = Date.parse("2026-10-09T05:18:00Z") + index * 6 * 60_000;
        await expect(
          runCollection({ ...testEnv, POLL_MODE: "alternating" }, { nowMs: heldTime }),
        ).resolves.toMatchObject({ outcome: "held", queuedItems: 0 });
        expect(await invocationCircuitState(testEnv.FORECAST_DB, heldTime)).toEqual({
          failures: 1,
          open: false,
          nextRetryAt: last?.["next_retry_at"],
        });
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Naver boundary recovery", () => {
  it.each(["stale", "network", "schema", "environment", "board", "race", "write"] as const)(
    "fails boundary recovery closed on %s without partial recovery writes",
    async (kind) => {
      await pollNaverSource(
        testEnv.FORECAST_DB,
        48,
        vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["100"])),
      );
      await expect(
        pollNaverSource(
          testEnv.FORECAST_DB,
          48,
          vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["110"])),
        ),
      ).rejects.toThrow("naver_scan_boundary_missing");
      const before = await testEnv.FORECAST_DB.prepare(
        "SELECT * FROM forecast_ops_alerts WHERE alert_key = 'naver-boundary:staging:48'",
      ).first();
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (kind === "network") throw new Error("offline");
        if (kind === "schema") return Response.json({ code: 200, content: { feeds: [{}] } });
        if (kind === "race") {
          await testEnv.FORECAST_DB.prepare(
            "UPDATE source_poll_state SET committed_item_id = '999' WHERE source = 'naver-board-48'",
          ).run();
        }
        return feedResponse(["141", "100"], { createdDate: "20260824120000" });
      });
      if (kind === "write") {
        await testEnv.FORECAST_DB.prepare(
          `CREATE TRIGGER reject_recovery_queue BEFORE INSERT ON source_queue
           WHEN NEW.item_id = '141' BEGIN SELECT RAISE(ABORT, 'queue_write_failed'); END`,
        ).run();
      }
      await expect(
        recoverNaverBoundary(
          testEnv.FORECAST_DB,
          "staging",
          {
            mode: "recover-boundary",
            environment: kind === "environment" ? "production" : "staging",
            source: kind === "board" ? "naver-board-56" : "naver-board-48",
            expectedCommittedItemId: kind === "stale" ? "101" : "100",
          },
          fetcher,
        ),
      ).rejects.toThrow(
        {
          stale: "naver_boundary_marker_conflict",
          network: "naver_network",
          schema: "naver_partial_schema_drift",
          environment: "naver_boundary_environment_mismatch",
          board: "naver_boundary_not_held",
          race: "naver_boundary_recovery_conflict",
          write: "queue_write_failed",
        }[kind],
      );
      expect(await pollState("naver-board-48")).toEqual({
        committed_item_id: kind === "race" ? "999" : "100",
        scan_head_item_id: "110",
        next_offset: 0,
      });
      expect(
        await testEnv.FORECAST_DB.prepare(
          "SELECT * FROM forecast_ops_alerts WHERE alert_key = 'naver-boundary:staging:48'",
        ).first(),
      ).toEqual(before);
      expect(
        await testEnv.FORECAST_DB.prepare(
          "SELECT item_id FROM source_queue WHERE item_id = '141'",
        ).first(),
      ).toBeNull();
      if (kind === "stale" || kind === "environment" || kind === "board") {
        expect(fetcher).not.toHaveBeenCalled();
      }
    },
  );
});

describe("held Naver identity isolation", () => {
  beforeEach(holdOlderScanHead);

  it.each(["deleted", "schema"] as const)(
    "keeps %s identity proof failures out of the circuit while polling the healthy board",
    async (kind) => {
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        if (new URL(String(input)).pathname.endsWith("/100")) {
          return kind === "deleted"
            ? new Response(null, { status: 404 })
            : Response.json({ code: 404, content: null });
        }
        return feedResponse(["210", "209"], { boardId: 56 });
      });
      vi.stubGlobal("fetch", fetcher);
      try {
        const nowMs = Date.parse("2026-10-09T05:10:00Z");
        for (let index = 0; index < 3; index += 1) {
          const scheduled = nowMs + index * 3 * 60_000;
          await expect(runCollection(testEnv, { nowMs: scheduled })).resolves.toMatchObject({
            outcome: "held",
            queuedItems: index === 0 ? 2 : 0,
          });
          expect(await invocationCircuitState(testEnv.FORECAST_DB, scheduled)).toEqual({
            failures: 0,
            open: false,
            nextRetryAt: null,
          });
        }
        expect(
          fetcher.mock.calls.filter(
            ([input]) => new URL(String(input)).searchParams.get("boardId") === "56",
          ),
        ).toHaveLength(3);
        expect(await pollState("naver-board-48")).toMatchObject({ committed_item_id: "100" });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("still records a genuine identity network outage as a failure", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (new URL(String(input)).pathname.endsWith("/100")) throw new Error("offline");
      return feedResponse(["210"], { boardId: 56 });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const nowMs = Date.parse("2026-10-09T05:10:00Z");
      await expect(runCollection(testEnv, { nowMs })).resolves.toMatchObject({
        outcome: "failure",
        queuedItems: 1,
      });
      expect(await invocationCircuitState(testEnv.FORECAST_DB, nowMs)).toMatchObject({
        failures: 1,
        open: false,
      });
      expect(
        await testEnv.FORECAST_DB.prepare("SELECT error_code FROM collector_invocations").first(),
      ).toEqual({ error_code: "naver_network" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("verified Naver board-change recovery", () => {
  beforeEach(holdOlderScanHead);

  it("recovers a verified board change through the previously scanned head and resumes polling", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname.endsWith("/100")
        ? identityResponse()
        : feedResponse(["120", "110"]),
    );
    await expect(pollNaverSource(testEnv.FORECAST_DB, 48, fetcher)).resolves.toBe(1);
    expect(await pollState("naver-board-48")).toEqual({
      committed_item_id: "120",
      scan_head_item_id: null,
      next_offset: 0,
    });
    const hold = await testEnv.FORECAST_DB.prepare(
      "SELECT state, context_json FROM forecast_ops_alerts WHERE alert_key = 'naver-boundary:staging:48'",
    ).first<{ state: string; context_json: string }>();
    expect(hold?.state).toBe("resolved");
    expect(JSON.parse(hold?.context_json ?? "{}")).toMatchObject({
      committedItemId: "100",
      scanHeadItemId: "110",
      recoveredHeadItemId: "120",
      recoveryReason: "verified_board_change",
      movedBoardId: 132,
    });
    await expect(pollNaverSource(testEnv.FORECAST_DB, 48, fetcher)).resolves.toBe(0);
  });

  it.each(["board", "official", "date", "bridge", "lounge", "id"] as const)(
    "keeps the hold and original cursor on invalid %s recovery evidence",
    async (kind) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          identityResponse({
            boardId: kind === "board" ? 48 : 132,
            official: kind !== "official",
            createdDate: kind === "date" ? "20260825120000" : "20260824120000",
            loungeId: kind === "lounge" ? "other" : "nikke",
            itemId: kind === "id" ? 999 : 100,
          }),
        )
        .mockResolvedValueOnce(feedResponse(kind === "bridge" ? ["120", "119"] : ["120", "110"]));
      const expectedErrors = {
        board: "naver_boundary_held",
        official: "naver_scan_boundary_missing",
        date: "naver_scan_boundary_missing",
        bridge: "naver_scan_boundary_missing",
        lounge: "naver_boundary_held",
        id: "naver_boundary_held",
      };
      await expect(pollNaverSource(testEnv.FORECAST_DB, 48, fetcher)).rejects.toThrow(
        expectedErrors[kind],
      );
      expect(await pollState("naver-board-48")).toEqual({
        committed_item_id: "100",
        scan_head_item_id: "110",
        next_offset: 0,
      });
      expect(
        await testEnv.FORECAST_DB.prepare(
          "SELECT state FROM forecast_ops_alerts WHERE alert_key = 'naver-boundary:staging:48'",
        ).first(),
      ).toEqual({ state: "open" });
      expect(
        await testEnv.FORECAST_DB.prepare(
          "SELECT item_id FROM source_queue WHERE item_id = '120'",
        ).first(),
      ).toBeNull();
    },
  );
});

describe("Naver circuit recovery", () => {
  it("keeps the failure streak and cooldown across skips, permits retry, then resets on success", async () => {
    const nowMs = Date.parse("2026-10-09T05:10:00Z");
    const retryAt = new Date(nowMs + 30 * 60_000).toISOString();
    for (let index = 0; index < 3; index += 1) {
      const id = await startInvocation(
        testEnv.FORECAST_DB,
        "test",
        nowMs - (3 - index) * 60_000,
        "both",
      );
      await finishInvocation(testEnv.FORECAST_DB, id, "failure", 0, "naver_empty_feed", retryAt);
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      feedResponse(["200"], {
        boardId: Number(new URL(String(input)).searchParams.get("boardId")) as 48 | 56,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      for (let index = 0; index < 13; index += 1) {
        await expect(runCollection(testEnv, { nowMs: nowMs + index * 60_000 })).resolves.toEqual({
          outcome: "circuit_open",
          polledSources: 0,
          queuedItems: 0,
        });
        expect(await invocationCircuitState(testEnv.FORECAST_DB, nowMs + index * 60_000)).toEqual({
          failures: 3,
          open: true,
          nextRetryAt: retryAt,
        });
      }
      expect(fetcher).not.toHaveBeenCalled();
      expect(await invocationCircuitState(testEnv.FORECAST_DB, Date.parse(retryAt))).toEqual({
        failures: 3,
        open: false,
        nextRetryAt: retryAt,
      });
      await expect(runCollection(testEnv, { nowMs: Date.parse(retryAt) })).resolves.toEqual({
        outcome: "completed",
        polledSources: 2,
        queuedItems: 2,
      });
      expect(await invocationCircuitState(testEnv.FORECAST_DB, Date.parse(retryAt))).toEqual({
        failures: 0,
        open: false,
        nextRetryAt: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("lightweight Naver queue processing", () => {
  it("skips an explicitly recognized banner row without treating it as schema drift", async () => {
    const payload = (await feedResponse(["121"], { boardId: 56 }).json()) as {
      content: { feeds: unknown[] };
    };
    payload.content.feeds.push({ type: "banner", campaignId: "known-non-post" });

    await expect(
      pollNaverSource(
        testEnv.FORECAST_DB,
        56,
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
      ),
    ).resolves.toBe(1);
    const queueCount = await testEnv.FORECAST_DB.prepare(
      "SELECT COUNT(*) AS count FROM source_queue",
    ).first<{ count: number }>();
    expect(queueCount?.count).toBe(1);
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
      next_offset: 1,
    });

    await expect(pollNaverSource(testEnv.FORECAST_DB, 48, fetcher)).resolves.toBe(1);
    const committed = await pollState("naver-board-48");
    expect(committed).toMatchObject({
      committed_item_id: "111",
      scan_head_item_id: null,
      next_offset: 0,
    });
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get("offset")).toBe("1");
  });

  it("keeps retries pending and moves the third failure to manual review", async () => {
    await pollNaverSource(
      testEnv.FORECAST_DB,
      56,
      vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["200"], { boardId: 56 })),
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
          boardId: 56,
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

async function holdOlderScanHead() {
  await pollNaverSource(
    testEnv.FORECAST_DB,
    48,
    vi.fn<typeof fetch>().mockResolvedValue(feedResponse(["100"])),
  );
  await expect(
    pollNaverSource(
      testEnv.FORECAST_DB,
      48,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(feedResponse(["110"], { createdDate: "20260823120000" })),
    ),
  ).rejects.toThrow("naver_scan_boundary_missing");
}

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
  overrides: { title?: string; createdDate?: string; url?: string; boardId?: 48 | 56 } = {},
) {
  return Response.json({
    code: 200,
    content: {
      feeds: itemIds.map((itemId, index) => ({
        feed: {
          feedId: Number(itemId),
          loungeId: "nikke",
          title: overrides.title ?? `공지 ${itemId}`,
          createdDate:
            overrides.createdDate ?? `202608${String(24 - index).padStart(2, "0")}120000`,
          contents: "본문은 경량 poll에서 읽지 않아야 합니다.",
        },
        user: { userRoleCode: "game_manager" },
        board: { boardId: overrides.boardId ?? 48 },
        feedLink: {
          pc: overrides.url ?? `https://game.naver.com/lounge/nikke/board/detail/${itemId}`,
        },
      })),
    },
  });
}

function identityResponse(
  overrides: {
    boardId?: number;
    official?: boolean;
    createdDate?: string;
    loungeId?: string;
    itemId?: number;
  } = {},
) {
  return Response.json({
    code: 200,
    content: {
      feed: {
        feedId: overrides.itemId ?? 100,
        loungeId: overrides.loungeId ?? "nikke",
        createdDate: overrides.createdDate ?? "20260824120000",
      },
      board: { boardId: overrides.boardId ?? 132 },
      user: { userRoleCode: overrides.official === false ? "member" : "game_manager" },
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
