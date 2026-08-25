import { describe, expect, it } from "vitest";
import { parseNaverActionDetail } from "./forecast-naver-action.ts";

describe("forecast Naver Actions adapter", () => {
  it("normalizes validated SmartEditor HTML without accepting arbitrary HTML", async () => {
    const item = await parseNaverActionDetail(
      detailPayload(
        '<div class="se-viewer se-theme-default" lang="ko-KR"><!-- SE_DOC_HEADER_START --><p>솔로 레이드가 8월 20일 12:00 ~ 8월 27일 4:59까지 진행됩니다.</p></div>',
      ),
      56,
      "8060044",
    );

    expect(item).toMatchObject({
      itemId: "8060044",
      official: true,
      structured: true,
    });
    expect(item?.normalizedText).toContain("8월 20일 12:00 ~ 8월 27일 4:59");

    await expect(
      parseNaverActionDetail(
        detailPayload("<div>솔로 레이드가 8월 20일부터 시작됩니다.</div>"),
        56,
        "8060044",
      ),
    ).rejects.toThrow("naver_unstructured_body");
  });

  it("preserves structured SmartEditor JSON", async () => {
    const contents = JSON.stringify({
      document: {
        components: [
          {
            "@ctype": "textNode",
            value: "솔로 레이드가 8월 20일 12:00 ~ 8월 27일 4:59까지 진행됩니다.",
          },
        ],
      },
    });
    const item = await parseNaverActionDetail(detailPayload(contents), 56, "8060044");

    expect(item?.structured).toBe(true);
    expect(item?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

function detailPayload(contents: string) {
  return {
    code: 200,
    content: {
      feed: {
        feedId: 8060044,
        title: "솔로 레이드 오픈 예정",
        createdDate: "20260814170042",
        contents,
      },
      user: { userRoleCode: "game_manager" },
      board: { boardId: 56 },
      feedLink: {
        pc: "https://game.naver.com/lounge/nikke/board/detail/8060044",
      },
    },
  };
}
