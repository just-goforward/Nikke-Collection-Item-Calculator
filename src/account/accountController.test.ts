import { describe, expect, it } from "vitest";
import type { WorkspacePut } from "../../personal-data/src/contracts";
import type { SignedInView } from "./accountState";
import {
  createFakeServer,
  createHarness,
  input,
  networkFailure,
  recordingChannel,
} from "./accountTestHarness";
import {
  DEFAULT_CALCULATOR_INPUT,
  EMPTY_WORKSPACE_DOCUMENT,
  readCalculatorInput,
  writeCalculatorInput,
} from "./workspaceDocument";
import { createMemoryWorkspaceStore } from "./workspaceStore";

const FOREIGN_ITEM = { type: "certified-session", version: 1, text: "kept" };
const STAGE = {
  itemId: "item-1",
  stage: "stage-1",
  lifetimeAttempts: 3,
  lifetimeIncome: 40,
  preSignupIncome: 10,
  manualEntry: true,
  verified: false,
};

function serverDocument(blue: number) {
  return writeCalculatorInput(
    { schemaVersion: 1, items: [FOREIGN_ITEM], lifetimeStages: [STAGE] },
    input(blue),
  );
}

function signedIn(view: ReturnType<ReturnType<typeof createHarness>["view"]>): SignedInView {
  if (view.phase !== "signed-in") throw new Error(`Expected signed-in view, got ${view.phase}.`);
  return view;
}

function puts(server: ReturnType<typeof createFakeServer>) {
  return server.calls.filter((call) => call.method === "putWorkspace");
}

describe("account boot and guest separation", () => {
  it("keeps guests untouched when there is no session", async () => {
    const server = createFakeServer({ userId: null });
    const harness = createHarness(server);
    await harness.controller.start();
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(harness.applied).toEqual([]);
    expect(harness.notice()).toBeNull();
  });

  it("stores guest inputs before Google sign-in and restores them if sign-in is abandoned", async () => {
    const server = createFakeServer({ userId: null });
    const store = createMemoryWorkspaceStore();
    const first = createHarness(server, { store, displayed: input(73) });
    await first.controller.start();
    await first.controller.login();
    expect(first.navigations).toEqual([server.authorizationUrl]);
    expect((await store.readGuest())?.restoreOnReturn).toBe(true);

    const returned = createHarness(server, { store });
    await returned.controller.start();
    expect(returned.applied).toEqual([input(73)]);
    expect((await store.readGuest())?.restoreOnReturn).toBe(false);
  });

  it("refuses to follow an authorization URL outside Google", async () => {
    const server = createFakeServer({
      userId: null,
      authorizationUrl: "https://accounts.google.com.evil.example/auth",
    });
    const harness = createHarness(server);
    await harness.controller.start();
    await harness.controller.login();
    expect(harness.navigations).toEqual([]);
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(harness.notice()).toBe("login_failed");
  });

  it("shows server inputs after sign-in without touching the stored guest copy", async () => {
    const server = createFakeServer({ revision: 4, document: serverDocument(20) });
    const store = createMemoryWorkspaceStore();
    await store.writeGuest({
      document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(73)),
      restoreOnReturn: true,
      updatedAt: 1,
    });
    const harness = createHarness(server, { store });
    await harness.controller.start();
    expect(harness.applied).toEqual([input(20)]);
    expect(signedIn(harness.view()).revision).toBe(4);
    const guest = await store.readGuest();
    expect(guest && readCalculatorInput(guest.document)).toEqual(input(73));
    expect(guest?.restoreOnReturn).toBe(false);
    // A synced account keeps no device copy.
    expect(await harness.draft()).toBeNull();
  });

  it("returns to guest inputs on logout, drops the clean account copy and tells other tabs", async () => {
    const server = createFakeServer({ revision: 1, document: serverDocument(20) });
    const store = createMemoryWorkspaceStore();
    await store.writeGuest({
      document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(73)),
      restoreOnReturn: false,
      updatedAt: 1,
    });
    const channel = recordingChannel();
    const harness = createHarness(server, { store, channel });
    await harness.controller.start();
    await harness.controller.logout();
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(harness.displayed).toEqual(input(73));
    expect(await store.readDrafts("user-a")).toEqual([]);
    expect(channel.posted).toContainEqual({ type: "logged-out", userId: "user-a" });
    expect(harness.notice()).toBe("logged_out");
  });

  it("never leaves account inputs on screen for a guest without saved guest data", async () => {
    const server = createFakeServer({ revision: 1, document: serverDocument(20) });
    const harness = createHarness(server);
    await harness.controller.start();
    await harness.controller.logout();
    expect(harness.displayed).toEqual(DEFAULT_CALCULATOR_INPUT);
  });
});

describe("workspace sync", () => {
  it("saves edits with opId, base revision, account context and preserved foreign data", async () => {
    const server = createFakeServer({ revision: 4, document: serverDocument(20) });
    const harness = createHarness(server);
    await harness.controller.start();
    await harness.controller.whenIdle();
    expect(puts(server)).toEqual([]);

    harness.edit(input(31));
    expect(signedIn(harness.view()).sync).toBe("pending");
    await harness.runTimers();
    const [save] = puts(server);
    const body = save?.body as WorkspacePut;
    expect(save?.userId).toBe("user-a");
    expect(body).toMatchObject({ opId: "op-1", baseRevision: 4, action: { kind: "save" } });
    expect(body.document.items).toContainEqual(FOREIGN_ITEM);
    expect(body.document.lifetimeStages).toEqual([STAGE]);
    expect(readCalculatorInput(body.document)).toEqual(input(31));
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 5 });
    expect(await harness.draft()).toBeNull();
  });

  it("keeps an edit made during a save pending and sends it next on the new revision", async () => {
    const server = createFakeServer({ revision: 2, document: serverDocument(20) });
    const harness = createHarness(server);
    await harness.controller.start();
    harness.edit(input(21));
    server.beforePut = () => {
      server.beforePut = undefined;
      harness.edit(input(22));
    };
    await harness.runTimers();
    const bodies = puts(server).map((call) => call.body as WorkspacePut);
    expect(bodies.map((body) => [body.baseRevision, readCalculatorInput(body.document)])).toEqual([
      [2, input(21)],
      [3, input(22)],
    ]);
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 4 });
  });

  it("retries a lost save with the same opId and body so the server can replay it", async () => {
    const server = createFakeServer({ revision: 0 });
    const harness = createHarness(server);
    await harness.controller.start();
    harness.edit(input(5));
    server.overrides.putWorkspace = [networkFailure];
    await harness.runTimers(1);
    expect(signedIn(harness.view()).sync).toBe("offline");
    expect(harness.pendingTimers().map((timer) => timer.delayMs)).toEqual([2_000]);
    await harness.runTimers();
    const [lost, retried] = puts(server).map((call) => call.body as WorkspacePut);
    expect(retried).toEqual(lost);
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 1 });
  });

  it("does not let a replayed acknowledgement overwrite newer local edits", async () => {
    const server = createFakeServer({ revision: 0 });
    const harness = createHarness(server);
    await harness.controller.start();
    harness.edit(input(5));
    server.overrides.putWorkspace = [
      { ok: true, status: 200, value: { status: "saved", revision: 1, replayed: true } },
    ];
    server.beforePut = () => {
      server.beforePut = undefined;
      harness.edit(input(6));
    };
    await harness.runTimers(1);
    expect(harness.displayed).toEqual(input(6));
    expect(signedIn(harness.view())).toMatchObject({ sync: "pending", revision: 1 });
  });

  it("surfaces quota and the archiving-blocked state while keeping data", async () => {
    const server = createFakeServer({
      quota: { bytes: 1_500_000, limitBytes: 1_500_000, newArchivingBlocked: true },
    });
    const harness = createHarness(server);
    await harness.controller.start();
    expect(signedIn(harness.view())).toMatchObject({
      archivingBlocked: true,
      quota: { bytes: 1_500_000, limitBytes: 1_500_000 },
    });
    server.overrides.putWorkspace = [
      { ok: true, status: 422, value: { status: "archive_quota_reached", revision: 0 } },
    ];
    harness.edit(input(9));
    await harness.runTimers(1);
    expect(harness.notice()).toBe("archive_quota_reached");
    expect(harness.displayed).toEqual(input(9));
  });

  it("pushes unsynced edits from an earlier visit when the server has not moved", async () => {
    const server = createFakeServer({ revision: 4, document: serverDocument(20) });
    const store = createMemoryWorkspaceStore();
    await store.writeDraft({
      userId: "user-a",
      draftId: "closed-tab",
      baseRevision: 4,
      document: serverDocument(44),
      updatedAt: 1,
    });
    const harness = createHarness(server, { store });
    await harness.controller.start();
    expect(harness.displayed).toEqual(input(44));
    expect(readCalculatorInput(server.document)).toEqual(input(44));
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 5 });
  });

  it("asks before replacing newer server data with unsynced edits from an earlier visit", async () => {
    const server = createFakeServer({ revision: 6, document: serverDocument(20) });
    const store = createMemoryWorkspaceStore();
    await store.writeDraft({
      userId: "user-a",
      draftId: "closed-tab",
      baseRevision: 4,
      document: serverDocument(44),
      updatedAt: 1,
    });
    const harness = createHarness(server, { store });
    await harness.controller.start();
    expect(puts(server)).toEqual([]);
    expect(signedIn(harness.view()).conflict).toEqual({
      serverRevision: 6,
      server: input(20),
      local: input(44),
      serverBytes: null,
      localBytes: null,
      serverUnreadable: false,
    });
    // Cancelling and resuming, or reloading, still asks: the stored base revision is kept.
    await harness.controller.resolveConflict("cancel");
    await harness.controller.resumeSync();
    expect(signedIn(harness.view()).sync).toBe("conflict");
    // Recovered into this tab's draft, still on its original base revision.
    expect(await store.readDrafts("user-a")).toEqual([
      expect.objectContaining({ draftId: harness.tab.id, baseRevision: 4 }),
    ]);
    const reloaded = createHarness(server, { store });
    await reloaded.controller.start();
    expect(signedIn(reloaded.view()).sync).toBe("conflict");
    expect(readCalculatorInput(server.document)).toEqual(input(20));
  });
});
