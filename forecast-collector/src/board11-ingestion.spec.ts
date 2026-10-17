import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { board11InvocationGate } from "./board11-policy";
import { ROTATION_ADMISSION_MS, ROTATION_INGESTION_ADMISSION_SQL } from "./collection-schedule";
import { processNotice } from "./notice-processing";
import { ingestionQueue } from "./runtime-ingestion-db";
import { pollNaverSource } from "./source-queue";
import { runtimeTestDb } from "./test-runtime-db";

const now = Date.parse("2026-07-01T00:00:00.000Z");
let sqlite: DatabaseSync;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../fixtures/schema-v27-test.sql", import.meta.url), "utf8"));
});
afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

function enqueue(board: number, id: string, age: number, status = "pending") {
  sqlite
    .prepare(`INSERT INTO source_queue
      (source,item_id,url,title,published_at,official,status,attempts,first_seen_at,updated_at)
      VALUES(?,?,?,'솔로 레이드 중단 안내',?,1,?,0,?,?)`)
    .run(
      `naver-board-${board}`,
      id,
      `https://game.naver.com/lounge/nikke/board/detail/${id}`,
      new Date(now - age).toISOString(),
      status,
      new Date(now - age).toISOString(),
      new Date(now).toISOString(),
    );
}

it("shares the two-slot queue with solo board 56 before 48 before fresh board 11", async () => {
  enqueue(11, "11", 0);
  enqueue(48, "48", 0);
  enqueue(56, "56", 0);
  expect((await ingestionQueue(runtimeTestDb(sqlite))).map((row) => row.item_id)).toEqual([
    "56",
    "48",
  ]);
});

it("prevents starvation: board 11 older than 24h receives the next slot", async () => {
  enqueue(11, "11", 86_400_001);
  enqueue(48, "48", 0);
  enqueue(56, "56", 0);
  expect((await ingestionQueue(runtimeTestDb(sqlite))).map((row) => row.item_id)).toEqual([
    "11",
    "56",
  ]);
});

it("does not age board 11 early or recheck ignored board-11 notices", async () => {
  enqueue(11, "11", 86_400_000);
  enqueue(11, "12", 172_800_000, "ignored");
  enqueue(48, "48", 0);
  enqueue(56, "56", 0);
  expect((await ingestionQueue(runtimeTestDb(sqlite))).map((row) => row.item_id)).toEqual([
    "56",
    "48",
  ]);
});

it("checks migration admission once per invocation, not per warm database binding", async () => {
  sqlite.exec("DELETE FROM schema_migrations WHERE version>=27");
  const db = runtimeTestDb(sqlite);
  const prepare = vi.spyOn(db, "prepare");
  const gate = board11InvocationGate(db);
  expect(await gate()).toBe(false);
  sqlite.exec("INSERT INTO schema_migrations VALUES(27,CURRENT_TIMESTAMP)");
  expect(await gate()).toBe(false);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(await board11InvocationGate(db)()).toBe(true);
});

it.each([
  [779_999, true],
  [780_000, true],
  [780_001, false],
])("requires all three latest polls within the 780s boundary: %s", (age, admitted) => {
  expect(ROTATION_ADMISSION_MS).toBe(780_000);
  const time = new Date(now - age).toISOString();
  const insert = sqlite.prepare(`INSERT INTO collector_invocations
    (invocation_id,deployment_sha,scheduled_at,started_at,finished_at,status,poll_mode)
    VALUES(?,'test',?,?,?,'completed','both')`);
  const query = sqlite.prepare(ROTATION_INGESTION_ADMISSION_SQL);
  const bindings = [new Date(now - 780_000).toISOString(), new Date(now).toISOString()];
  for (const board of [48, 56]) insert.run(`rotation-board-${board}:old`, time, time, time);
  expect(query.get(...bindings)).toBeUndefined();
  insert.run("rotation-board-11:old", time, time, time);
  expect(Boolean(query.get(...bindings))).toBe(admitted);
  const recent = new Date(now - 1).toISOString();
  insert.run("rotation-board-11:new", recent, recent, recent);
  sqlite.exec(
    "UPDATE collector_invocations SET status='failure' WHERE invocation_id='rotation-board-11:new'",
  );
  expect(query.get(...bindings)).toBeUndefined();
});

it("polls board 11 without requesting details or queuing negative/nonofficial titles", async () => {
  const ids = [7833931, 7837735, 7879335, 8138246, 7866081];
  const feeds = ids.map(
    (id) =>
      JSON.parse(
        readFileSync(new URL(`../fixtures/naver-detail-${id}.json`, import.meta.url), "utf8"),
      ).content,
  );
  feeds.push({
    ...feeds[0],
    feed: { ...feeds[0].feed, feedId: 9999999 },
    user: { userRoleCode: "member" },
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    expect(url.pathname.endsWith("/feed")).toBe(true);
    expect(url.searchParams.get("boardId")).toBe("11");
    expect(url.searchParams.get("offset")).toBe("0");
    return Response.json({ code: 200, content: { feeds } });
  });
  await pollNaverSource(runtimeTestDb(sqlite), 11, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(sqlite.prepare("SELECT item_id FROM source_queue ORDER BY item_id").all()).toEqual([
    { item_id: "7833931" },
    { item_id: "7837735" },
    { item_id: "7879335" },
  ]);
});

it("does not poll or write board 11 before migration 27", async () => {
  sqlite.exec("DELETE FROM schema_migrations WHERE version>=27");
  const fetcher = vi.fn<typeof fetch>();
  expect(await pollNaverSource(runtimeTestDb(sqlite), 11, fetcher)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(sqlite.prepare("SELECT * FROM source_poll_state").all()).toEqual([]);
});

it("ignores celebration rewards without kits after one detail request", async () => {
  const payload = JSON.parse(
    readFileSync(new URL("../fixtures/naver-detail-7879335.json", import.meta.url), "utf8"),
  );
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
  const result = await processNotice(
    {
      source: "naver-board-11",
      itemId: "7879335",
      url: "https://game.naver.com/lounge/nikke/board/detail/7879335",
      title: payload.content.feed.title,
      publishedAt: "2026-07-03T10:02:27.000Z",
      official: true,
      status: "pending",
      attempts: 0,
      errorCode: null,
    },
    fetcher,
    undefined,
    runtimeTestDb(sqlite),
  );
  expect(result).toMatchObject({ outcome: "ignored", errorCode: "no_kit_grant" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.events).toBeUndefined();
  expect(sqlite.prepare("SELECT * FROM source_queue").all()).toEqual([]);
  expect(sqlite.prepare("SELECT * FROM forecast_grants").all()).toEqual([]);
});

it("does not mistake a solo compensation grant for an undated raid opening", async () => {
  const payload = JSON.parse(
    readFileSync(new URL("../fixtures/naver-detail-7833931.json", import.meta.url), "utf8"),
  );
  payload.content.feed.title = "솔로 레이드 보상 지급 안내";
  payload.content.feed.contents =
    '<!-- SE_DOC_HEADER_START --><div class="se-viewer"><p>솔로 레이드 보상 안내</p><p>관리 키트 상자 II * 56</p><p>지급일 - 6/23</p></div>';
  const result = await processNotice(
    {
      source: "naver-board-11",
      itemId: "7833931",
      url: "https://game.naver.com/lounge/nikke/board/detail/7833931",
      title: payload.content.feed.title,
      publishedAt: "2026-06-22T15:47:33.000Z",
      official: true,
      status: "pending",
      attempts: 0,
      errorCode: null,
    },
    async () => Response.json(payload),
    undefined,
    runtimeTestDb(sqlite),
  );
  expect(result.outcome).toBe("processed");
  expect(result.events?.map((event) => event.eventType)).toEqual(["grant"]);
});
