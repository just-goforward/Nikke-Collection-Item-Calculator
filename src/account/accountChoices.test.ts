import { describe, expect, it } from "vitest";
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

function signedIn(view: ReturnType<ReturnType<typeof createHarness>["view"]>): SignedInView {
  if (view.phase !== "signed-in") throw new Error(`Expected signed-in view, got ${view.phase}.`);
  return view;
}

async function storeWithGuest(blue: number) {
  const store = createMemoryWorkspaceStore();
  await store.writeGuest({
    document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(blue)),
    restoreOnReturn: true,
    updatedAt: 1,
  });
  return store;
}

function puts(server: ReturnType<typeof createFakeServer>) {
  return server.calls.filter((call) => call.method === "putWorkspace");
}

describe("copy guest inputs into an empty account", () => {
  it("offers the guest inputs but never copies them on its own", async () => {
    const server = createFakeServer();
    const harness = createHarness(server, { store: await storeWithGuest(73) });
    await harness.controller.start();
    await harness.runTimers();
    expect(signedIn(harness.view()).guestImport).toEqual(input(73));
    expect(harness.displayed).toEqual(DEFAULT_CALCULATOR_INPUT);
    expect(puts(server)).toEqual([]);
  });

  it("copies on request, saves them to the account and keeps the guest copy", async () => {
    const server = createFakeServer();
    const store = await storeWithGuest(73);
    const harness = createHarness(server, { store });
    await harness.controller.start();
    await harness.controller.copyGuestInputs();
    expect(harness.displayed).toEqual(input(73));
    expect(puts(server)).toMatchObject([{ body: { baseRevision: 0 } }]);
    expect(readCalculatorInput(server.document)).toEqual(input(73));
    expect(signedIn(harness.view())).toMatchObject({ guestImport: null, sync: "synced" });
    expect(harness.notice()).toBe("guest_imported");
    const guest = await store.readGuest();
    expect(guest && readCalculatorInput(guest.document)).toEqual(input(73));
  });

  it("is not offered when the account already has inputs or there is nothing to copy", async () => {
    const withInputs = createFakeServer({
      revision: 2,
      document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(5)),
    });
    const first = createHarness(withInputs, { store: await storeWithGuest(73) });
    await first.controller.start();
    expect(signedIn(first.view()).guestImport).toBeNull();

    const second = createHarness(createFakeServer(), { store: createMemoryWorkspaceStore() });
    await second.controller.start();
    expect(signedIn(second.view()).guestImport).toBeNull();
  });

  it("disappears once the account saves its own inputs, or when dismissed", async () => {
    const server = createFakeServer();
    const harness = createHarness(server, { store: await storeWithGuest(73) });
    await harness.controller.start();
    harness.edit(input(4));
    await harness.runTimers();
    expect(signedIn(harness.view()).guestImport).toBeNull();

    const other = createHarness(createFakeServer(), { store: await storeWithGuest(73) });
    await other.controller.start();
    other.controller.dismissGuestImport();
    expect(signedIn(other.view()).guestImport).toBeNull();
    await other.controller.copyGuestInputs();
    expect(other.displayed).toEqual(DEFAULT_CALCULATOR_INPUT);
  });
});

/** Signed in with an edit the server never acknowledged (every save fails on the network). */
async function withUnsyncedEdit() {
  const server = createFakeServer({ revision: 1 });
  const store = createMemoryWorkspaceStore();
  const channel = recordingChannel();
  const harness = createHarness(server, { store, channel });
  await harness.controller.start();
  server.overrides.putWorkspace = [networkFailure, networkFailure, networkFailure];
  harness.edit(input(9));
  await harness.runTimers(1);
  return { server, store, channel, harness };
}

describe("sign-out with unsynced edits", () => {
  it("asks first and does not sign out until the user chooses", async () => {
    const { server, harness } = await withUnsyncedEdit();
    await harness.controller.logout();
    expect(signedIn(harness.view())).toMatchObject({ signOutChoice: "logout", busy: null });
    expect(server.calls.some((call) => call.method === "logout")).toBe(false);
    harness.controller.cancelSignOut();
    expect(signedIn(harness.view()).signOutChoice).toBeNull();
    expect(server.userId).toBe("user-a");
  });

  it("keep (default): signs out and leaves the unsynced copy for the next sign-in", async () => {
    const { server, store, harness } = await withUnsyncedEdit();
    await harness.controller.logout();
    await harness.controller.confirmSignOut(true);
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(server.userId).toBeNull();
    const kept = await store.readAccount("user-a");
    expect(kept?.dirty).toBe(true);
    expect(kept && readCalculatorInput(kept.document)).toEqual(input(9));
    expect(harness.notice()).toBe("logged_out_kept");

    server.userId = "user-a";
    const next = createHarness(server, { store });
    await next.controller.start();
    expect(next.displayed).toEqual(input(9));
  });

  it("delete: signs out and removes the unsynced copy from this device", async () => {
    const { store, channel, harness } = await withUnsyncedEdit();
    await harness.controller.revokeAllSessions();
    expect(signedIn(harness.view()).signOutChoice).toBe("revoke");
    await harness.controller.confirmSignOut(false);
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(await store.readAccount("user-a")).toBeNull();
    expect(channel.posted).toContainEqual({ type: "logged-out", userId: "user-a" });
    expect(harness.notice()).toBe("logged_out_discarded");
  });

  it("does not ask when the final flush saves everything", async () => {
    const server = createFakeServer({ revision: 1 });
    const harness = createHarness(server);
    await harness.controller.start();
    harness.edit(input(9));
    await harness.controller.logout();
    expect(readCalculatorInput(server.document)).toEqual(input(9));
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(harness.notice()).toBe("logged_out");
  });
});
