import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePut } from "../../personal-data/src/contracts";
import type { SignedInView } from "./accountState";
import {
  createFakeServer,
  createHarness,
  createTabRegistry,
  type FakeServer,
  input,
  networkFailure,
} from "./accountTestHarness";
import { createCrossTabChannel } from "./crossTab";
import {
  EMPTY_WORKSPACE_DOCUMENT,
  readCalculatorInput,
  writeCalculatorInput,
} from "./workspaceDocument";
import { createMemoryWorkspaceStore } from "./workspaceStore";

function signedIn(view: ReturnType<ReturnType<typeof createHarness>["view"]>): SignedInView {
  if (view.phase !== "signed-in") throw new Error(`Expected signed-in view, got ${view.phase}.`);
  return view;
}

function putBodies(server: FakeServer) {
  return server.calls
    .filter((call) => call.method === "putWorkspace")
    .map((call) => call.body as WorkspacePut);
}

const opened: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const entry of opened.splice(0)) entry.dispose();
});

describe("per-tab device drafts", () => {
  /** Two open tabs of one browser that both edited offline, differently. */
  async function divergentTabs() {
    const server = createFakeServer({
      revision: 1,
      document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(1)),
    });
    const store = createMemoryWorkspaceStore();
    const tabs = createTabRegistry();
    const first = createHarness(server, { store, tabs });
    const second = createHarness(server, { store, tabs });
    await first.controller.start();
    await second.controller.start();
    server.overrides.putWorkspace = [networkFailure, networkFailure];
    first.edit(input(11));
    await first.runTimers(1);
    second.edit(input(22));
    await second.runTimers(1);
    return { server, store, tabs, first, second };
  }

  it("tabs never overwrite each other's unsynced drafts", async () => {
    const { store, first, second } = await divergentTabs();
    const drafts = await store.readDrafts("user-a");
    expect(drafts.map((draft) => [draft.draftId, readCalculatorInput(draft.document)])).toEqual([
      [second.tab.id, input(22)],
      [first.tab.id, input(11)],
    ]);
  });

  it("after both tabs close, the next tab recovers every draft: one saves, the other asks", async () => {
    const { server, store, tabs, first, second } = await divergentTabs();
    first.close();
    second.close();
    const reloaded = createHarness(server, { store, tabs });
    await reloaded.controller.start();
    await reloaded.controller.whenIdle();
    // The newest draft was on the current revision: it is saved.
    expect(readCalculatorInput(server.document)).toEqual(input(22));
    expect(server.revision).toBe(2);
    // The other was made on revision 1 too, which has moved on: never overwritten silently.
    expect(signedIn(reloaded.view())).toMatchObject({
      sync: "conflict",
      conflict: { serverRevision: 2, server: input(22), local: input(11) },
    });
    expect(reloaded.notice()).toBe("draft_recovered");
    const drafts = await store.readDrafts("user-a");
    expect(drafts.map((draft) => [draft.draftId, readCalculatorInput(draft.document)])).toEqual([
      [reloaded.tab.id, input(11)],
    ]);
    await reloaded.controller.resolveConflict("local");
    await reloaded.controller.whenIdle();
    expect(readCalculatorInput(server.document)).toEqual(input(11));
    expect(await store.readDrafts("user-a")).toEqual([]);
  });

  it("reloading one tab recovers only its own draft while the other tab is open", async () => {
    const { server, store, tabs, first, second } = await divergentTabs();
    first.close();
    const reloaded = createHarness(server, { store, tabs });
    await reloaded.controller.start();
    await reloaded.controller.whenIdle();
    expect(readCalculatorInput(server.document)).toEqual(input(11));
    const drafts = await store.readDrafts("user-a");
    expect(drafts.map((draft) => draft.draftId)).toEqual([second.tab.id]);
  });
});

describe("device durability is independent of the network", () => {
  it("every edit reaches the device at once while a save request hangs", async () => {
    const hang = new Promise<void>(() => undefined);
    const server = createFakeServer({ revision: 1 });
    const harness = createHarness(server);
    await harness.controller.start();
    await harness.controller.whenIdle();
    server.hold = { putWorkspace: hang };
    harness.edit(input(5));
    const [timer] = harness.pendingTimers();
    timer?.callback();
    await vi.waitFor(() => expect(putBodies(server)).toHaveLength(1));
    harness.edit(input(6));
    await vi.waitFor(async () => {
      const [draft] = await harness.store.readDrafts("user-a");
      expect(draft && readCalculatorInput(draft.document)).toEqual(input(6));
    });
  });
});

describe("lost acknowledgements", () => {
  it("never reports synced behind a revision another tab announced", async () => {
    const name = `account-durability-${process.pid}-${Date.now()}`;
    const server = createFakeServer({ revision: 1 });
    const channel = createCrossTabChannel(name);
    const announce = createCrossTabChannel(name);
    const harness = createHarness(server, { channel });
    opened.push(harness.controller, { dispose: () => announce.close() });
    await harness.controller.start();
    server.loseAcks = 1;
    harness.edit(input(5));
    await harness.runTimers(1);
    // Committed as revision 2, but the answer was lost.
    expect(server.revision).toBe(2);
    expect(signedIn(harness.view()).sync).toBe("offline");
    // Another tab saves revision 3 on top and announces it.
    server.revision = 3;
    server.lastOpId = "other-tab-op";
    server.document = writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(9));
    announce.post({ type: "revision", userId: "user-a", revision: 3 });
    await vi.waitFor(async () => {
      await harness.controller.whenIdle();
      expect(harness.notice()).toBe("updated_elsewhere");
    });
    // The retry replays revision 2; the tab then follows revision 3 before reporting synced.
    await harness.runTimers();
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 3 });
    expect(harness.displayed).toEqual(input(9));
    expect(putBodies(server)).toHaveLength(2);
  });

  it("a conflict caused by its own committed save is an acknowledgement, not a question", async () => {
    const server = createFakeServer({ revision: 1 });
    const harness = createHarness(server);
    await harness.controller.start();
    server.loseAcks = 1;
    harness.edit(input(5));
    await harness.runTimers(1);
    harness.edit(input(6));
    await harness.runTimers();
    const bodies = putBodies(server);
    expect(bodies.map((body) => [body.opId, body.baseRevision])).toEqual([
      ["op-1", 1],
      ["op-2", 1],
      ["op-3", 2],
    ]);
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 3, conflict: null });
    expect(readCalculatorInput(server.document)).toEqual(input(6));
  });
});

describe("unreadable calculator item", () => {
  it("is a conflict that only an explicit overwrite replaces", async () => {
    const broken = { type: "calculator-input", version: 1, input: { grade: "R" } };
    const server = createFakeServer({
      revision: 2,
      document: { schemaVersion: 1, items: [broken], lifetimeStages: [] },
    });
    const harness = createHarness(server, { displayed: input(3) });
    await harness.controller.start();
    expect(signedIn(harness.view())).toMatchObject({
      sync: "conflict",
      conflict: { server: null, serverUnreadable: true },
    });
    await harness.controller.resolveConflict("server");
    expect(signedIn(harness.view()).sync).toBe("conflict");
    await harness.controller.resolveConflict("cancel");
    harness.edit(input(4));
    await harness.runTimers();
    expect(putBodies(server)).toEqual([]);
    await harness.controller.resumeSync();
    await harness.controller.resolveConflict("local");
    expect(readCalculatorInput(server.document)).toEqual(input(4));
  });
});
