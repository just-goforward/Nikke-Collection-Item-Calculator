import { describe, expect, it, vi } from "vitest";
import type { SignedInView } from "./accountState";
import {
  createFakeServer,
  createHarness,
  failure,
  input,
  networkFailure,
} from "./accountTestHarness";
import {
  EMPTY_WORKSPACE_DOCUMENT,
  readCalculatorInput,
  writeCalculatorInput,
} from "./workspaceDocument";
import { createMemoryWorkspaceStore } from "./workspaceStore";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function signedIn(view: ReturnType<ReturnType<typeof createHarness>["view"]>): SignedInView {
  if (view.phase !== "signed-in") throw new Error(`Expected signed-in view, got ${view.phase}.`);
  return view;
}

async function storeWithRedirectGuest(blue: number) {
  const store = createMemoryWorkspaceStore();
  await store.writeGuest({
    document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(blue)),
    restoreOnReturn: true,
    updatedAt: 1,
  });
  return store;
}

describe("page-load account check timeout", () => {
  it("restores the inputs saved before sign-in before releasing, and a late answer changes nothing", async () => {
    const slow = deferred();
    const server = createFakeServer({ userId: null, hold: { getAccount: slow.promise } });
    const store = await storeWithRedirectGuest(73);
    const harness = createHarness(server, { store, displayed: input(5) });
    const started = harness.controller.start();
    await harness.controller.bootTimedOut(true);
    // Resolved only after the guest inputs are shown: the shell releases the lock after this.
    expect(harness.applied).toEqual([input(73)]);
    expect((await store.readGuest())?.restoreOnReturn).toBe(false);
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(harness.notice()).toBe("account_check_timeout");
    harness.edit(input(74));
    slow.resolve();
    await started;
    expect(harness.applied).toEqual([input(73)]);
    expect(harness.displayed).toEqual(input(74));
  });

  it("a late sign-in never replaces guest edits; it only asks for a reload", async () => {
    const slow = deferred();
    const server = createFakeServer({
      revision: 2,
      document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(40)),
      hold: { getAccount: slow.promise },
    });
    const harness = createHarness(server, { displayed: input(5) });
    const started = harness.controller.start();
    await harness.controller.bootTimedOut(true);
    harness.edit(input(6));
    slow.resolve();
    await started;
    expect(harness.view()).toEqual({ phase: "stale", reason: "account_check_late" });
    expect(harness.applied).toEqual([]);
    expect(harness.displayed).toEqual(input(6));
  });

  it("released before the chunk loaded: no restore over edits made since", async () => {
    const slow = deferred();
    const server = createFakeServer({ userId: null, hold: { getAccount: slow.promise } });
    const harness = createHarness(server, { store: await storeWithRedirectGuest(73) });
    const started = harness.controller.start();
    await harness.controller.bootTimedOut(false);
    slow.resolve();
    await started;
    expect(harness.applied).toEqual([]);
  });

  it("a timeout while the workspace loads is handled the same way", async () => {
    const slow = deferred();
    const server = createFakeServer({ hold: { getWorkspace: slow.promise } });
    const harness = createHarness(server);
    const started = harness.controller.start();
    await vi.waitFor(() =>
      expect(server.calls.map((call) => call.method)).toContain("getWorkspace"),
    );
    await harness.controller.bootTimedOut(true);
    slow.resolve();
    await started;
    expect(harness.view()).toEqual({ phase: "stale", reason: "account_check_late" });
  });

  it("a timeout after the check resolved changes nothing", async () => {
    const harness = createHarness(createFakeServer({ revision: 1 }));
    await harness.controller.start();
    await harness.controller.bootTimedOut(true);
    expect(harness.view()).toMatchObject({ phase: "signed-in" });
    expect(harness.notice()).toBeNull();
  });
});

describe("private reads bound to the shown account", () => {
  it("a session switched between the account and workspace reads shows and stores nothing", async () => {
    const server = createFakeServer({
      revision: 3,
      document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(40)),
    });
    // GET /v1/account answered for user-a; the cookie then belongs to user-b.
    server.beforeWorkspace = () => {
      server.userId = "user-b";
    };
    const harness = createHarness(server, { displayed: input(5) });
    await harness.controller.start();
    await harness.controller.whenIdle();
    expect(server.calls.find((call) => call.method === "getWorkspace")?.userId).toBe("user-a");
    expect(harness.view()).toEqual({ phase: "stale", reason: "context_stale" });
    expect(harness.applied).toEqual([]);
    expect(await harness.store.readDrafts("user-a")).toEqual([]);
    expect(await harness.store.readDrafts("user-b")).toEqual([]);
  });

  it("a later workspace read for another account marks the tab stale instead of applying it", async () => {
    const server = createFakeServer({
      revision: 1,
      document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(20)),
    });
    const harness = createHarness(server);
    await harness.controller.start();
    server.revision = 2;
    server.document = writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(50));
    harness.edit(input(31));
    await harness.runTimers();
    await harness.controller.resolveConflict("cancel");
    server.userId = "user-b";
    server.document = writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(99));
    await harness.controller.resumeSync();
    expect(harness.view()).toEqual({ phase: "stale", reason: "context_stale" });
    expect(harness.applied).not.toContainEqual(input(99));
    const draft = await harness.draft();
    expect(draft && readCalculatorInput(draft.document)).toEqual(input(31));
  });
});

describe("workspace unavailable after the account check", () => {
  it("shows guest data as 'account not loaded', retries with backoff and keeps guest edits", async () => {
    const server = createFakeServer({
      revision: 2,
      document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(40)),
    });
    server.overrides.getWorkspace = [failure(503, "service_unavailable"), networkFailure];
    const store = await storeWithRedirectGuest(73);
    const harness = createHarness(server, { store, displayed: input(1) });
    await harness.controller.start();
    expect(harness.view()).toEqual({
      phase: "unavailable",
      userId: "user-a",
    });
    expect(harness.notice()).toBe("account_unavailable");
    // The redirect's guest inputs are shown; nothing account-related is.
    expect(harness.applied).toEqual([input(73)]);
    expect(harness.pendingTimers().map((timer) => timer.delayMs)).toEqual([2_000]);
    harness.edit(input(74));

    await harness.runTimers(1);
    expect(harness.view()).toMatchObject({ phase: "unavailable" });
    expect(harness.pendingTimers().map((timer) => timer.delayMs)).toEqual([4_000]);
    await harness.runTimers(1);
    expect(signedIn(harness.view()).revision).toBe(2);
    expect(harness.displayed).toEqual(input(40));
    const guest = await store.readGuest();
    expect(guest && readCalculatorInput(guest.document)).toEqual(input(74));
    await harness.controller.logout();
    expect(harness.displayed).toEqual(input(74));
  });

  it("the online event (sync now) retries at once", async () => {
    const server = createFakeServer({ revision: 1 });
    server.overrides.getWorkspace = [networkFailure];
    const harness = createHarness(server);
    await harness.controller.start();
    expect(harness.view()).toMatchObject({ phase: "unavailable" });
    await harness.controller.syncNow();
    expect(harness.view()).toMatchObject({ phase: "signed-in" });
    expect(harness.pendingTimers()).toEqual([]);
  });

  it("a sign-out elsewhere while unavailable leaves the shown guest data alone", async () => {
    const server = createFakeServer({ revision: 1 });
    server.overrides.getWorkspace = [networkFailure];
    const harness = createHarness(server);
    await harness.controller.start();
    harness.edit(input(12));
    server.userId = null;
    await harness.controller.retryAccount();
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(harness.displayed).toEqual(input(12));
    expect(harness.pendingTimers()).toEqual([]);
  });
});
