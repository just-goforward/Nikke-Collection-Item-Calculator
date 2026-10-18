import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { soloIdentity, soloRound } from "./solo-identity";

it("binds captured reopen 7877359 to S38 and E supplement 6280133 to S26", () => {
  for (const [path, id, round] of [
    ["../../../fixtures/naver-detail-7877359.json", "7877359", 38],
    ["../../../fixtures/forecast-v2/details/6280133.json", "6280133", 26],
  ] as const) {
    const feed = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).content.feed;
    expect(soloRound(feed.title, feed.contents, id)).toBe(round);
  }
});
it("keeps three season windows without replacing earlier segments and deduplicates restatements", () => {
  const existing: { id: string; startAt: string; provenance: string }[] = [];
  for (const [index, startAt] of [
    "2024-10-31T12:00:00+09:00",
    "2024-11-07T12:00:00+09:00",
    "2024-11-10T12:00:00+09:00",
  ].entries()) {
    const result = soloIdentity(19, String(index), startAt, existing);
    expect(result.segment).toBe(index + 1);
    existing.push({ id: result.eventId, startAt, provenance: JSON.stringify(result) });
    expect(soloIdentity(19, "restatement", startAt, existing)).toEqual(result);
  }
  expect(existing).toHaveLength(3);
});
