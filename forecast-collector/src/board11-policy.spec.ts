import { describe, expect, it } from "vitest";
import { board11MetadataEligible, board11TitleRelevant } from "./board11-policy";

describe("board-11 metadata admission", () => {
  it.each([
    "솔로 레이드 중단 안내",
    "솔로 레이드 재오픈 안내",
    "솔로레이드 재개 안내",
    "솔로 레이드 후속 처리 안내",
    "솔로 레이드 보상 지급 안내",
    "솔로 레이드 보상 안내",
    "보상 지급 안내",
    "애플 앱스토어 매출 1위 기념 보상 안내",
    "1주년 기념 선물 지급 안내",
  ])("admits relevant official title %s", (title) => {
    expect(board11TitleRelevant(title)).toBe(true);
    expect(board11MetadataEligible(title, true)).toBe(true);
    expect(board11MetadataEligible(title, false)).toBe(false);
  });

  it.each([
    "솔로 레이드 오픈 안내",
    "협동 작전 중단 안내",
    "업데이트 안내",
    "솔로 레이드 공략",
    "기념 이벤트 안내",
    "",
  ])("does not admit unrelated title %s", (title) => {
    expect(board11MetadataEligible(title, true)).toBe(false);
  });
});
