import { describe, expect, it } from "vitest";
import { rotationCanaryIdentityMatches } from "./canary-report";
import { collectionSchedule, rotationBoard, rotationInvocationId } from "./collection-schedule";

describe("collection schedule policy", () => {
  it("expects board and ingestion identities in their own slots", () => {
    expect(
      rotationCanaryIdentityMatches("rotation-ingestion:360000", new Date(360_000).toISOString()),
    ).toBe(true);
    expect(rotationCanaryIdentityMatches("rotation-board-48:0", new Date(0).toISOString())).toBe(
      true,
    );
    expect(
      rotationCanaryIdentityMatches("rotation-board-48:180000", new Date(180_000).toISOString()),
    ).toBe(false);
  });
  it.each([undefined, "", "combined", "invalid", "ROTATION"])(
    "defaults %s to combined",
    (value) => {
      expect(collectionSchedule(value === undefined ? {} : { COLLECTION_SCHEDULE: value })).toBe(
        "combined",
      );
    },
  );
  it("accepts only the explicit rotation policy", () => {
    expect(collectionSchedule({ COLLECTION_SCHEDULE: "rotation" })).toBe("rotation");
  });
  it.each([
    [0, 48],
    [180_000, 56],
    [360_000, null],
    [540_000, 48],
    [720_000, 56],
    [900_000, null],
  ] as const)("routes scheduled time %s to %s", (time, board) => {
    expect(rotationBoard(time)).toBe(board);
  });
  it("uses board-specific identities without deployment identity", () => {
    expect(rotationInvocationId(48, 540_000)).toBe("rotation-board-48:540000");
    expect(rotationInvocationId(56, 720_000)).toBe("rotation-board-56:720000");
  });
});
