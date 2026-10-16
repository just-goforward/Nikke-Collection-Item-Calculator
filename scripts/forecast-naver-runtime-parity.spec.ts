import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNoticeDetail } from "../forecast-collector/src/notice";
import { parseNaverActionDetail } from "./forecast-naver-action";

const root = new URL("../forecast-collector/", import.meta.url);

describe("Actions parser parity (all recorded official bodies)", () => {
  it("matches both the frozen adapter and normalized fixture outputs", async () => {
    let count = 0;
    let rejected = 0;
    for (const directory of ["official-solo-history", "pr-notice-evidence"]) {
      const base = new URL(`fixtures/${directory}/`, root);
      const normalized = JSON.parse(readFileSync(new URL("normalized.json", base), "utf8")) as {
        sourceFeedId: number;
        sourceItem: unknown;
      }[];
      for (const name of readdirSync(base).filter((name) => /^\d+\.json$/.test(name))) {
        const payload = JSON.parse(readFileSync(new URL(name, base), "utf8"));
        const id = name.slice(0, -5);
        // Four historical notices moved to board 11. Both live adapters must
        // reject those identities rather than laundering them as board 56.
        if (payload.content.board.boardId !== 56) {
          await expect(parseNoticeDetail(payload, 56, id)).rejects.toThrow("naver_detail_board_id");
          await expect(parseNaverActionDetail(payload, 56, id)).rejects.toThrow(
            "naver_detail_board_id",
          );
          rejected += 1;
          count += 1;
          continue;
        }
        const actual = await parseNoticeDetail(payload, 56, id);
        expect(actual).toEqual(await parseNaverActionDetail(payload, 56, id));
        expect(actual).toEqual(
          normalized.find((entry) => String(entry.sourceFeedId) === id)?.sourceItem,
        );
        count += 1;
      }
    }
    expect(count).toBe(46);
    expect(rejected).toBe(4);
  });
});
