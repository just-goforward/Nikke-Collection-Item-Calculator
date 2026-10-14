import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDocument, WorkspacePut } from "../../personal-data/src/contracts";
import type { SignedInView } from "./accountState";
import {
  createFakeServer,
  createHarness,
  createTabRegistry,
  type FakeServer,
  failure,
  input,
  networkFailure,
} from "./accountTestHarness";
import {
  EMPTY_WORKSPACE_DOCUMENT,
  readCalculatorInput,
  writeCalculatorInput,
} from "./workspaceDocument";
import {
  createMemoryWorkspaceStore,
  type DraftRecord,
  type WorkspaceStore,
} from "./workspaceStore";

function signedIn(view: ReturnType<ReturnType<typeof createHarness>["view"]>): SignedInView {
  if (view.phase !== "signed-in") throw new Error(`Expected signed-in view, got ${view.phase}.`);
  return view;
}

function putBodies(server: FakeServer) {
  return server.calls
    .filter((call) => call.method === "putWorkspace")
    .map((call) => call.body as WorkspacePut);
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const doc = (blue: number) => writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(blue));

/** A draft left behind by a tab that is no longer open. */
function abandonedDraft(draftId: string, blue: number, updatedAt = 1): DraftRecord {
  return {
    userId: "user-a",
    draftId,
    baseRevision: 1,
    baseKey: null,
    document: doc(blue),
    updatedAt,
  };
}

function draftValues(drafts: DraftRecord[]) {
  return drafts.map((draft) => [draft.draftId, readCalculatorInput(draft.document)]);
}

/** A device whose draft writes are refused (QuotaExceededError) while `full` is set. */
function fullableStore(base: WorkspaceStore) {
  const state = { full: false };
  const refuse = () => {
    if (state.full) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  };
  const store: WorkspaceStore = {
    ...base,
    writeDraft: async (record) => {
      refuse();
      await base.writeDraft(record);
    },
    claimDraft: async (userId, sourceId, record) => {
      refuse();
      return base.claimDraft(userId, sourceId, record);
    },
  };
  return { store, state };
}

describe("draft recovery (R2-8, R2-11, N-A1, N-A2)", () => {
  it("never removes a recovered draft whose adoption could not be stored", async () => {
    const server = createFakeServer({ revision: 1, document: doc(1) });
    server.overrides.putWorkspace = [networkFailure];
    const memory = createMemoryWorkspaceStore();
    await memory.writeDraft(abandonedDraft("closed-tab", 7));
    const { store, state } = fullableStore(memory);
    state.full = true;
    const harness = createHarness(server, { store });
    await harness.controller.start();
    await harness.controller.whenIdle();
    expect(draftValues(await memory.readDrafts("user-a"))).toEqual([["closed-tab", input(7)]]);
    expect(harness.notice()).toBe("draft_recovery_failed");
    expect(harness.controller.getSnapshot().persistent).toBe(false);
    // Nothing was adopted: the edits stay where they are for a later attempt.
    expect(harness.displayed).toEqual(input(1));
    expect(putBodies(server)).toEqual([]);
  });

  it("two tabs opening at once adopt an abandoned draft only once", async () => {
    const server = createFakeServer({ revision: 1, document: doc(1) });
    const store = createMemoryWorkspaceStore();
    await store.writeDraft(abandonedDraft("closed-tab", 7));
    const tabs = createTabRegistry();
    const first = createHarness(server, { store, tabs });
    const second = createHarness(server, { store, tabs });
    await Promise.all([first.controller.start(), second.controller.start()]);
    await Promise.all([first.controller.whenIdle(), second.controller.whenIdle()]);
    const recovered = [first.notice(), second.notice()].filter(
      (notice) => notice === "draft_recovered",
    );
    expect(recovered).toHaveLength(1);
    const carrying = putBodies(server).filter(
      (body) => JSON.stringify(readCalculatorInput(body.document)) === JSON.stringify(input(7)),
    );
    expect(carrying).toHaveLength(1);
    expect(readCalculatorInput(server.document)).toEqual(input(7));
    expect(await store.readDrafts("user-a")).toEqual([]);
  });

  it("a draft whose item is unchanged on the server rebases after another engine's save", async () => {
    const server = createFakeServer({ revision: 1, document: doc(1) });
    const store = createMemoryWorkspaceStore();
    const tabs = createTabRegistry();
    const first = createHarness(server, { store, tabs });
    await first.controller.start();
    server.overrides.putWorkspace = [networkFailure];
    first.edit(input(8));
    await first.runTimers(1);
    first.close();
    // Only the other engine's item changed since the draft was made.
    const certified = { type: "certified-session", version: 1, session: "{}" };
    server.document = {
      ...server.document,
      items: [...server.document.items, certified as WorkspaceDocument["items"][number]],
    };
    server.revision = 2;
    server.lastOpId = "certified-op";
    const reloaded = createHarness(server, { store, tabs });
    await reloaded.controller.start();
    await reloaded.controller.whenIdle();
    expect(signedIn(reloaded.view())).toMatchObject({
      sync: "synced",
      revision: 3,
      conflict: null,
    });
    expect(readCalculatorInput(server.document)).toEqual(input(8));
    expect(server.document.items).toContainEqual(certified);
    expect(putBodies(server).at(-1)?.baseRevision).toBe(2);
  });

  it("deleting on sign-out keeps closed tabs' drafts this tab has not shown", async () => {
    const server = createFakeServer({ revision: 1, document: doc(1) });
    const store = createMemoryWorkspaceStore();
    await store.writeDraft(abandonedDraft("closed-1", 7, 2));
    await store.writeDraft(abandonedDraft("closed-2", 9, 1));
    server.overrides.putWorkspace = [networkFailure, networkFailure, networkFailure];
    const harness = createHarness(server, { store });
    await harness.controller.start();
    await harness.controller.whenIdle();
    expect(harness.displayed).toEqual(input(7));
    await harness.controller.logout();
    expect(signedIn(harness.view()).signOutChoice).toBe("logout");
    await harness.controller.confirmSignOut(false);
    expect(harness.notice()).toBe("logged_out_discarded");
    expect(draftValues(await store.readDrafts("user-a"))).toEqual([["closed-2", input(9)]]);
  });
});

describe("acknowledgements (R2-9, N-A3)", () => {
  it("reverting to the synced value after a lost acknowledgement still reaches the server", async () => {
    const server = createFakeServer({ revision: 1, document: doc(10) });
    const harness = createHarness(server);
    await harness.controller.start();
    server.loseAcks = 1;
    harness.edit(input(11));
    await harness.runTimers(1);
    // Committed as revision 2, but the answer was lost.
    expect(server.revision).toBe(2);
    harness.edit(input(10));
    await harness.controller.whenIdle();
    expect(signedIn(harness.view()).sync).not.toBe("synced");
    expect(await harness.draft()).not.toBeNull();
    await harness.runTimers();
    expect(readCalculatorInput(server.document)).toEqual(input(10));
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 3 });
    expect(await harness.draft()).toBeNull();
  });

  it("a replayed acknowledgement catches up with saves from other devices", async () => {
    const server = createFakeServer({ revision: 1, document: doc(1) });
    const harness = createHarness(server);
    await harness.controller.start();
    server.loseAcks = 1;
    harness.edit(input(5));
    await harness.runTimers(1);
    // Another device saves revision 3; no broadcast reaches this tab.
    server.revision = 3;
    server.lastOpId = "other-device";
    server.document = doc(9);
    await harness.runTimers();
    expect(putBodies(server).map((body) => body.opId)).toEqual(["op-1", "op-1"]);
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 3 });
    expect(harness.displayed).toEqual(input(9));
  });
});

describe("guest data around account entry (R2-10, N-A5)", () => {
  it("guest edits made while entry is retried are kept as guest data", async () => {
    const server = createFakeServer({ revision: 2, document: doc(40) });
    server.overrides.getWorkspace = [failure(503, "service_unavailable")];
    const harness = createHarness(server, { displayed: input(1) });
    await harness.controller.start();
    expect(harness.view()).toMatchObject({ phase: "unavailable" });
    harness.edit(input(5));
    const slow = deferred();
    server.hold = { getAccount: slow.promise };
    const retried = harness.controller.retryAccount();
    await vi.waitFor(() =>
      expect(server.calls.filter((call) => call.method === "getAccount")).toHaveLength(2),
    );
    harness.edit(input(6));
    server.hold = {};
    slow.resolve();
    await retried;
    expect(harness.displayed).toEqual(input(40));
    await harness.controller.logout();
    expect(harness.displayed).toEqual(input(6));
  });

  it("a timeout while guest data is shown after a failed workspace read asks for no reload", async () => {
    const server = createFakeServer({ revision: 2, document: doc(40) });
    server.overrides.getWorkspace = [failure(503, "service_unavailable")];
    const memory = createMemoryWorkspaceStore();
    const gate = deferred();
    const restoring = deferred();
    let reads = 0;
    const store: WorkspaceStore = {
      ...memory,
      readGuest: async () => {
        reads += 1;
        // The second read is enterGuest("boot") after the failed workspace read.
        if (reads === 2) {
          restoring.resolve();
          await gate.promise;
        }
        return memory.readGuest();
      },
    };
    const harness = createHarness(server, { store });
    const started = harness.controller.start();
    await restoring.promise;
    const timedOut = harness.controller.bootTimedOut(true);
    gate.resolve();
    await Promise.all([started, timedOut]);
    await harness.controller.whenIdle();
    expect(harness.view()).toMatchObject({ phase: "unavailable" });
    await harness.controller.retryAccount();
    expect(signedIn(harness.view()).revision).toBe(2);
    expect(harness.displayed).toEqual(input(40));
  });
});

describe("redirect restore marker and blocked upgrades (R2-6, N-A6)", () => {
  it("marks a pending restore before the sign-in redirect and clears it once restored", async () => {
    const server = createFakeServer({ userId: null });
    const store = createMemoryWorkspaceStore();
    const harness = createHarness(server, { store, displayed: input(21) });
    await harness.controller.start();
    await harness.controller.login();
    expect(harness.navigations).toHaveLength(1);
    expect(harness.redirectMarks).toEqual([false, true]);
    // The sign-in was cancelled: the next page load restores the inputs and clears the marker.
    const returned = createHarness(server, { store, displayed: input(0) });
    await returned.controller.start();
    expect(returned.displayed).toEqual(input(21));
    expect(returned.redirectMarks).toEqual([false]);
  });

  it("a failed sign-in start clears the marker again", async () => {
    const server = createFakeServer({ userId: null });
    server.overrides.startLogin = [networkFailure];
    const harness = createHarness(server, { displayed: input(21) });
    await harness.controller.start();
    await harness.controller.login();
    expect(harness.redirectMarks).toEqual([false, true, false]);
  });

  it("reports a device-store upgrade blocked by another tab", async () => {
    const harness = createHarness(createFakeServer({ userId: null }), { blockedOpen: true });
    await harness.controller.start();
    expect(harness.notice()).toBe("storage_blocked");
  });
});
