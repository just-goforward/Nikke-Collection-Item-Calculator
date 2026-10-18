import { describe, expect, it } from "vitest";
import { fetchMetadata, metadataUrl, parseMetadata, timestamp } from "./client";
import { budgetGameDay, scheduledStream, v2Mode } from "./schedule";

const row = (id: number, createdDate = "2026-10-18T17:00:00.000+09") => ({
  feedId: id,
  lounge: { loungeId: "nikke" },
  boardId: 11,
  userRoleCode: "game_manager",
  title: "관리 키트",
  createdDate,
  updatedDate: createdDate,
});
const payload = (...feeds: unknown[]) => ({ code: 200, content: { feeds } });
describe("v2 metadata contracts", () => {
  it("uses row offsets for search and page indexes for G", () => {
    expect(metadataUrl("B", 2).searchParams.get("offset")).toBe("60");
    expect(metadataUrl("B", 2).searchParams.get("searchOption")).toBe("COMMUNITY_FEED_TITLE");
    expect(metadataUrl("G", 2).searchParams.get("offset")).toBe("2");
    expect(metadataUrl("G", 2).searchParams.get("limit")).toBe("10");
  });
  it("normalizes both timestamp formats without accepting invalid dates", () => {
    expect(timestamp("20261018170000")).toBe("2026-10-18T08:00:00.000Z");
    expect(timestamp("2026-10-18T17:00:00.000+09")).toBe("2026-10-18T08:00:00.000Z");
    expect(() => timestamp("20260230170000")).toThrow("timestamp");
  });
  it("accepts empty pages and fails closed for foreign, duplicate, and oldest-first rows", () => {
    expect(parseMetadata(payload(), "A")).toEqual([]);
    expect(() => parseMetadata(payload({ ...row(1), lounge: { loungeId: "other" } }), "A")).toThrow(
      "identity",
    );
    expect(() => parseMetadata(payload(row(1), row(1)), "A")).toThrow("feed");
    expect(() => parseMetadata(payload(row(1, "2026-10-17T17:00:00.000+09"), row(2)), "A")).toThrow(
      "ordering",
    );
  });
  it("reads the unsanitized nested lounge shape and skips valid member rows", () => {
    const nested = (feedId: number, userRoleCode: string) => ({
      lounge: { loungeId: "nikke" },
      board: { boardId: 11 },
      user: { userRoleCode },
      feed: {
        feedId,
        title: "redacted",
        createdDate: "2026-10-18T17:00:00.000+09",
        updatedDate: "2026-10-18T17:00:00.000+09",
      },
    });
    const parsed = parseMetadata(payload(nested(1, "game_manager"), nested(2, "member")), "A");
    expect(parsed.map((entry) => entry.feedId)).toEqual(["1"]);
    expect(() =>
      parseMetadata(
        payload({
          ...nested(3, "member"),
          lounge: { loungeId: "foreign" },
        }),
        "A",
      ),
    ).toThrow("identity");
  });
  it.each([400, 429, 500])("preserves HTTP %s failure", async (status) => {
    await expect(
      fetchMetadata("A", 0, async () => new Response("", { status })),
    ).rejects.toMatchObject({ code: `http_${status}`, retryable: status !== 400 });
  });
  it("enforces response cap", async () => {
    await expect(
      fetchMetadata(
        "A",
        0,
        async () =>
          new Response("", {
            headers: { "content-length": "2000001" },
          }),
      ),
    ).rejects.toMatchObject({ code: "oversize" });
  });
  it("retains explicit cron slots, default off, and 05:00 game-day boundary", () => {
    expect(scheduledStream(Date.parse("2026-10-18T00:03:00Z"))).toBe("G");
    expect(scheduledStream(Date.parse("2026-10-18T00:09:00Z"))).toBeNull();
    expect(v2Mode({})).toBe("off");
    expect(budgetGameDay(Date.parse("2026-10-17T19:59:59Z"))).toBe("2026-10-17");
    expect(budgetGameDay(Date.parse("2026-10-17T20:00:00Z"))).toBe("2026-10-18");
  });
});
