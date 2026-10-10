import type { EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { CertifiedOutput } from "../certified/types";
import type { CertifiedCalculatorController } from "./calculatorController";
import {
  restoreCertifiedCalculatorSession,
  serializeCertifiedCalculatorSession,
} from "./calculatorSessionPersistence";
import {
  CERTIFIED_SESSION_STORAGE_KEY,
  type CertifiedSession,
  createCertifiedSession,
} from "./session";
import { useCertifiedCalculatorApp } from "./useCertifiedCalculatorApp";

type EffectSlot = { deps: readonly unknown[] | undefined; cleanup?: () => void };
const driver = vi.hoisted(() => ({
  slots: [] as unknown[],
  setters: [] as Array<((next: unknown) => void) | undefined>,
  cursor: 0,
  effects: [] as (() => void)[],
  dirty: false,
  prepare: vi.fn(),
  calculate: vi.fn(),
  cancel: vi.fn(),
  result: null as CertifiedOutput | null,
  busy: false,
  stored: new Map<string, string>(),
}));

// A dependency-aware hook dispatcher tests this bridge, not the runtime or presentation.
vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const index = driver.cursor++;
    if (!(index in driver.slots)) driver.slots[index] = { current: initial };
    return driver.slots[index];
  },
  useState: (initial: unknown) => {
    const index = driver.cursor++;
    if (!(index in driver.slots))
      driver.slots[index] = typeof initial === "function" ? initial() : initial;
    driver.setters[index] ??= (next: unknown) => {
      const value = typeof next === "function" ? next(driver.slots[index]) : next;
      if (!Object.is(value, driver.slots[index])) driver.dirty = true;
      driver.slots[index] = value;
    };
    return [driver.slots[index], driver.setters[index]];
  },
  useCallback: (callback: unknown, deps: readonly unknown[]) => {
    const index = driver.cursor++;
    const previous = driver.slots[index] as
      | { value: unknown; deps: readonly unknown[] }
      | undefined;
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i])))
      driver.slots[index] = { value: callback, deps };
    return (driver.slots[index] as { value: unknown }).value;
  },
  useMemo: (compute: () => unknown, deps: readonly unknown[]) => {
    const index = driver.cursor++;
    const previous = driver.slots[index] as
      | { value: unknown; deps: readonly unknown[] }
      | undefined;
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i])))
      driver.slots[index] = { value: compute(), deps };
    return (driver.slots[index] as { value: unknown }).value;
  },
  useEffect: (effect: EffectCallback, deps?: readonly unknown[]) => {
    const index = driver.cursor++;
    const previous = driver.slots[index] as EffectSlot | undefined;
    if (!previous || !deps || deps.some((dep, i) => !Object.is(dep, previous.deps?.[i]))) {
      const slot: EffectSlot = { deps };
      driver.slots[index] = slot;
      driver.effects.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        if (typeof cleanup === "function") slot.cleanup = cleanup;
      });
    }
  },
}));
vi.mock("../lib/certifiedForecast", () => ({ prepareCertifiedForecast: driver.prepare }));
vi.mock("./useCertifiedRun", () => ({
  useCertifiedRun: (session: CertifiedSession) => ({
    result: driver.result,
    finished: null,
    busy: driver.busy,
    error: false,
    calculate: () => driver.calculate(session),
    cancel: driver.cancel,
  }),
}));

const snapshot = buildCertifiedSupplySnapshot({
  asOf: "2026-09-30T03:00:00Z",
  revision: "approved",
  sourceHash: "a".repeat(64),
  soloPeriods: [],
  collaborationPeriods: [],
});
let app: CertifiedCalculatorController;
let visibility: { visibilityState: DocumentVisibilityState };
function CalculatorHarness() {
  driver.cursor = 0;
  driver.effects = [];
  driver.dirty = false;
  return useCertifiedCalculatorApp();
}
function render() {
  app = CalculatorHarness();
  for (const effect of driver.effects) effect();
  return app;
}
function storedSessionText() {
  const text = driver.stored.get(CERTIFIED_SESSION_STORAGE_KEY);
  if (text === undefined) throw new Error("missing_certified_session_fixture");
  return text;
}
async function flush() {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve();
    render();
  }
}
async function reload() {
  for (const slot of driver.slots) {
    if (slot && typeof slot === "object" && "cleanup" in slot) (slot as EffectSlot).cleanup?.();
  }
  driver.slots = [];
  driver.setters = [];
  driver.result = null;
  driver.busy = false;
  driver.calculate.mockClear();
  render();
  await flush();
}
function sessionFixture() {
  const session = createCertifiedSession(
    "approved",
    { grade: "SR", level: 2, exp: 0 },
    [79, 13, 7],
  );
  return {
    ...session,
    cohortWeights: [
      { numerator: "1", denominator: "2" },
      { numerator: "1", denominator: "3" },
      { numerator: "1", denominator: "6" },
    ] as const,
    receipts: [
      {
        eventId: "actual-receipt",
        at: "2026-09-30T02:00:00Z",
        pieces: [3, 0, 0] as const,
        alreadyInStock: true,
      },
    ],
    retiredReceiptIds: ["actual-receipt"],
  };
}
function installRecommendation(uses = 4) {
  // Only the native current action fields read by this bridge are relevant to these tests.
  driver.result = {
    current: { status: "use_certified", kit: "blue", uses },
  } as CertifiedOutput;
  render();
}
async function authorize(uses = 4) {
  await app.actions.calculate();
  installRecommendation(uses);
}

beforeEach(async () => {
  driver.slots = [];
  driver.setters = [];
  driver.stored.clear();
  driver.result = null;
  driver.busy = false;
  vi.resetAllMocks();
  driver.prepare.mockResolvedValue(snapshot);
  driver.calculate.mockResolvedValue(undefined);
  driver.stored.set(CERTIFIED_SESSION_STORAGE_KEY, JSON.stringify(sessionFixture()));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => driver.stored.get(key) ?? null,
    setItem: (key: string, value: string) => driver.stored.set(key, value),
  });
  vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
  visibility = { visibilityState: "visible" };
  vi.stubGlobal("document", visibility);
  render();
  await flush();
});
afterEach(() => {
  for (const slot of driver.slots) {
    if (slot && typeof slot === "object" && "cleanup" in slot) (slot as EffectSlot).cleanup?.();
  }
  vi.unstubAllGlobals();
});

describe("certified inputs and action authorization", () => {
  it("allows waiting calculations without usable stock and keeps raw remainders", async () => {
    app.actions.setStock({ blue: 9, purple: 3, yellow: 7 });
    await flush();
    expect(app.stock).toEqual({ blue: 9, purple: 3, yellow: 7 });
    expect(app.calculateDisabled).toBe(false);
    await app.actions.calculate();
    expect(driver.calculate.mock.lastCall?.[0].stock).toEqual([9, 3, 7]);
  });

  it("recomputes a committed batch with the latest native session, not the old render closure", async () => {
    await authorize();
    const old = app;
    driver.calculate.mockClear();
    app.actions.applyOutcome("normal");
    expect(driver.calculate).not.toHaveBeenCalled();
    // A second action in the same tick cannot reuse the retired authorization.
    old.actions.applyOutcome("normal");
    await flush();
    expect(app.session.stock).toEqual([39, 13, 7]);
    expect(app.session.outcomes).toHaveLength(4);
    expect(driver.calculate).toHaveBeenCalledOnce();
    expect(driver.calculate.mock.lastCall?.[0]).toEqual(app.session);
    expect(driver.calculate.mock.lastCall?.[0]).not.toBe(old.session);
  });

  it("retires stale authorization synchronously for input edits and receipt updates", async () => {
    await authorize();
    const old = app;
    app.updateSession((session) => ({
      ...session,
      receipts: [
        ...session.receipts,
        {
          eventId: "acknowledged-by-user",
          at: "2026-09-30T04:00:00Z",
          pieces: null,
          alreadyInStock: true,
        },
      ],
    }));
    old.actions.applyOutcome("normal");
    await flush();
    expect(app.session.stock).toEqual([79, 13, 7]);
    expect(app.session.outcomes).toEqual([]);
    expect(app.run.result).toBeNull();
    await authorize();
    app.actions.setExp(100);
    app.actions.applyOutcome("normal");
    await flush();
    expect(app.session.state.exp).toBe(100);
    expect(app.session.outcomes).toEqual([]);
  });
});

describe("certified outcomes and full session undo", () => {
  it("uses the modal attempt and consumes only through the reported great success", async () => {
    await authorize();
    app.actions.applyOutcome("great");
    await flush();
    expect(app.modal).toMatchObject({
      open: true,
      maxAttempt: 4,
      kit: "blue",
      beforeStock: 79,
    });
    expect(app.session.stock).toEqual([79, 13, 7]);
    app.actions.submitSuccessAttempt(2);
    await flush();
    expect(app.session.stock).toEqual([59, 13, 7]);
    expect(app.session.outcomes.map((entry) => entry.outcome)).toEqual(["normal", "great"]);
    expect(app.modal.open).toBe(false);
    expect(driver.calculate.mock.lastCall?.[0]).toEqual(app.session);
  });

  it("blocks unknown consumption until an actual valid deduction reconciles the native ledger", async () => {
    await authorize();
    const before = app.session;
    app.actions.applyOutcome("great");
    render();
    app.actions.submitSuccessAttempt(null);
    await flush();
    expect(app.stockCorrectionRequired).toBe(true);
    expect(app.stockCorrection).toMatchObject({ status: "invalid", reason: "unchanged" });
    expect(app.calculateDisabled).toBe(true);
    expect(app.session.stock).toEqual(before.stock);
    expect(app.session.outcomes).toEqual([]);
    expect(restoreCertifiedCalculatorSession(storedSessionText())).toMatchObject({
      session: app.session,
      correction: { before },
    });
    driver.calculate.mockClear();
    await app.actions.calculate();
    app.actions.applyOutcome("normal");
    app.actions.convert();
    app.actions.setStock({ blue: 48, purple: 13, yellow: 7 });
    await flush();
    expect(app.stockCorrection?.reason).toBe("invalid_delta");
    expect(driver.calculate).not.toHaveBeenCalled();
    app.actions.setStock({ blue: 49, purple: 13, yellow: 7 });
    await flush();
    expect(app.stockCorrectionRequired).toBe(true);
    expect(app.stockCorrection).toMatchObject({ status: "valid", successAttempt: 3 });
    expect(app.calculateDisabled).toBe(false);
    expect(app.session.outcomes).toEqual([]);
    expect(driver.calculate).not.toHaveBeenCalled();
    await app.actions.calculate();
    await flush();
    expect(app.stockCorrectionRequired).toBe(false);
    expect(app.session.stock).toEqual([49, 13, 7]);
    expect(app.session.outcomes.map((entry) => entry.outcome)).toEqual([
      "normal",
      "normal",
      "great",
    ]);
    expect(app.session.receipts).toEqual(before.receipts);
    expect(app.session.cohortWeights).toEqual(before.cohortWeights);
    expect(driver.calculate).toHaveBeenCalledExactlyOnceWith(app.session);
  });

  it("reset undo restores the complete session and unresolved correction, without restarting", async () => {
    await authorize();
    app.actions.applyOutcome("great");
    render();
    app.actions.submitSuccessAttempt(null);
    app.actions.setStock({ blue: 48, purple: 13, yellow: 7 });
    await flush();
    const previous = app;
    const undo = app.actions.reset();
    await flush();
    expect(app.session.stock).toEqual([0, 0, 0]);
    expect(app.session.receipts).toEqual([]);
    expect(app.stockCorrectionRequired).toBe(false);
    driver.calculate.mockClear();
    undo();
    await flush();
    expect(app.session).toEqual(previous.session);
    expect(app.stockCorrection).toEqual(previous.stockCorrection);
    expect(app.session.receipts).toEqual(sessionFixture().receipts);
    expect(app.session.cohortWeights).toEqual(sessionFixture().cohortWeights);
    expect(app.run.result).toBeNull();
    expect(driver.calculate).not.toHaveBeenCalled();
  });

  it("uses native R15 conversion and recomputes from its committed SR5 state", async () => {
    app.updateSession((session) => ({ ...session, state: { grade: "R", level: 15, exp: 0 } }));
    await flush();
    const before = app.session;
    driver.calculate.mockClear();
    app.actions.convert();
    await flush();
    expect(app.session.state).toEqual({ grade: "SR", level: 5, exp: 0 });
    expect(app.session.stock).toEqual(before.stock);
    expect(app.session.receipts).toEqual(before.receipts);
    expect(driver.calculate).toHaveBeenCalledExactlyOnceWith(app.session);
  });

  it("undo also restores settled outcome entries, receipts, and cohort weights", async () => {
    await authorize();
    app.actions.applyOutcome("normal");
    await flush();
    const previous = app.session;
    expect(previous.outcomes).toHaveLength(4);
    const undo = app.actions.reset();
    await flush();
    undo();
    await flush();
    expect(app.session).toEqual(previous);
    expect(app.session.outcomes).toEqual(previous.outcomes);
    expect(app.session.retiredReceiptIds).toEqual(previous.retiredReceiptIds);
  });
});

describe("certified cancellation and invalid input retirement", () => {
  it("cancellation and a hidden committed action never restart on background return", async () => {
    await authorize();
    driver.calculate.mockClear();
    app.actions.applyOutcome("normal");
    app.run.cancel();
    await flush();
    expect(driver.calculate).not.toHaveBeenCalled();
    await authorize();
    driver.calculate.mockClear();
    visibility.visibilityState = "hidden";
    app.actions.applyOutcome("normal");
    await flush();
    visibility.visibilityState = "visible";
    await flush();
    expect(driver.calculate).not.toHaveBeenCalled();
  });

  it("rejects invalid sessions instead of persisting or authorizing them", async () => {
    await authorize();
    const before = app.session;
    app.updateSession((session) => ({ ...session, stock: [-1, 0, 0] }));
    app.actions.applyOutcome("normal");
    await flush();
    expect(app.session).toEqual(before);
    expect(JSON.parse(storedSessionText())).toEqual(before);
    expect(app.run.result).toBeNull();
  });
});

describe("certified pending correction reload and confirmation", () => {
  it.each([
    { phase: "awaiting attempt", stock: null, reason: "unchanged" },
    { phase: "unknown attempt", stock: { blue: 79, purple: 13, yellow: 7 }, reason: "unchanged" },
    { phase: "entered stock", stock: { blue: 48, purple: 13, yellow: 7 }, reason: "invalid_delta" },
  ])(
    "reload retains $phase with a pending $reason correction and blocks duplicate use",
    async ({ phase, stock, reason }) => {
      await authorize();
      const before = app.session;
      app.actions.applyOutcome("great");
      render();
      if (phase !== "awaiting attempt") app.actions.submitSuccessAttempt(null);
      if (stock) app.actions.setStock(stock);
      await flush();
      const observed = app.session;
      const persisted = storedSessionText();
      await reload();
      expect(app.session).toEqual(observed);
      expect(app.session.state).toEqual({ grade: "SR", level: 5, exp: 0 });
      expect(app.session.receipts).toEqual(before.receipts);
      expect(app.session.cohortWeights).toEqual(before.cohortWeights);
      expect(app.session.outcomes).toEqual(before.outcomes);
      expect(app.stockCorrectionRequired).toBe(true);
      expect(app.stockCorrection).toMatchObject({ status: "invalid", reason });
      expect(app.calculateDisabled).toBe(true);
      expect(app.run.result).toBeNull();
      await app.actions.calculate();
      installRecommendation();
      app.actions.applyOutcome("normal");
      app.actions.convert();
      await flush();
      expect(driver.calculate).not.toHaveBeenCalled();
      expect(app.session).toEqual(observed);
      const undo = app.actions.reset();
      await flush();
      undo();
      await flush();
      expect(driver.stored.get(CERTIFIED_SESSION_STORAGE_KEY)).toBe(persisted);
      await reload();
      expect(app.session).toEqual(observed);
      expect(app.stockCorrectionRequired).toBe(true);
      app.actions.setStock({ blue: 49, purple: 13, yellow: 7 });
      await flush();
      expect(app.stockCorrectionRequired).toBe(true);
      expect(app.stockCorrection).toMatchObject({ status: "valid", successAttempt: 3 });
      expect(app.calculateDisabled).toBe(false);
      expect(app.session.outcomes).toEqual(before.outcomes);
      expect(driver.calculate).not.toHaveBeenCalled();
      await app.actions.calculate();
      await flush();
      expect(app.session.stock).toEqual([49, 13, 7]);
      expect(app.session.outcomes.map((entry) => entry.outcome)).toEqual([
        "normal",
        "normal",
        "great",
      ]);
      expect(app.session.receipts).toEqual(before.receipts);
      expect(app.session.cohortWeights).toEqual(before.cohortWeights);
      expect(app.stockCorrectionRequired).toBe(false);
      expect(JSON.parse(storedSessionText())).toEqual(app.session);
      expect(driver.calculate).toHaveBeenCalledExactlyOnceWith(app.session);
    },
  );

  it("keeps transient deductions pending through reload and confirms only the final stock", async () => {
    app.updateSession((session) => ({
      ...session,
      state: { grade: "SR", level: 0, exp: 0 },
      stock: [100, 0, 0],
    }));
    await flush();
    const before = app.session;
    await authorize(10);
    app.actions.applyOutcome("great");
    render();
    app.actions.submitSuccessAttempt(null);
    await flush();
    driver.calculate.mockClear();

    const entries = [10, 1, 0, 9, 90];
    const confirmable = [true, false, true, false, true];
    for (const [index, pieces] of entries.entries()) {
      app.actions.setStock({ blue: pieces, purple: 0, yellow: 0 });
      await flush();
      expect(app.session.stock).toEqual([pieces, 0, 0]);
      expect(app.session.state).toEqual({ grade: "SR", level: 5, exp: 0 });
      expect(app.session.outcomes).toEqual([]);
      expect(app.session.receipts).toEqual(before.receipts);
      expect(app.session.cohortWeights).toEqual(before.cohortWeights);
      expect(app.stockCorrectionRequired).toBe(true);
      expect(app.stockCorrection?.canCalculate).toBe(confirmable[index]);
      expect(app.calculateDisabled).toBe(!confirmable[index]);
      if (!confirmable[index]) {
        await app.actions.calculate();
        await flush();
        expect(app.session.outcomes).toEqual([]);
        expect(app.stockCorrectionRequired).toBe(true);
      }
      expect(driver.calculate).not.toHaveBeenCalled();
    }

    const entered = app.session;
    await reload();
    expect(app.session).toEqual(entered);
    expect(app.stockCorrectionRequired).toBe(true);
    expect(app.stockCorrection).toMatchObject({
      status: "valid",
      successAttempt: 1,
      canCalculate: true,
    });
    expect(app.calculateDisabled).toBe(false);
    expect(app.session.outcomes).toEqual([]);
    expect(driver.calculate).not.toHaveBeenCalled();

    await app.actions.calculate();
    // A second click before the committed render cannot reuse the correction.
    await app.actions.calculate();
    expect(driver.calculate).not.toHaveBeenCalled();
    await flush();
    expect(app.stockCorrectionRequired).toBe(false);
    expect(app.session.stock).toEqual([90, 0, 0]);
    expect(before.stock[0] - app.session.stock[0]).toBe(10);
    expect(app.session.outcomes).toHaveLength(1);
    expect(app.session.outcomes[0]).toMatchObject({
      kit: "blue",
      outcome: "great",
      before: { grade: "SR", level: 0, exp: 0 },
      after: { grade: "SR", level: 5, exp: 0 },
    });
    expect(app.session.receipts).toEqual(before.receipts);
    expect(app.session.cohortWeights).toEqual(before.cohortWeights);
    expect(driver.calculate).toHaveBeenCalledExactlyOnceWith(app.session);
  });
});

describe("certified stock draft identity", () => {
  it("keeps the returned stock identity stable across unrelated renders and state edits", async () => {
    const stock = app.stock;
    render();
    expect(app.stock).toBe(stock);
    app.actions.applyOutcome("normal");
    await flush();
    expect(app.actionError).toBe("certified_action_not_authorized");
    expect(app.stock).toBe(stock);
    app.actions.setExp(100);
    await flush();
    expect(app.stock).toBe(stock);
    app.actions.setStock({ blue: 78, purple: 13, yellow: 7 });
    await flush();
    expect(app.stock).not.toBe(stock);
  });
});

describe("certified malformed storage recovery", () => {
  it.each([
    { name: "missing correction", patch: { correction: null } },
    { name: "invalid version", patch: { version: 2 } },
    { name: "invalid kit", batchPatch: { kit: "unknown" } },
    { name: "invalid use count", batchPatch: { uses: 11 } },
    { name: "invalid timestamp", batchPatch: { at: "not-a-time" } },
    { name: "invalid pre-outcome stock", beforePatch: { stock: [-1, 0, 0] } },
    {
      name: "pre-outcome state restored as observed",
      sessionPatch: { state: { grade: "SR", level: 2, exp: 0 } },
    },
    { name: "changed receipts", sessionPatch: { receipts: [] } },
    {
      name: "changed cohort weights",
      sessionPatch: {
        cohortWeights: [
          { numerator: "1", denominator: "3" },
          { numerator: "1", denominator: "3" },
          { numerator: "1", denominator: "3" },
        ],
      },
    },
  ])("fails closed on malformed pending data: $name", async (fixture) => {
    const before = app.session;
    const saved = JSON.parse(
      serializeCertifiedCalculatorSession(
        { ...before, state: { grade: "SR", level: 5, exp: 0 } },
        { before, kit: "blue", uses: 4, at: "2026-09-30T04:00:00Z" },
      ),
    );
    const text = JSON.stringify({
      ...saved,
      ...fixture.patch,
      ...(fixture.batchPatch ? { correction: { ...saved.correction, ...fixture.batchPatch } } : {}),
      ...(fixture.beforePatch
        ? {
            correction: {
              ...saved.correction,
              before: { ...before, ...fixture.beforePatch },
            },
          }
        : {}),
      ...(fixture.sessionPatch ? { session: { ...saved.session, ...fixture.sessionPatch } } : {}),
    });
    driver.stored.set(CERTIFIED_SESSION_STORAGE_KEY, text);
    await reload();
    expect(app.actionError).toBe("invalid_certified_calculator_storage");
    expect(app.calculateDisabled).toBe(true);
    expect(app.stockCorrectionRequired).toBe(true);
    expect(app.session.outcomes).toEqual([]);
    expect(driver.stored.get(CERTIFIED_SESSION_STORAGE_KEY)).toBe(text);
    await app.actions.calculate();
    installRecommendation();
    app.actions.applyOutcome("normal");
    app.actions.setStock({ blue: 79, purple: 13, yellow: 7 });
    app.actions.setExp(100);
    app.updateSession(before);
    app.actions.convert();
    await flush();
    expect(driver.calculate).not.toHaveBeenCalled();
    expect(app.calculateDisabled).toBe(true);
    expect(app.session.outcomes).toEqual([]);
    expect(driver.stored.get(CERTIFIED_SESSION_STORAGE_KEY)).toBe(text);
    app.actions.reset();
    await flush();
    await reload();
    expect(app.stockCorrectionRequired).toBe(false);
    expect(app.calculateDisabled).toBe(false);
  });

  it.each([
    ' \n{"kind":"certified_pending_stock_correction","version":1,',
    ' \n{"kind":"certified_pending_stock_correction","version":1,"correction":null,"unreadable":"대성공"}\n ',
    "",
  ])(
    "reset undo restores exact malformed storage and remains blocked on reload: %j",
    async (text) => {
      driver.stored.set(CERTIFIED_SESSION_STORAGE_KEY, text);
      driver.prepare.mockResolvedValue({ ...snapshot, revision: "new-approved-revision" });
      await reload();
      const blocked = app.session;
      expect(app.storageBlocked).toBe(true);
      expect(app.actionError).toBe("invalid_certified_calculator_storage");
      expect(app.snapshot?.revision).toBe("new-approved-revision");
      expect(app.session.snapshotRevision).toBe("initial");
      expect(driver.stored.get(CERTIFIED_SESSION_STORAGE_KEY)).toBe(text);

      const undo = app.actions.reset();
      await flush();
      expect(app.storageBlocked).toBe(false);
      expect(app.calculateDisabled).toBe(false);
      expect(JSON.parse(storedSessionText())).toEqual(app.session);

      undo();
      expect(driver.stored.get(CERTIFIED_SESSION_STORAGE_KEY)).toBe(text);
      await flush();
      expect(app.storageBlocked).toBe(true);
      expect(app.session).toEqual(blocked);
      expect(app.actionError).toBe("invalid_certified_calculator_storage");
      expect(app.calculateDisabled).toBe(true);
      expect(driver.stored.get(CERTIFIED_SESSION_STORAGE_KEY)).toBe(text);

      await reload();
      expect(app.storageBlocked).toBe(true);
      expect(app.actionError).toBe("invalid_certified_calculator_storage");
      expect(app.calculateDisabled).toBe(true);
      expect(app.session.outcomes).toEqual([]);
      expect(driver.stored.get(CERTIFIED_SESSION_STORAGE_KEY)).toBe(text);
      await app.actions.calculate();
      expect(driver.calculate).not.toHaveBeenCalled();
    },
  );
});
