import { describe, expect, it } from "vitest";
import { extractNoticeText } from "../forecast-collector/src/solo-sections.ts";
import { sanitizeDetail, sanitizePage } from "./capture-forecast-v2-fixtures.ts";

describe("forecast v2 evidence sanitizer", () => {
  it("retains exact notice text and removes account/reaction fields", () => {
    const contents = "<p>관리 키트 상자 II ×8</p><p><s>12:00</s> 13:00</p>";
    const raw = {
      code: 200,
      content: {
        feed: { feedId: 123, title: "공지", contents, createdDate: "20261018120000", buff: 8 },
        board: { boardId: 11, boardName: "공지", memberId: "private" },
        user: { userRoleCode: "game_manager", nickname: "private", memberId: "private" },
        profile: "private",
      },
    };
    const sanitized = sanitizeDetail(raw);
    expect(extractNoticeText(sanitized.content.feed["contents"])).toEqual(
      extractNoticeText(contents),
    );
    expect(JSON.stringify(sanitized)).not.toMatch(/private|nickname|memberId|buff|profile/);
    expect(sanitized.content.feed["createdDate"]).toBe("20261018120000");
    expect(() =>
      sanitizeDetail({
        ...raw,
        content: { ...raw.content, user: { userRoleCode: "member" } },
      }),
    ).toThrow();
  });
  it("filters non-managers while preserving raw dates and highlight markup", () => {
    const row = {
      feedId: 123,
      title: "<em>솔로 레이드</em>",
      previewText: "<mark>오픈</mark>",
      createdDate: "2026-09-17T18:00:09.000+09",
      updatedDate: "raw-date",
      board: { boardId: 56 },
      user: { userRoleCode: "game_manager", userId: "private" },
      reaction: 100,
    };
    const result = sanitizePage({
      code: 200,
      content: { feeds: [row, { ...row, user: { userRoleCode: "member" } }] },
    });
    expect(result.content.feeds).toEqual([
      {
        feedId: 123,
        title: row.title,
        previewText: row.previewText,
        createdDate: row.createdDate,
        updatedDate: "raw-date",
        boardId: 56,
        userRoleCode: "game_manager",
      },
    ]);
    const list = sanitizePage(
      {
        code: 200,
        content: {
          feeds: [{ feed: row, board: row.board, user: row.user }],
        },
      },
      true,
    );
    expect(list.content.feeds).toEqual(result.content.feeds);
  });
});
