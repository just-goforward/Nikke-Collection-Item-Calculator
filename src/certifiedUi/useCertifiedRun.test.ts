import type { EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCertifiedSupplySnapshot,
  type CertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import { CertifiedRuntimeError } from "../certifiedRuntime/client";
import { createCertifiedSession } from "./session";
import { useCertifiedRun } from "./useCertifiedRun";

// A small hook driver exercises the real calculate closure without a browser or solver.
const driver = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as EffectCallback[],
  prepare: vi.fn(),
  request: vi.fn(),
  dispose: vi.fn(),
  create: vi.fn(),
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: EffectCallback) => driver.effects.push(effect),
  useRef: (initial: unknown) => {
    const index = driver.cursor++;
    driver.slots[index] ??= { current: initial };
    return driver.slots[index];
  },
  useState: (initial: unknown) => {
    const index = driver.cursor++;
    if (!(index in driver.slots)) driver.slots[index] = initial;
    return [
      driver.slots[index],
      (next: unknown) => {
        driver.slots[index] = next;
      },
    ];
  },
}));
vi.mock("../lib/certifiedForecast", () => ({ prepareCertifiedForecast: driver.prepare }));
vi.mock("../certifiedRuntime/browserClient", () => ({
  createBrowserCertifiedClient: driver.create,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (failure: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const snapshot = buildCertifiedSupplySnapshot({
  asOf: "2026-09-30T03:00:00Z",
  revision: "visibility-preparation",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
});
const session = createCertifiedSession(
  snapshot.revision,
  { grade: "R", level: 0, exp: 0 },
  [0, 0, 0],
);
let visibility: EventTarget & { visibilityState: DocumentVisibilityState };
let onSnapshot = vi.fn<(next: CertifiedSupplySnapshot) => void>();

// Invoke this harness against the mocked hook dispatcher to inspect the calculate closure.
function RunHarness(nextSession = session) {
  driver.cursor = 0;
  driver.effects = [];
  return useCertifiedRun(nextSession, snapshot, onSnapshot);
}
function change(state: DocumentVisibilityState) {
  visibility.visibilityState = state;
  visibility.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  driver.slots = [];
  vi.resetAllMocks();
  visibility = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  vi.stubGlobal("document", visibility);
  driver.create.mockReturnValue({ request: driver.request, dispose: driver.dispose });
  onSnapshot = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("submit-to-preparation visibility lifecycle", () => {
  it("cancels while preparation is unresolved, discards its late snapshot, and requires manual recompute", async () => {
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(pending.promise);
    const submitted = RunHarness().calculate();
    change("hidden");
    // Cancellation must settle without waiting for the outstanding forecast hash.
    await expect(
      Promise.race([
        submitted.then(() => "settled"),
        new Promise((done) => setTimeout(() => done("pending"), 40)),
      ]),
    ).resolves.toBe("settled");
    expect(RunHarness()).toMatchObject({ error: "background", busy: false, result: null });
    expect(driver.create).not.toHaveBeenCalled();
    change("visible");
    expect(driver.prepare).toHaveBeenCalledTimes(1);
    pending.resolve(snapshot);
    await submitted;
    expect(onSnapshot).not.toHaveBeenCalled();
    driver.prepare.mockResolvedValueOnce(snapshot);
    driver.request.mockRejectedValueOnce(new CertifiedRuntimeError("deadline", "deadline"));
    await RunHarness().calculate();
    expect(driver.request).toHaveBeenCalledOnce();
    expect(RunHarness().error).toBe("limit");
  });

  it("cancels initially hidden submit before preparing or creating a worker", async () => {
    change("hidden");
    await RunHarness().calculate();
    expect(RunHarness()).toMatchObject({ error: "background", busy: false });
    expect(driver.prepare).not.toHaveBeenCalled();
    expect(driver.create).not.toHaveBeenCalled();
  });

  it("reports cancellation between preparation settlement and the calculate continuation", async () => {
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(pending.promise);
    const submitted = RunHarness().calculate();
    pending.resolve(snapshot);
    await Promise.resolve();
    change("hidden");
    await submitted;
    expect(RunHarness()).toMatchObject({ busy: false, error: "background" });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(driver.create).not.toHaveBeenCalled();
  });

  it("does not let retired preparation overwrite a newer request", async () => {
    const old = deferred<CertifiedSupplySnapshot>();
    const newer = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const first = RunHarness().calculate();
    const second = RunHarness().calculate();
    old.resolve({ ...snapshot, revision: "stale" });
    await first;
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(RunHarness().busy).toBe(true);
    newer.resolve(snapshot);
    driver.request.mockRejectedValueOnce(new CertifiedRuntimeError("deadline", "deadline"));
    await second;
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
  });
});

describe("submit deadline during preparation", () => {
  it("keeps the submit deadline including preparation time", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(pending.promise);
    const submitted = RunHarness().calculate();
    clock.mockReturnValue(2100);
    pending.resolve(snapshot);
    driver.request.mockRejectedValueOnce(new CertifiedRuntimeError("deadline", "deadline"));
    await submitted;
    expect(driver.request.mock.calls[0]?.[1].totalDeadlineMs).toBe(13_000);
  });

  it("refuses computation when preparation has consumed the submit deadline", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(pending.promise);
    const submitted = RunHarness().calculate();
    clock.mockReturnValue(15_100);
    pending.resolve(snapshot);
    await submitted;
    expect(RunHarness().error).toBe("limit");
    expect(driver.create).not.toHaveBeenCalled();
  });

  it("times out unresolved preparation at the original submit deadline without resetting its budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockImplementationOnce(() => {
      clock.mockReturnValue(2100);
      return pending.promise;
    });
    const submitted = RunHarness().calculate();
    await vi.advanceTimersByTimeAsync(12_999);
    expect(RunHarness().busy).toBe(true);
    clock.mockReturnValue(15_100);
    await vi.advanceTimersByTimeAsync(1);
    expect(RunHarness()).toMatchObject({ busy: false, error: "limit", result: null });
    await submitted;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function));
    expect(driver.create).not.toHaveBeenCalled();
    pending.resolve(snapshot);
    await Promise.resolve();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("clears the preparation timer on actual visibility abort and observes a stale failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockReturnValue(100);
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(pending.promise);
    const submitted = RunHarness().calculate();
    await vi.advanceTimersByTimeAsync(14_999);
    change("hidden");
    await submitted;
    expect(RunHarness()).toMatchObject({ busy: false, error: "background" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    pending.reject(new Error("late_prepare_failure"));
    await Promise.resolve();
    expect(RunHarness().error).toBe("background");
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("clears the preparation timer and abort listener on normal preparation completion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(pending.promise);
    driver.request.mockRejectedValueOnce(new CertifiedRuntimeError("deadline", "deadline"));
    const submitted = RunHarness().calculate();
    expect(vi.getTimerCount()).toBe(1);
    pending.resolve(snapshot);
    await submitted;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function));
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
  });

  it("preserves preparation timeout when hidden follows the timeout before catch runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockReturnValue(100);
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(pending.promise);
    const submitted = RunHarness().calculate();
    vi.advanceTimersByTime(15_000);
    change("hidden");
    await Promise.resolve();
    expect(RunHarness()).toMatchObject({ busy: false, error: "limit" });
    await submitted;
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(snapshot);
    expect(driver.create).not.toHaveBeenCalled();
  });
});

describe("preparation retirement and retained current results", () => {
  it("keeps manual preparation cancellation silent and observes a late failure", async () => {
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(pending.promise);
    const run = RunHarness();
    const submitted = run.calculate();
    run.cancel();
    await submitted;
    pending.reject(new Error("late_prepare_failure"));
    await Promise.resolve();
    expect(RunHarness()).toMatchObject({ busy: false, error: false, result: null });
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("retires preparation on session changes and removes the visibility listener", async () => {
    const remove = vi.spyOn(visibility, "removeEventListener");
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(pending.promise);
    const submitted = RunHarness().calculate();
    RunHarness({ ...session, id: "updated" });
    driver.effects[0]?.();
    await submitted;
    expect(remove).toHaveBeenCalledOnce();
    change("hidden");
    pending.resolve(snapshot);
    expect(RunHarness()).toMatchObject({ busy: false, error: false });
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("retires preparation on unmount without creating a worker", async () => {
    const pending = deferred<CertifiedSupplySnapshot>();
    driver.prepare.mockReturnValueOnce(pending.promise);
    const submitted = RunHarness().calculate();
    const cleanup = driver.effects[1]?.();
    if (typeof cleanup !== "function") throw new Error("missing unmount effect");
    cleanup();
    await submitted;
    pending.resolve(snapshot);
    expect(driver.create).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("retains the completed current result for a cause-bound waiting abort", async () => {
    const current = { status: "complete", current: { probability: "exact" } };
    const partial = {
      ...current,
      status: "partial",
      refusal: { phase: "waiting", reason: "worker_abort" },
      waiting: { reason: "worker_abort" },
    };
    driver.prepare.mockResolvedValueOnce(snapshot);
    driver.request.mockImplementationOnce((_input, options) => {
      options.onCurrent(current);
      change("hidden");
      return Promise.resolve({ output: partial, timing: {}, memory: {} });
    });
    await RunHarness().calculate();
    expect(RunHarness()).toMatchObject({ result: partial, busy: false, error: "background" });
    change("visible");
    expect(driver.request).toHaveBeenCalledOnce();
  });

  it("keeps a preparation error's classification when hidden is only observed after it settles", async () => {
    driver.prepare.mockRejectedValueOnce(new Error("certified_total_deadline"));
    await RunHarness().calculate();
    change("hidden");
    expect(RunHarness().error).toBe("limit");
  });
});
