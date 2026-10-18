import { describe, expect, it } from "vitest";
import type { Metadata } from "./client";
import { advanceScan, nextBoundary, pendingBodies, type Scan, startScan } from "./traversal";

const T = "2026-10-18T08:00:00.000Z";
const hour = (offset: number) => new Date(Date.parse(T) + offset * 3_600_000).toISOString();
const row = (feedId: number, createdAt: string, updatedAt = createdAt): Metadata => ({
  feedId: String(feedId),
  title: `n${feedId}`,
  createdAt,
  updatedAt,
});
/** n rows strictly newer than T, newest first, ids descending from `top`. */
const newer = (n: number, top: number, startHour = 1000) =>
  Array.from({ length: n }, (_, i) => row(top - i, hour(startHour - i)));
const ids = (rows: Metadata[]) => rows.map((r) => r.feedId);

describe("T03 new-post scan", () => {
  it("stops at the committed boundary and advances to the newest hit", () => {
    const scan = advanceScan(
      startScan({ createdAt: T, feedIds: ["10"] }),
      [row(13, hour(2)), row(12, hour(1)), row(10, T), row(9, hour(-1))],
      "A",
    );
    expect(scan).toMatchObject({ status: "completed", reason: null, page: 1 });
    expect(ids(scan.hits).sort()).toEqual(["10", "12", "13"]);
    expect(nextBoundary(scan)).toEqual({ createdAt: hour(2), feedIds: ["13"] });
  });

  it("keeps the previous boundary when nothing is newer", () => {
    const scan = advanceScan(
      startScan({ createdAt: T, feedIds: ["10"] }),
      [row(10, T), row(9, hour(-1))],
      "A",
    );
    expect(nextBoundary(scan)).toEqual({ createdAt: T, feedIds: ["10"] });
  });

  it("tracks equal-timestamp ties as a feed-ID set and unions it with the old set", () => {
    const scan = advanceScan(
      startScan({ createdAt: T, feedIds: ["10"] }),
      [row(12, T), row(11, T), row(10, T), row(9, hour(-1))],
      "A",
    );
    expect(nextBoundary(scan)).toEqual({ createdAt: T, feedIds: ["10", "11", "12"] });
    // A later tie at the new boundary time replaces the older set.
    const later = advanceScan(
      startScan(nextBoundary(scan)),
      [row(21, hour(1)), row(20, hour(1)), row(12, T), row(11, T), row(10, T)],
      "A",
    );
    expect(later.status).toBe("completed");
    expect(nextBoundary(later)).toEqual({ createdAt: hour(1), feedIds: ["20", "21"] });
  });

  it("a tie page that ends exactly at the boundary time completes only by a short page", () => {
    const full = advanceScan(
      startScan({ createdAt: T, feedIds: ["1"] }),
      Array.from({ length: 30 }, (_, i) => row(100 - i, T)),
      "A",
    );
    expect(full.status).toBe("running");
    const short = advanceScan(
      startScan({ createdAt: T, feedIds: ["1"] }),
      [row(2, T), row(1, T)],
      "A",
    );
    expect(short.status).toBe("completed");
  });

  it.each([
    ["deleted boundary post", ["10"], [row(12, hour(1)), row(9, hour(-1)), row(8, hour(-2))]],
    [
      "one of two tied boundary posts deleted",
      ["10", "11"],
      [row(12, hour(1)), row(11, T), row(9, hour(-1)), row(8, hour(-2))],
    ],
  ])("%s → re-seeded from the newest valid older row (F14)", (_name, feedIds, rows) => {
    const scan = advanceScan(startScan({ createdAt: T, feedIds }), rows, "A");
    const reseeded = { createdAt: hour(-1), feedIds: ["9"] };
    expect(scan).toMatchObject({ status: "completed", reason: "boundary_reseeded" });
    expect(nextBoundary(scan)).toEqual(reseeded);
    // Every row at or after the old boundary is still collected; older rows are not.
    expect(ids(scan.hits).sort()).toEqual(ids(rows.filter((r) => r.createdAt >= T)).sort());
    // The next generation from the re-seeded boundary completes normally.
    const next = advanceScan(startScan(reseeded), rows, "A");
    expect(next).toMatchObject({ status: "completed", reason: null });
    expect(nextBoundary(next)).toEqual({ createdAt: hour(1), feedIds: ["12"] });
  });

  it("re-seeds from a skipped-row page using only valid (manager) rows", () => {
    // parseMetadata drops non-manager rows but reports the source row count.
    const parsed = Object.assign([row(12, hour(1)), row(8, hour(-2))], { sourceCount: 3 });
    const scan = advanceScan(startScan({ createdAt: T, feedIds: ["10"] }), parsed, "A");
    expect(nextBoundary(scan)).toEqual({ createdAt: hour(-2), feedIds: ["8"] });
  });

  it.each([
    ["short last page without the boundary post", ["10"], [row(12, hour(1))]],
    // Results exhausted on an empty page: nothing older to re-seed from, same as a short page.
    ["empty last page without the boundary post", ["10"], []],
  ])("%s → held, boundary unchanged", (_name, feedIds, rows) => {
    const boundary = { createdAt: T, feedIds };
    const scan = advanceScan(startScan(boundary), rows, "A");
    expect(scan).toMatchObject({ status: "held", reason: "missing_boundary", boundary });
    expect(() => nextBoundary(scan)).toThrow(expect.objectContaining({ code: "boundary_held" }));
  });
});

describe("T03 new-post scan pagination", () => {
  it("caps a generation at four pages (search 30 rows, G 10 rows)", () => {
    for (const [stream, size] of [
      ["A", 30],
      ["G", 10],
    ] as const) {
      let scan = startScan({ createdAt: T, feedIds: [] });
      for (let p = 0; p < 4; p++) {
        expect(scan.status).toBe("running");
        scan = advanceScan(scan, newer(size, 10_000 - p * size, 1000 - p * size), stream);
      }
      expect(scan).toMatchObject({ status: "held", reason: "page_cap", page: 4 });
      expect(scan.hits).toHaveLength(size * 4);
      expect(() => advanceScan(scan, newer(1, 1), stream)).toThrow(
        expect.objectContaining({ code: "scan_not_running" }),
      );
      expect(() => nextBoundary(scan)).toThrow(expect.objectContaining({ code: "boundary_held" }));
    }
  });

  it("completes on the fourth page when it reaches the boundary", () => {
    let scan = startScan({ createdAt: T, feedIds: [] });
    for (let p = 0; p < 3; p++)
      scan = advanceScan(scan, newer(30, 10_000 - p * 30, 1000 - p * 30), "A");
    scan = advanceScan(scan, [row(1, hour(1)), row(0, hour(-1))], "A");
    expect(scan.status).toBe("completed");
    expect(nextBoundary(scan).createdAt).toBe(hour(1000));
  });

  it("treats a short page as the end of results", () => {
    expect(advanceScan(startScan({ createdAt: T, feedIds: [] }), newer(29, 100), "A").status).toBe(
      "completed",
    );
    expect(advanceScan(startScan({ createdAt: T, feedIds: [] }), newer(30, 100), "A").status).toBe(
      "running",
    );
    expect(advanceScan(startScan({ createdAt: T, feedIds: [] }), newer(9, 100), "G").status).toBe(
      "completed",
    );
    expect(advanceScan(startScan({ createdAt: T, feedIds: [] }), newer(10, 100), "G").status).toBe(
      "running",
    );
  });

  it("completes on an empty page: no results, or the end of an exact multiple of the page size (F14)", () => {
    const bootstrap = { createdAt: T, feedIds: [] };
    for (const [stream, size] of [
      ["A", 30],
      ["G", 10],
    ] as const) {
      const none = advanceScan(startScan(bootstrap), [], stream);
      expect(none).toMatchObject({ status: "completed", reason: null, page: 1 });
      expect(nextBoundary(none)).toEqual(bootstrap);

      const full = advanceScan(startScan(bootstrap), newer(size, 100), stream);
      expect(full.status).toBe("running");
      const ended = advanceScan(full, [], stream);
      expect(ended).toMatchObject({ status: "completed", reason: null, page: 2 });
      expect(nextBoundary(ended)).toEqual({ createdAt: hour(1000), feedIds: ["100"] });

      // The committed boundary is the last row of a full page; the next page is empty.
      const rows = [...newer(size - 1, 100), row(10, T)];
      const reached = advanceScan(startScan({ createdAt: T, feedIds: ["10"] }), rows, stream);
      expect(reached.status).toBe("running");
      expect(advanceScan(reached, [], stream)).toMatchObject({ status: "completed", reason: null });
    }
  });

  it("rejects oversized pages for each stream size", () => {
    const scan = startScan({ createdAt: T, feedIds: [] });
    expect(() => advanceScan(scan, newer(31, 100), "A")).toThrow(
      expect.objectContaining({ code: "page_size" }),
    );
    expect(() => advanceScan(scan, newer(11, 100), "G")).toThrow(
      expect.objectContaining({ code: "page_size" }),
    );
  });

  it("rejects ordering across pages and drift of a row seen on an earlier page", () => {
    const first = advanceScan(startScan({ createdAt: T, feedIds: [] }), newer(30, 100, 50), "A");
    expect(() => advanceScan(first, [row(500, hour(60))], "A")).toThrow(
      expect.objectContaining({ code: "ordering" }),
    );
    const last = first.hits.at(-1)!;
    expect(() => advanceScan(first, [{ ...last, updatedAt: hour(99) }], "A")).toThrow(
      expect.objectContaining({ code: "scan_drift" }),
    );
    // A row shifted onto the next page by a newly inserted post is accepted once.
    const next = advanceScan(first, [last, row(1, hour(-1))], "A");
    expect(next.hits).toHaveLength(30);
    expect(next.status).toBe("completed");
  });

  it("is pure: failed transitions leave the input unchanged and replays are deterministic", () => {
    const scan = startScan({ createdAt: T, feedIds: ["10"] });
    const snapshot = structuredClone(scan);
    expect(() => advanceScan(scan, [row(9, hour(-1)), row(12, hour(1))], "A")).toThrow();
    expect(scan).toEqual(snapshot);
    const page = [row(12, hour(1)), row(10, T), row(9, hour(-1))];
    expect(advanceScan(scan, page, "A")).toEqual(advanceScan(scan, page, "A"));
    expect(scan).toEqual(snapshot);
  });

  it("rejects an invalid bootstrap cutoff", () => {
    expect(() => startScan({ createdAt: "not a time", feedIds: [] })).toThrow(
      expect.objectContaining({ code: "cutoff" }),
    );
  });
});

describe("T03 edit scan", () => {
  it("never moves the new-post boundary and ignores missing boundary IDs", () => {
    const boundary = { createdAt: hour(-336), feedIds: ["gone"] };
    const scan = advanceScan(
      startScan(boundary, "edit"),
      [row(12, hour(1), hour(5)), row(9, hour(-400))],
      "A",
    );
    expect(scan.status).toBe("completed");
    expect(nextBoundary(scan)).toEqual(boundary);
  });
});

describe("T03 body order", () => {
  it("returns unseen or changed bodies oldest first, ties by feed ID", () => {
    const scan: Scan = {
      ...startScan({ createdAt: T, feedIds: [] }),
      hits: [row(30, hour(3)), row(21, hour(2)), row(20, hour(2)), row(10, hour(1), hour(4))],
    };
    expect(ids(pendingBodies(scan, new Map()))).toEqual(["10", "20", "21", "30"]);
    expect(
      ids(
        pendingBodies(
          scan,
          new Map([
            ["10", hour(1)],
            ["20", hour(2)],
          ]),
        ),
      ),
    ).toEqual(["10", "21", "30"]);
    expect(
      ids(
        pendingBodies(
          scan,
          new Map([
            ["10", hour(4)],
            ["20", hour(2)],
            ["21", hour(2)],
            ["30", hour(3)],
          ]),
        ),
      ),
    ).toEqual([]);
  });
});
