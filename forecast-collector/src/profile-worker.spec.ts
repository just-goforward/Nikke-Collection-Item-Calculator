import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCollection } from "./collector";
import { profileIngestionAdmitted } from "./profile";
import { runRuntimeIngestion } from "./runtime-ingestion";
import type { CollectorEnv } from "./types";
import worker from "./worker";

vi.mock("./collector", () => ({ runCollection: vi.fn() }));
vi.mock("./source-queue", () => ({
  startInvocation: vi.fn().mockResolvedValue("rotation-ingestion:360000"),
  finishInvocation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./runtime-ingestion", () => ({ runRuntimeIngestion: vi.fn() }));
vi.mock("./http", () => ({ handleHttpRequest: vi.fn() }));
vi.mock("./http-shared", () => ({
  requireGuardDb: vi.fn(),
  automationOperation: vi.fn(),
}));
vi.mock("../../shared/usageGuard.ts", () => ({
  assertUsageAllowed: vi.fn(),
  UsageGuardError: class extends Error {},
}));
vi.mock("./profile", async (original) => ({
  ...(await original<typeof import("./profile")>()),
  profileIngestionAdmitted: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runCollection).mockResolvedValue({
    outcome: "completed",
    polledSources: 2,
    queuedItems: 0,
  });
  vi.mocked(runRuntimeIngestion).mockResolvedValue({
    outcome: "disabled",
    processed: 0,
    candidateCreated: false,
  });
});

async function invoke(
  phase?: string,
  environment = "staging",
  scheduledTime = 360_000,
  schedule = "combined",
) {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled(
    { scheduledTime } as ScheduledController,
    {
      ENVIRONMENT: environment,
      COLLECT_ENABLED: "true",
      COLLECTION_SCHEDULE: schedule,
      ...(phase === undefined ? {} : { COLLECTOR_PROFILE_PHASE: phase }),
    } as CollectorEnv,
    {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    } as ExecutionContext,
  );
  await Promise.all(pending);
}

describe("scheduled profiling routing", () => {
  it("labels a board boundary hold independently from ingestion admission", async () => {
    vi.mocked(runCollection).mockResolvedValue({
      outcome: "held",
      polledSources: 1,
      queuedItems: 0,
    });
    const log = vi.spyOn(console, "log");
    try {
      await invoke("off", "staging", 0, "rotation");
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"outcome":"held","reason":"held"'));
    } finally {
      log.mockRestore();
    }
  });
  it.each([0, 180_000, 360_000])("routes rotation %s", async (slot) => {
    await invoke("off", "staging", slot, "rotation");
    if (slot === 360_000) {
      expect(runCollection).not.toHaveBeenCalled();
      expect(runRuntimeIngestion).toHaveBeenCalledWith(expect.anything(), {
        requireRotationAdmission: true,
      });
    } else {
      expect(runRuntimeIngestion).not.toHaveBeenCalled();
      expect(runCollection).toHaveBeenCalledWith(expect.anything(), {
        nowMs: slot,
        board: slot === 0 ? 48 : 56,
        rotation: true,
      });
    }
  });
  it("profiling overrides rotation", async () => {
    await invoke("board-56", "staging", 0, "rotation");
    expect(runCollection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ board: 56 }),
    );
    expect(vi.mocked(runCollection).mock.calls[0]?.[1]).not.toHaveProperty("rotation");
  });
  it.each([360_000, 540_000])("alternates by cron slot: %s", async (slot) => {
    vi.mocked(profileIngestionAdmitted).mockResolvedValue(true);
    await invoke("alternate", "staging", slot);
    expect(runCollection).toHaveBeenCalledTimes(slot === 360_000 ? 1 : 0);
    expect(runRuntimeIngestion).toHaveBeenCalledTimes(slot === 540_000 ? 1 : 0);
  });
  it.each([undefined, "off", "invalid"])("preserves the default chain for %s", async (phase) => {
    await invoke(phase);
    expect(runCollection).toHaveBeenCalledWith(expect.anything(), { nowMs: 360_000 });
    expect(runRuntimeIngestion).toHaveBeenCalledOnce();
    expect(profileIngestionAdmitted).not.toHaveBeenCalled();
  });
  it("ignores profiling in production", async () => {
    await invoke("ingest-only", "production");
    expect(runCollection).toHaveBeenCalledOnce();
    expect(runRuntimeIngestion).toHaveBeenCalledOnce();
    expect(profileIngestionAdmitted).not.toHaveBeenCalled();
  });
  it.each(["poll-only", "board-48", "board-56"])("isolates %s", async (phase) => {
    await invoke(phase);
    expect(runCollection).toHaveBeenCalledOnce();
    expect(runCollection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        nowMs: 360_000,
        ...(phase === "board-48" ? { board: 48 } : {}),
        ...(phase === "board-56" ? { board: 56 } : {}),
      }),
    );
    expect(runRuntimeIngestion).not.toHaveBeenCalled();
  });
  it.each([true, false])("admits ingestion only with durable evidence: %s", async (admitted) => {
    vi.mocked(profileIngestionAdmitted).mockResolvedValue(admitted);
    await invoke("ingest-only");
    expect(runCollection).not.toHaveBeenCalled();
    expect(runRuntimeIngestion).toHaveBeenCalledTimes(admitted ? 1 : 0);
    if (admitted) {
      expect(runRuntimeIngestion).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ requireProfileAdmission: true }),
      );
    }
  });
  it("retains default failed-collection admission", async () => {
    vi.mocked(runCollection).mockResolvedValue({
      outcome: "failure",
      polledSources: 2,
      queuedItems: 0,
    });
    await invoke();
    expect(runRuntimeIngestion).not.toHaveBeenCalled();
  });
});
