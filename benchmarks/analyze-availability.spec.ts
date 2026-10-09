import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("./runner-utils", () => ({
  envValue: () => undefined,
  isErrorWithCode: (error: unknown) => error instanceof Error && "code" in error,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  mocks.readFile.mockReset();
});

describe("availability analysis output", () => {
  it.each([
    ["SR0-demand", "demand*"],
    ["R0-balanced", "balanced"],
    [null, "--"],
  ])("preserves binding and baseline labels for %s", async (panel, binding) => {
    const deep = {
      phase: "completed",
      generatedAt: "fixed",
      config: { journeyPanelIds: panel === null ? [] : [panel] },
      exactResults: [
        { modelId: "tau0.01-h0.5-p3", status: "completed", exactLossVsA: 0 },
        { modelId: "candidate", status: "completed", exactLossVsA: 0.004 },
      ],
      journeyDemand: ["tau0.01-h0.5-p3", "candidate"].map((candidateId, index) => {
        const debt = index === 0 ? 100 : 80;
        const panels = [];
        if (panel !== null) {
          panels.push({
            scenario: panel,
            status: "completed",
            summary: { completionRate: 1, maxSupplyDebtDaysCvar90: debt },
          });
        }
        return { candidateId, maxPanelSupplyDebtCvar90: debt, panels };
      }),
    };
    mocks.readFile.mockImplementation(async (url: URL) => {
      if (url.pathname.endsWith("availability-deep-slice.json")) return JSON.stringify(deep);
      if (url.pathname.endsWith("availability-significance.json")) {
        return JSON.stringify({
          candidates: [
            {
              candidateId: "candidate",
              significantImprovement: true,
              holmConfirmedImprovement: true,
              perPanel: [{ panel: "SR0-demand", status: "completed", confidenceLower: 3 }],
            },
          ],
        });
      }
      return JSON.stringify({ outcome: "fixed", stages: [] });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await import("./analyze-availability");
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.startsWith("tau0.01-h0.5-p3") && line.includes("(A)"))).toBe(
      true,
    );
    expect(
      lines.some(
        (line) =>
          line.startsWith("candidate") && line.includes("DOWN-20.0") && line.endsWith(binding),
      ),
    ).toBe(true);
    expect(lines).toContain("  candidate         significant=YES  Holm=true  [demand:CI+3.0]");
    expect(lines).toContain("  outcome: fixed");
  });
});
