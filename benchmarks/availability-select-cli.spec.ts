import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExactEntry, JourneyDemandEntry } from "./availability-selection-types";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("node:fs/promises", () => mocks);
vi.mock("./runner-utils", () => ({
  envValue: () => undefined,
  isErrorWithCode: () => false,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  mocks.readFile.mockReset();
  mocks.writeFile.mockClear();
  mocks.mkdir.mockClear();
});

describe("availability selection insufficient-evidence contracts", () => {
  it.each([
    ["absent", "Baseline A absent from results."],
    ["incomplete", "Baseline A gate incomplete (0/1; s1:time_budget_exceeded)."],
    ["unjudgeable", "Baseline A journey supplyDebt unjudgeable (no completion-sufficient panel)."],
  ])("preserves the %s baseline reason", async (state, reason) => {
    const exactResults: ExactEntry[] = [];
    if (state !== "absent") {
      exactResults.push({
        modelId: "tau0.01-h0.5-p3",
        scenario: "s1",
        status: state === "incomplete" ? "verification_incomplete" : "completed",
        reason: "time_budget_exceeded",
      });
    }
    const journeyDemand: JourneyDemandEntry[] = [];
    if (state === "incomplete") {
      journeyDemand.push({ candidateId: "tau0.01-h0.5-p3", maxPanelSupplyDebtCvar90: 1 });
    }
    mocks.readFile.mockImplementation(async (url: URL) =>
      JSON.stringify(
        url.pathname.endsWith("availability-significance.json")
          ? { candidates: [] }
          : { exactResults, journeyDemand, finiteStockTail: [] },
      ),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    await import("./run-availability-select");
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(mocks.writeFile.mock.calls[0]?.[1]))).toMatchObject({
      kind: "availability-selection",
      outcome: "insufficient-evidence",
      reason,
    });
    expect(mocks.writeFile.mock.calls[1]?.[1]).toContain(`- Reason: ${reason}`);
  });
});
