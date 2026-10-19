import type { EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { RuntimeForecastStatus } from "../lib/runtimeForecast";
import { createCertifiedSession } from "./session";
import {
  stagingRuntimeSnapshot,
  useCertifiedCalculatorPreparation,
} from "./useCertifiedCalculatorPreparation";

const driver = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  prepare: vi.fn(),
  peek: vi.fn(),
  watch: vi.fn(),
  listener: undefined as ((status: RuntimeForecastStatus) => void) | undefined,
  tick: undefined as (() => void) | undefined,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: EffectCallback) => driver.effects.push(effect),
}));
vi.mock("../lib/certifiedForecast", () => ({ prepareCertifiedForecast: driver.prepare }));
vi.mock("../lib/runtimeForecast", () => ({
  runtimeForecast: { peek: driver.peek, watch: driver.watch },
}));

const snapshot = buildCertifiedSupplySnapshot({
  asOf: "2026-10-07T03:00:00Z",
  revision: "runtime-approved",
  sourceHash: "b".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
});
const bundled = { ...snapshot, revision: "bundled-authority" };
const session = createCertifiedSession(
  snapshot.revision,
  { grade: "R", level: 0, exp: 0 },
  [0, 0, 0],
);
const accepted = { snapshot, publication: { pointer: { statement: "s", signature: "x" } } };

// Invoke the hook against the mocked effect dispatcher to inspect its preparation effect.
type HookArgs = Parameters<typeof useCertifiedCalculatorPreparation>;
function PreparationHarness(props: {
  preparation: HookArgs[0];
  latest: HookArgs[1];
  retire: HookArgs[2];
}) {
  useCertifiedCalculatorPreparation(props.preparation, props.latest, props.retire, vi.fn(), {
    current: false,
  });
}

async function mount() {
  driver.effects = [];
  const preparation: Parameters<typeof useCertifiedCalculatorPreparation>[0] = {
    snapshot: null,
    setSnapshot: vi.fn(),
    prepareError: null,
    setPrepareError: vi.fn(),
    snapshotRef: { current: null },
  };
  const latest = {
    current: { session, correction: null, storageBlocked: false, modalBatch: null },
  } as Parameters<typeof useCertifiedCalculatorPreparation>[1];
  const retire = vi.fn();
  PreparationHarness({ preparation, latest, retire });
  const cleanup = driver.effects[0]?.();
  await import("../lib/runtimeForecast");
  for (let turn = 0; turn < 4; turn++) await Promise.resolve();
  return { preparation, retire, cleanup };
}
const lastError = (preparation: Awaited<ReturnType<typeof mount>>["preparation"]) =>
  vi.mocked(preparation.setPrepareError).mock.lastCall?.[0];

beforeEach(() => {
  vi.resetAllMocks();
  driver.listener = undefined;
  driver.prepare.mockResolvedValue(bundled);
  driver.watch.mockImplementation((_document, listener) => {
    driver.listener = listener;
    return () => {};
  });
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", {
    setInterval: (callback: () => void) => {
      driver.tick = callback;
      return 1;
    },
    clearInterval: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("staging runtime snapshot selection", () => {
  it("waits for the first check and fails closed without a verified publication", async () => {
    const { runtimeForecast: runtime } = await import("../lib/runtimeForecast");
    expect(stagingRuntimeSnapshot(undefined, "active", snapshot.asOf)).toBeNull();
    expect(stagingRuntimeSnapshot(runtime, "checking", snapshot.asOf)).toBeNull();
    expect(driver.peek).not.toHaveBeenCalled();
    driver.peek.mockReturnValue(null);
    for (const status of ["unavailable", "off"] as const)
      expect(() => stagingRuntimeSnapshot(runtime, status, snapshot.asOf)).toThrow(
        "forecast_unavailable",
      );
    driver.peek.mockReturnValue(accepted);
    expect(stagingRuntimeSnapshot(runtime, "active", snapshot.asOf)).toBe(snapshot);
  });
});

describe("staging calculator preparation", () => {
  beforeEach(() => vi.stubEnv("VITE_FORECAST_RUNTIME", "staging"));

  it("stays preparing while the first runtime check is pending, never touching the bundle", async () => {
    const { preparation } = await mount();
    driver.listener?.("checking");
    driver.tick?.();
    await Promise.resolve();
    expect(preparation.setSnapshot).not.toHaveBeenCalled();
    expect(preparation.setPrepareError).not.toHaveBeenCalled();
    expect(driver.prepare).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "off"] as const)(
    "shows the unavailable state for %s and never falls back to the bundled authority",
    async (status) => {
      driver.peek.mockReturnValue(null);
      const { preparation, retire } = await mount();
      driver.listener?.(status);
      driver.tick?.();
      await Promise.resolve();
      expect(lastError(preparation)).toBe("forecast_unavailable");
      expect(preparation.snapshotRef.current).toBeNull();
      expect(preparation.setSnapshot).not.toHaveBeenCalledWith(
        expect.objectContaining({ revision: bundled.revision }),
      );
      expect(retire).toHaveBeenCalled();
      expect(driver.prepare).not.toHaveBeenCalled();
    },
  );

  it("adopts an approved publication and clears it again when the publication is withdrawn", async () => {
    driver.peek.mockReturnValue(accepted);
    const { preparation } = await mount();
    driver.listener?.("active");
    expect(preparation.snapshotRef.current).toBe(snapshot);
    expect(lastError(preparation)).toBeNull();
    driver.peek.mockReturnValue(null);
    driver.listener?.("unavailable");
    await Promise.resolve();
    expect(preparation.snapshotRef.current).toBeNull();
    expect(preparation.setSnapshot).toHaveBeenLastCalledWith(null);
    expect(lastError(preparation)).toBe("forecast_unavailable");
    driver.peek.mockReturnValue(accepted);
    driver.listener?.("active");
    expect(preparation.snapshotRef.current).toBe(snapshot);
    expect(lastError(preparation)).toBeNull();
    expect(driver.prepare).not.toHaveBeenCalled();
  });

  it("clears the supply on any other staging preparation failure", async () => {
    driver.peek.mockImplementation(() => {
      throw new Error("view_failed");
    });
    const { preparation } = await mount();
    driver.listener?.("active");
    await Promise.resolve();
    expect(preparation.snapshotRef.current).toBeNull();
    expect(lastError(preparation)).toBe("preparation_failed");
    expect(driver.prepare).not.toHaveBeenCalled();
  });
});

describe("production calculator preparation", () => {
  it("keeps the bundled authority and never loads the runtime client", async () => {
    vi.stubEnv("VITE_FORECAST_RUNTIME", "");
    const { preparation } = await mount();
    expect(driver.prepare).toHaveBeenCalledOnce();
    expect(driver.watch).not.toHaveBeenCalled();
    expect(preparation.snapshotRef.current).toBe(bundled);
    expect(lastError(preparation)).toBeNull();
  });
});
