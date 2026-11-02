import { expect, it } from "vitest";
import { publicNoticeUrl } from "../../shared/forecastV2Messages.ts";

it("repairs only the verified board-qualified Naver post shape", () => {
  expect(publicNoticeUrl("https://game.naver.com/lounge/nikke/board/56/detail/8207413"))
    .toBe("https://game.naver.com/lounge/nikke/board/detail/8207413");
  for (const value of [
    "https://game.naver.com/lounge/nikke/board/detail/8207413",
    "https://game.naver.com/lounge/nikke/board/56",
    "https://example.com/lounge/nikke/board/56/detail/8207413",
    "https://user@game.naver.com/lounge/nikke/board/56/detail/8207413",
    "invalid",
  ]) expect(publicNoticeUrl(value)).toBe(value);
});
