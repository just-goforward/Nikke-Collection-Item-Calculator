import { describe, expect, it, vi } from "vitest";
import { createFakeServer, createHarness, input } from "./accountTestHarness";
import { ACCOUNT_CHECK_TIMEOUT_MS, createAccountBootGate } from "./bootGate";
import { EMPTY_WORKSPACE_DOCUMENT, writeCalculatorInput } from "./workspaceDocument";

function manualGate(enabled: boolean) {
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const gate = createAccountBootGate(enabled, (callback, delayMs) =>
    timers.push({ callback, delayMs }),
  );
  return { gate, timers };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("page-load account gate", () => {
  it("never locks and schedules nothing with the flag off", () => {
    const { gate, timers } = manualGate(false);
    expect(gate.getSnapshot()).toBe("released");
    expect(timers).toEqual([]);
  });

  it("locks until released and ignores the timeout afterwards", () => {
    const { gate, timers } = manualGate(true);
    const listener = vi.fn();
    gate.subscribe(listener);
    expect(gate.getSnapshot()).toBe("checking");
    expect(timers.map((timer) => timer.delayMs)).toEqual([ACCOUNT_CHECK_TIMEOUT_MS]);
    gate.release();
    timers[0]?.callback();
    expect(gate.getSnapshot()).toBe("released");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("falls back after the 5 s bound and a late release changes nothing", () => {
    const { gate, timers } = manualGate(true);
    timers[0]?.callback();
    gate.release();
    expect(gate.getSnapshot()).toBe("timed-out");
  });
});

describe("account check timeout", () => {
  it("continues as guest with a notice; a late sign-in only asks for a reload", async () => {
    const slow = deferred();
    const server = createFakeServer({
      revision: 2,
      document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(40)),
      hold: { getAccount: slow.promise },
    });
    const harness = createHarness(server, { displayed: input(5) });
    const started = harness.controller.start();
    harness.controller.bootTimedOut();
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(harness.notice()).toBe("account_check_timeout");
    slow.resolve();
    await started;
    expect(harness.view()).toEqual({ phase: "stale", reason: "account_check_late" });
    // Account data never replaces what the user has been editing as a guest.
    expect(harness.applied).toEqual([]);
    expect(harness.displayed).toEqual(input(5));
  });

  it("a timeout while the workspace loads is handled the same way", async () => {
    const slow = deferred();
    const server = createFakeServer({ hold: { getWorkspace: slow.promise } });
    const harness = createHarness(server);
    const started = harness.controller.start();
    await vi.waitFor(() =>
      expect(server.calls.map((call) => call.method)).toContain("getWorkspace"),
    );
    harness.controller.bootTimedOut();
    slow.resolve();
    await started;
    expect(harness.view()).toEqual({ phase: "stale", reason: "account_check_late" });
  });

  it("a late guest answer keeps the guest view", async () => {
    const slow = deferred();
    const server = createFakeServer({ userId: null, hold: { getAccount: slow.promise } });
    const harness = createHarness(server);
    const started = harness.controller.start();
    harness.controller.bootTimedOut();
    slow.resolve();
    await started;
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
  });

  it("a timeout after the check resolved changes nothing", async () => {
    const harness = createHarness(createFakeServer({ revision: 1 }));
    await harness.controller.start();
    harness.controller.bootTimedOut();
    expect(harness.view()).toMatchObject({ phase: "signed-in" });
    expect(harness.notice()).toBeNull();
  });
});
