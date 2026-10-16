import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { executeTestSql } from "../../shared/testD1Sql";
import { coveredBoundaryTail, naverPagePolicy } from "./naver-boundary-proof";
import { pollNaverSource, recoverNaverBoundary } from "./source-queue";
import schema from "./test-schema";

const db = env.FORECAST_DB;
beforeEach(async () => {
  await reset();
  await executeTestSql(db, schema, applyD1Migrations);
});

it.each(["5", "10", "invalid"])("preserves coverage for %s", (value) => {
  const policy = naverPagePolicy(48, value);
  expect(policy.pageSize * policy.scanPages).toBe(30);
  expect(policy.pageSize * policy.recoveryPages).toBe(40);
  expect(naverPagePolicy(56, value).pageSize).toBe(10);
  expect(policy.pageSize).toBe(value === "5" ? 5 : 10);
});

it("distinguishes full and terminal five-row pages", () => {
  expect(coveredBoundaryTail([], 4, "", false, 5)).toBe(true);
  expect(coveredBoundaryTail([], 5, "", false, 5)).toBe(false);
});

function response(id: number) {
  return Response.json({
    code: 200,
    content: {
      feeds: [
        {
          feed: { feedId: id, loungeId: "nikke", title: "Official", createdDate: "20260925120049" },
          user: { userRoleCode: "game_manager" },
          board: { boardId: 48 },
          feedLink: { pc: `https://game.naver.com/lounge/nikke/board/detail/${id}` },
        },
      ],
    },
  });
}

it.each([
  [10, "5"],
  [5, "10"],
] as const)("finishes size %i before adopting %s", async (size, configured) => {
  await db
    .prepare(`INSERT INTO source_poll_state
      (source, committed_item_id, committed_published_at, scan_head_item_id,
       scan_head_published_at, next_offset, updated_at, page_size)
      VALUES ('naver-board-48','100','2026-09-25T03:00:49.000Z','200',
      '2026-09-25T03:00:49.000Z',1,'2026-09-25T03:00:49.000Z',?)`)
    .bind(size)
    .run();
  const limits: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    limits.push(new URL(String(input)).searchParams.get("limit") ?? "");
    return response(limits.length === 1 ? 100 : 200);
  };
  await pollNaverSource(db, 48, fetcher, "staging", undefined, configured);
  await pollNaverSource(db, 48, fetcher, "staging", undefined, configured);
  expect(limits).toEqual([String(size), configured]);
});

it("rejects a concurrent cursor policy change", async () => {
  await db
    .prepare(`INSERT INTO source_poll_state(source,updated_at)
    VALUES ('naver-board-48','2026-09-25T03:00:49.000Z')`)
    .run();
  const result = await pollNaverSource(
    db,
    48,
    async () => {
      await db.prepare("UPDATE source_poll_state SET page_size=5").run();
      return response(200);
    },
    "staging",
    undefined,
    "5",
  );
  expect(result).toBeNull();
  expect((await db.prepare("SELECT * FROM source_queue").all()).results).toHaveLength(0);
});

it.each([5, 10])("retains held size %i and the moved-marker ten-row window", async (size) => {
  await pollNaverSource(db, 48, async () => response(100), "staging", undefined, String(size));
  await expect(
    pollNaverSource(db, 48, async () => response(200), "staging", undefined, String(size)),
  ).rejects.toThrow("naver_scan_boundary_missing");
  if (size === 10) {
    await db
      .prepare(`UPDATE forecast_ops_alerts
      SET context_json=json_remove(context_json,'$.pageSize')`)
      .run();
  }
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(`${url.searchParams.get("limit")}:${url.searchParams.get("offset")}`);
    const offset = Number(url.searchParams.get("offset"));
    const feeds = await Promise.all(
      Array.from({ length: size }, async (_, i) => {
        const position = offset * size + i;
        const payload = await response(position === 9 ? 200 : 300 + position).json();
        return (payload as { content: { feeds: unknown[] } }).content.feeds[0];
      }),
    );
    return Response.json({ code: 200, content: { feeds } });
  };
  const result = await recoverNaverBoundary(
    db,
    "staging",
    {
      mode: "recover-boundary",
      environment: "staging",
      source: "naver-board-48",
      expectedCommittedItemId: "100",
    },
    fetcher,
    { itemId: "100", boardId: 56, publishedAt: "2026-09-25T03:00:49.000Z", official: true },
  );
  expect(result.queuedItems).toBe(9);
  expect(requests).toEqual(size === 5 ? ["5:0", "5:1"] : ["10:0"]);
  const limits: string[] = [];
  await pollNaverSource(
    db,
    48,
    async (input) => {
      limits.push(new URL(String(input)).searchParams.get("limit") ?? "");
      return response(300);
    },
    "staging",
    undefined,
    size === 5 ? "10" : "5",
  );
  expect(limits).toEqual([size === 5 ? "10" : "5"]);
});
