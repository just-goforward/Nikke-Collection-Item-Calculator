import { expect, it } from "vitest";
import { advanceScan, nextBoundary, pendingBodies, startScan } from "./traversal";

const at = "2026-10-18T00:00:00.000Z";
const older = "2026-10-17T00:00:00.000Z";
const hit = (feedId: string, createdAt = at) => ({
  feedId,
  createdAt,
  updatedAt: createdAt,
  title: "notice",
});
it("keeps ties and processes changed bodies oldest first", () => {
  const scan = advanceScan(
    startScan({ createdAt: older, feedIds: ["1"] }),
    [hit("3"), hit("2"), hit("1", older)],
    "A",
  );
  expect(nextBoundary(scan)).toEqual({ createdAt: at, feedIds: ["2", "3"] });
  expect(pendingBodies(scan, new Map([["2", at]])).map((r) => r.feedId)).toEqual(["1", "3"]);
});
it("holds deleted boundary IDs rather than guessing completion", () => {
  const scan = advanceScan(
    startScan({ createdAt: older, feedIds: ["missing"] }),
    [hit("3"), hit("1", older)],
    "A",
  );
  expect(scan.reason).toBe("missing_boundary");
  expect(() => nextBoundary(scan)).toThrow("boundary_held");
});
it("caps a generation at four pages without changing its boundary", () => {
  const boundary = { createdAt: older, feedIds: [] };
  let scan = startScan(boundary);
  for (let page = 0; page < 4; page++)
    scan = advanceScan(
      scan,
      Array.from({ length: 30 }, (_, i) => hit(String(page * 30 + i + 1))),
      "A",
    );
  expect(scan.reason).toBe("page_cap");
  expect(scan.boundary).toEqual(boundary);
});
it("does not mutate input on partial failure and replays deterministically", () => {
  const scan = startScan({ createdAt: older, feedIds: [] });
  expect(() => advanceScan(scan, [hit("1", older), hit("2")], "A")).toThrow("ordering");
  expect(scan.page).toBe(0);
  expect(advanceScan(scan, [hit("2")], "A")).toEqual(advanceScan(scan, [hit("2")], "A"));
});
it("edit scans retain the committed new-post boundary", () => {
  const scan = advanceScan(startScan({ createdAt: older, feedIds: [] }, "edit"), [hit("2")], "A");
  expect(nextBoundary(scan)).toEqual(scan.boundary);
});
it("completes an exact-size result set on the next empty page", () => {
  const first = advanceScan(
    startScan({ createdAt: older, feedIds: [] }),
    Array.from({ length: 30 }, (_, index) => hit(String(index + 1))),
    "A",
  );
  expect(first.status).toBe("running");
  expect(advanceScan(first, [], "A").status).toBe("completed");
});
it("reseeds a deleted boundary from the newest valid older row", () => {
  const scan = advanceScan(
    startScan({ createdAt: at, feedIds: ["99"] }),
    [hit("2", older), hit("1", "2026-10-16T00:00:00.000Z")],
    "A",
  );
  expect(scan.reason).toBe("boundary_reseeded");
  expect(nextBoundary(scan)).toEqual({ createdAt: older, feedIds: ["2"] });
});
