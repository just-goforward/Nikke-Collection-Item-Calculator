import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { interruptionEvidence, judgeMaintenance, judgeSolo } from "./schedules";

it("recognizes the captured 4899747 G maintenance notice", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/forecast-v2/details/4899747.json", import.meta.url),
      "utf8",
    ),
  );
  const feed = fixture.content.feed;
  const result = judgeMaintenance({
    title: feed.title,
    body: feed.contents,
    postedAt: "2024-10-14T19:01:43+09:00",
  });
  expect(result).toMatchObject({ action: "confirmed" });
  if (result.action === "confirmed") {
    expect(result.startAt.slice(0, 10)).toBe("2024-10-17");
    expect(Date.parse(result.endAt)).toBeGreaterThan(Date.parse(result.startAt));
  }
});
it("resolves maintenance dependencies and end-only open notices", () => {
  const post = {
    title: "솔로 레이드 오픈 안내",
    body: "진행 기간: 6/18(목) 점검 완료 후 ~ 6/25(목) 4:59",
    postedAt: "2026-06-18T10:00:00+09:00",
  };
  expect(judgeSolo(post, [])).toMatchObject({ action: "decision", reason: "maintenance_missing" });
  expect(
    judgeSolo(post, [
      { id: "m", startAt: "2026-06-18T05:00:00+09:00", endAt: "2026-06-18T12:00:00+09:00" },
    ]),
  ).toMatchObject({
    action: "confirmed",
    startAt: "2026-06-18T12:00:00+09:00",
    endAt: "2026-06-25T04:59:59+09:00",
  });
  expect(judgeSolo({ ...post, body: "6/25(목) 4:59까지" }, [])).toMatchObject({
    action: "confirmed",
    startAt: post.postedAt,
  });
});

it("reads 6225681's reopen period after the label and never guesses a missing maintenance end", () => {
  const feed = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/official-solo-history/6225681.json", import.meta.url),
      "utf8",
    ),
  ).content.feed;
  const post = { title: feed.title, body: feed.contents, postedAt: "2025-06-19T12:18:55.000Z" };
  expect(interruptionEvidence(post)).toEqual([
    { kind: "reopen", endAt: "2025-07-01T04:59:59+09:00" },
  ]);
  expect(
    interruptionEvidence(post, [
      {
        id: "test-maintenance",
        startAt: "2025-06-24T05:00:00+09:00",
        endAt: "2025-06-24T13:00:00+09:00",
      },
    ]),
  ).toEqual([
    {
      kind: "reopen",
      startAt: "2025-06-24T13:00:00+09:00",
      endAt: "2025-07-01T04:59:59+09:00",
    },
  ]);
});

it("accepts U7's plain 일시 label from 6241570 only with a maintenance title", () => {
  const post = {
    title: "[점검 완료]6월 24일(화) 업데이트 소식 사전 안내",
    body: "✔️ 일시\n- 6/24(화) 11:00 ~ 16:00",
    postedAt: "2025-06-23T10:00:00+09:00",
  };
  expect(judgeMaintenance(post)).toEqual({
    action: "confirmed",
    startAt: "2025-06-24T11:00:00+09:00",
    endAt: "2025-06-24T16:00:00+09:00",
  });
  expect(judgeMaintenance({ ...post, title: "이벤트 안내" })).toEqual({ action: "ignore" });
});

it.each([6963012, 6630598, 6109550, 5939379, 5848409])(
  "ignores captured 무점검 notice %s instead of creating a missing-period decision",
  (id) => {
    const feed = JSON.parse(
      readFileSync(
        new URL(`../../../fixtures/forecast-v2/details/${id}.json`, import.meta.url),
        "utf8",
      ),
    ).content.feed;
    const postedAt = feed.createdDate.replace(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,
      "$1-$2-$3T$4:$5:$6+09:00",
    );
    expect(feed.title).toContain("무점검");
    expect(judgeMaintenance({ title: feed.title, body: feed.contents, postedAt })).toEqual({
      action: "ignore",
    });
  },
);

it("requires a 점검 occurrence outside 무점검, rather than rejecting every mixed title", () => {
  const post = {
    title: "무점검 업데이트 안내",
    body: "✔️ 일시\n- 6/24(화) 11:00 ~ 16:00",
    postedAt: "2025-06-23T10:00:00+09:00",
  };
  expect(judgeMaintenance(post)).toEqual({ action: "ignore" });
  expect(judgeMaintenance({ ...post, title: "무점검 업데이트 및 서버 점검 안내" })).toMatchObject({
    action: "confirmed",
    endAt: "2025-06-24T16:00:00+09:00",
  });
});
