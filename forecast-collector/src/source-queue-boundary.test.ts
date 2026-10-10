import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import schemaSql from "../schema.sql?raw";
import { pollNaverSource, recoverNaverBoundary } from "./source-queue";

const db = env["FORECAST_DB"] as D1Database;
const source = "naver-board-56";
const marker = "8143799";
const request = {
  mode: "recover-boundary",
  environment: "staging",
  source,
  expectedCommittedItemId: marker,
};
const holdKey = "naver-boundary:staging:56";

beforeEach(async () => {
  await reset();
  await executeTestSql(db, schemaSql, applyD1Migrations);
});

function row(id: string, date: string) {
  return {
    feed: { feedId: Number(id), loungeId: "nikke", title: `Official ${id}`, createdDate: date },
    user: { userRoleCode: "game_manager" },
    board: { boardId: 56 },
    feedLink: { pc: `https://game.naver.com/lounge/nikke/board/detail/${id}` },
  };
}
type Row = ReturnType<typeof row>;
function response(rows: readonly unknown[]) {
  return Response.json({ code: 200, content: { feeds: rows } });
}
function pages() {
  return [
    Array.from({ length: 10 }, (_, i) => row(String(9000 + i), "20260925120049")),
    Array.from({ length: 10 }, (_, i) => row(String(8000 + i), "20260912120000")),
    [
      row("7000", "20260908120000"),
      row(marker, "20260903180521"),
      ...Array.from({ length: 8 }, (_, i) => row(String(6000 + i), "20260901120000")),
    ],
  ];
}
function pageFetcher(data: readonly Row[][], offsets: number[] = []) {
  return vi.fn<typeof fetch>(async (input) => {
    const offset = Number(new URL(String(input)).searchParams.get("offset"));
    offsets.push(offset);
    return response(data[offset] ?? []);
  });
}
async function seedMarker() {
  await pollNaverSource(db, 56, async () => response([row(marker, "20260903180521")]));
}
async function seedHold() {
  await seedMarker();
  await expect(
    pollNaverSource(db, 56, async () => response([row("8239880", "20260925120049")])),
  ).rejects.toThrow("naver_scan_boundary_missing");
}
async function snapshot() {
  return {
    poll: await db.prepare("SELECT * FROM source_poll_state WHERE source=?").bind(source).first(),
    hold: await db
      .prepare("SELECT * FROM forecast_ops_alerts WHERE alert_key=?")
      .bind(holdKey)
      .first(),
    queue: (await db.prepare("SELECT * FROM source_queue ORDER BY source,item_id").all()).results,
    items: (await db.prepare("SELECT * FROM source_items").all()).results,
    events: (await db.prepare("SELECT * FROM schedule_events").all()).results,
  };
}
async function acceptedEvidence() {
  await db
    .prepare(`INSERT INTO source_queue(source,item_id,url,title,published_at,official,status,attempts,
    error_code,first_seen_at,updated_at) VALUES(?,'9004','https://game.naver.com/lounge/nikke/board/detail/9004',
    'accepted','2026-09-25T03:00:49.000Z',1,'processed',2,'retained','before','before')`)
    .bind(source)
    .run();
  await db
    .prepare(`INSERT INTO source_items(source,item_id,url,title,excerpt,published_at,content_hash,
    structured,official,first_seen_at,last_seen_at) VALUES(?,'9004','https://game.naver.com/lounge/nikke/board/detail/9004',
    'accepted','retained','2026-09-25T03:00:49.000Z',?,1,1,'before','before')`)
    .bind(source, "a".repeat(64))
    .run();
  await db
    .prepare(`INSERT INTO schedule_events(event_id,event_type,source,source_item_id,
    schedule_status,manual_review,reason,observed_at)
    VALUES('accepted','solo',?,'9004','confirmed',0,'retained','before')`)
    .bind(source)
    .run();
}

describe("page-number collection", () => {
  it("walks 0,1,2 to the exact page-two marker without skipping intervening items", async () => {
    await seedMarker();
    const offsets: number[] = [];
    const fetcher = pageFetcher(pages(), offsets);
    for (let i = 0; i < 3; i++) await pollNaverSource(db, 56, fetcher);
    expect(offsets).toEqual([0, 1, 2]);
    expect((await snapshot()).poll).toMatchObject({ committed_item_id: "9000", next_offset: 0 });
    expect((await snapshot()).queue).toHaveLength(22);
  });

  it("retains the database's negative-offset guard", async () => {
    await seedMarker();
    const before = await snapshot();
    await expect(
      db.prepare("UPDATE source_poll_state SET next_offset=-1 WHERE source=?").bind(source).run(),
    ).rejects.toThrow("CHECK constraint failed");
    expect(await snapshot()).toEqual(before);
  });

  it.each([8, 16, 96, 104, 3, 1.5])(
    "rejects incompatible offset %s before network or writes",
    async (offset) => {
      await seedMarker();
      await db
        .prepare("UPDATE source_poll_state SET next_offset=? WHERE source=?")
        .bind(offset, source)
        .run();
      const before = await snapshot(),
        fetcher = pageFetcher(pages());
      await expect(pollNaverSource(db, 56, fetcher)).rejects.toThrow(
        "source_cursor_recovery_required",
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("bounded proven-boundary recovery", () => {
  beforeEach(seedHold);

  it("rejects stale held publication proof before fetching", async () => {
    await db
      .prepare(
        "UPDATE forecast_ops_alerts SET context_json=json_set(context_json,'$.committedPublishedAt',?) WHERE alert_key=?",
      )
      .bind("2026-09-04T09:05:21.000Z", holdKey)
      .run();
    const before = await snapshot();
    const fetcher = pageFetcher(pages());
    await expect(recoverNaverBoundary(db, "staging", request, fetcher)).rejects.toThrow(
      "naver_boundary_marker_conflict",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("bounds the entire recovery including response-body consumption", async () => {
    const before = await snapshot();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          queueMicrotask(() => deadline.abort());
        },
      });
      return new Response(stream, { headers: { "content-type": "application/json" } });
    });
    try {
      await expect(recoverNaverBoundary(db, "staging", request, fetcher)).rejects.toThrow(
        "naver_timeout",
      );
      expect(timeout).toHaveBeenCalledWith(40_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await snapshot()).toEqual(before);
    } finally {
      timeout.mockRestore();
    }
  });

  it("recovers page two atomically while preserving accepted facts, queue outcomes and original hold evidence", async () => {
    await acceptedEvidence();
    const before = await snapshot(),
      offsets: number[] = [];
    const fetcher = pageFetcher(pages(), offsets);
    await expect(recoverNaverBoundary(db, "staging", request, fetcher)).resolves.toEqual({
      recovered: true,
      source,
      queuedItems: 21,
    });
    expect(offsets).toEqual([0, 1, 2]);
    const after = await snapshot();
    expect(after.poll).toMatchObject({
      committed_item_id: "9000",
      committed_published_at: "2026-09-25T03:00:49.000Z",
      scan_head_item_id: null,
      scan_head_published_at: null,
      next_offset: 0,
    });
    expect(after.queue).toHaveLength(23);
    for (const item of pages().flat().slice(0, 21))
      expect(
        after.queue.find((entry) => entry["item_id"] === String(item.feed.feedId)),
      ).toBeDefined();
    expect(after.queue.find((entry) => entry["item_id"] === "9004")).toMatchObject({
      status: "processed",
      attempts: 2,
      error_code: "retained",
      first_seen_at: "before",
    });
    expect(after.items).toEqual(before.items);
    expect(after.events).toEqual(before.events);
    expect(after.hold).toMatchObject({
      state: "resolved",
      occurrence_count: before.hold?.["occurrence_count"],
    });
    expect(JSON.parse(String(after.hold?.["context_json"]))).toMatchObject(
      JSON.parse(String(before.hold?.["context_json"])),
    );
  });

  it("accepts equivalent timestamp representations without changing stored evidence", async () => {
    await db
      .prepare("UPDATE source_poll_state SET committed_published_at=? WHERE source=?")
      .bind("2026-09-03T18:05:21+09:00", source)
      .run();
    await expect(
      recoverNaverBoundary(db, "staging", request, pageFetcher(pages())),
    ).resolves.toMatchObject({ recovered: true });
  });

  it("requires an adjacent older page when the marker page ends in a known older pin", async () => {
    await db
      .prepare(`INSERT INTO source_queue(source,item_id,url,title,published_at,official,status,first_seen_at,updated_at)
      VALUES(?,'6007','https://game.naver.com/lounge/nikke/board/detail/6007','known','2026-09-01T03:00:00.000Z',1,'processed','before','before')`)
      .bind(source)
      .run();
    const offsets: number[] = [],
      data = [...pages(), [row("5000", "20260831120000")]];
    await expect(
      recoverNaverBoundary(db, "staging", request, pageFetcher(data, offsets)),
    ).resolves.toMatchObject({ recovered: true });
    expect(offsets).toEqual([0, 1, 2, 3]);
    expect((await snapshot()).queue.find((entry) => entry["item_id"] === "6007")?.["status"]).toBe(
      "processed",
    );
  });

  it("retains the marker's equal-date cohort rather than silently dropping a later row", async () => {
    const data = pages();
    const cohort = data[2]?.[2];
    if (!cohort) throw new Error("Missing fixture");
    cohort.feed.createdDate = "20260903180521";
    await expect(
      recoverNaverBoundary(db, "staging", request, pageFetcher(data)),
    ).resolves.toMatchObject({ queuedItems: 22 });
    expect((await snapshot()).queue.find((entry) => entry["item_id"] === "6000")?.["status"]).toBe(
      "pending",
    );
  });
});

describe("boundary recovery proof failures and atomicity", () => {
  beforeEach(seedHold);

  it.each([
    "date",
    "board",
    "lounge",
    "official",
    "url",
    "schema",
    "future",
    "duplicate",
    "order",
    "cross-page",
    "oversize",
    "network",
  ])("fails %s proof without recovery writes", async (kind) => {
    const before = await snapshot(),
      data = pages();
    const first = data[0]?.[0],
      second = data[1]?.[0],
      boundary = data[2]?.[1];
    if (!first || !second || !boundary || !data[0]) throw new Error("Missing fixture");
    if (kind === "date") boundary.feed.createdDate = "20260904180521";
    if (kind === "board") second.board.boardId = 48;
    if (kind === "lounge") second.feed.loungeId = "other";
    if (kind === "official") second.user.userRoleCode = "member";
    if (kind === "url") second.feedLink.pc = "https://attacker.example";
    if (kind === "schema") second.feed.title = "";
    if (kind === "future") first.feed.createdDate = "20990101120000";
    if (kind === "duplicate") second.feed.feedId = first.feed.feedId;
    if (kind === "order") data[0][1] = row("9999", "20260926120000");
    if (kind === "cross-page") second.feed.createdDate = "20260926120000";
    if (kind === "oversize") data[0].push(row("9999", "20260924120000"));
    const fetcher =
      kind === "network"
        ? vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"))
        : pageFetcher(data);
    let expectedError = "naver_scan_boundary_missing";
    if (["board", "lounge", "schema"].includes(kind)) expectedError = "naver_partial_schema_drift";
    if (kind === "network") expectedError = "naver_network";
    await expect(recoverNaverBoundary(db, "staging", request, fetcher)).rejects.toThrow(
      expectedError,
    );
    expect(await snapshot()).toEqual(before);
  });

  it("does not substitute dates for an absent marker or scan beyond four pages", async () => {
    const data = pages();
    if (!data[2]) throw new Error("Missing fixture");
    data[2][1] = row("7777", "20260903180521");
    data.push(Array.from({ length: 10 }, (_, i) => row(String(5000 + i), "20260831120000")));
    const offsets: number[] = [],
      before = await snapshot();
    await expect(
      recoverNaverBoundary(db, "staging", request, pageFetcher(data, offsets)),
    ).rejects.toThrow("naver_scan_boundary_missing");
    expect(offsets).toEqual([0, 1, 2, 3]);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["state-date", "state-head", "state-offset", "state-time", "hold"])(
    "retains concurrent %s changes and refuses partial recovery",
    async (kind) => {
      const data = pages();
      let raced: Awaited<ReturnType<typeof snapshot>> | undefined;
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const offset = Number(new URL(String(input)).searchParams.get("offset"));
        if (offset === 1) {
          const updates = {
            "state-date":
              "UPDATE source_poll_state SET committed_published_at='2026-09-04T09:05:21.000Z'",
            "state-head": "UPDATE source_poll_state SET scan_head_item_id='8239881'",
            "state-offset": "UPDATE source_poll_state SET next_offset=1",
            "state-time": "UPDATE source_poll_state SET updated_at='concurrent'",
            hold: "UPDATE forecast_ops_alerts SET context_json=json_set(context_json,'$.concurrent',1)",
          };
          await db.prepare(updates[kind as keyof typeof updates]).run();
          raced = await snapshot();
        }
        return response(data[offset] ?? []);
      });
      await expect(recoverNaverBoundary(db, "staging", request, fetcher)).rejects.toThrow(
        "naver_boundary_recovery_conflict",
      );
      expect(await snapshot()).toEqual(raced);
    },
  );

  it("has one winner when two recoveries prove the same held snapshot", async () => {
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    const data = pages();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      if (offset === 0) {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      }
      return response(data[offset] ?? []);
    });
    const results = await Promise.allSettled([
      recoverNaverBoundary(db, "staging", request, fetcher),
      recoverNaverBoundary(db, "staging", request, fetcher),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toBe(
      "naver_boundary_recovery_conflict",
    );
    expect((await snapshot()).queue).toHaveLength(23);
  });

  it("rolls back hold resolution and every enqueued item if cursor persistence fails", async () => {
    const before = await snapshot();
    await db
      .prepare(`CREATE TRIGGER reject_boundary_commit BEFORE UPDATE ON source_poll_state
      WHEN NEW.committed_item_id='9000' BEGIN SELECT RAISE(ABORT,'boundary_write_failed'); END`)
      .run();
    await expect(
      recoverNaverBoundary(db, "staging", request, pageFetcher(pages())),
    ).rejects.toThrow("boundary_write_failed");
    expect(await snapshot()).toEqual(before);
  });
});
