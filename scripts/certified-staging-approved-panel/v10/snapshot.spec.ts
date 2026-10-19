import { expect, it } from "vitest";
import { history, seasons } from "./fixtures/input.ts";
import { medianPrediction } from "./median.ts";
import { prepareSnapshot } from "./snapshot.ts";

it("constructs a reproducible median input and agrees with independent pinned history", async () => {
  const first = await prepareSnapshot();
  const second = await prepareSnapshot();
  expect(second).toEqual(first);
  const anchor = seasons[1];
  const prediction = medianPrediction(
    history.map((row) => row[1]),
    anchor[1],
    anchor[2],
    first.snapshot.asOf,
  );
  expect(first.snapshot.cadence.medianDays).toBe(prediction.cadence.predictionDays);
  const next = first.snapshot.soloRounds.find((round) => round.round === 43);
  expect(next?.segments?.[0]?.effectiveFrom).toBe(prediction.start);
  expect(next?.segments?.[0]?.effectiveUntil).toBe(prediction.end);
  expect(first.snapshot.events.some((event) => event.kind === "grant")).toBe(true);
});
