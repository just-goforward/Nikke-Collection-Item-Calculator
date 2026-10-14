import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeServer, createHarness, createTabRegistry, input } from "./accountTestHarness";
import { type CrossTabChannel, createCrossTabChannel, parseCrossTabMessage } from "./crossTab";
import { EMPTY_WORKSPACE_DOCUMENT, writeCalculatorInput } from "./workspaceDocument";
import { createMemoryWorkspaceStore } from "./workspaceStore";

const opened: Array<{ dispose(): void }> = [];
let channelCount = 0;

afterEach(() => {
  for (const entry of opened.splice(0)) entry.dispose();
});

/** Two tabs of one browser: shared device store and a real BroadcastChannel. */
async function twoTabs(server = createFakeServer({ revision: 1 })) {
  const name = `account-test-${process.pid}-${++channelCount}`;
  const store = createMemoryWorkspaceStore();
  await store.writeGuest({
    document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(73)),
    restoreOnReturn: false,
    updatedAt: 1,
  });
  const tabs = createTabRegistry();
  const tab = (channel: CrossTabChannel) => {
    const harness = createHarness(server, { store, channel, tabs });
    opened.push(harness.controller);
    return harness;
  };
  const first = tab(createCrossTabChannel(name));
  const second = tab(createCrossTabChannel(name));
  await Promise.all([first.controller.start(), second.controller.start()]);
  return { server, first, second };
}

async function settled(harness: ReturnType<typeof createHarness>, check: () => void) {
  await vi.waitFor(async () => {
    await harness.controller.whenIdle();
    check();
  });
}

describe("cross-tab message parsing", () => {
  it("accepts only identifier-and-revision messages", () => {
    expect(parseCrossTabMessage({ type: "revision", userId: "u", revision: 3 })).toEqual({
      type: "revision",
      userId: "u",
      revision: 3,
    });
    expect(parseCrossTabMessage({ type: "logged-out", userId: "u" })).toEqual({
      type: "logged-out",
      userId: "u",
    });
    expect(parseCrossTabMessage({ type: "revision", userId: "u", revision: -1 })).toBeNull();
    expect(parseCrossTabMessage({ type: "unknown", userId: "u" })).toBeNull();
    expect(parseCrossTabMessage({ type: "account" })).toBeNull();
    expect(parseCrossTabMessage("account")).toBeNull();
  });
});

describe("cross-tab account coordination", () => {
  it("a save in one tab updates a clean tab of the same account", async () => {
    const { first, second } = await twoTabs();
    first.edit(input(12));
    await first.runTimers();
    await settled(second, () => expect(second.displayed).toEqual(input(12)));
    expect(second.view()).toMatchObject({ phase: "signed-in", revision: 2, sync: "synced" });
  });

  it("a tab with its own unsynced edits is told instead of being overwritten", async () => {
    const { first, second } = await twoTabs();
    second.edit(input(40));
    first.edit(input(12));
    await first.runTimers();
    await settled(second, () => expect(second.notice()).toBe("updated_elsewhere"));
    expect(second.displayed).toEqual(input(40));
  });

  it("logout in one tab returns every tab to the guest data", async () => {
    const { first, second } = await twoTabs();
    await first.controller.logout();
    await settled(second, () => expect(second.view()).toEqual({ phase: "guest", busy: null }));
    expect(second.displayed).toEqual(input(73));
    expect(second.notice()).toBe("logged_out_elsewhere");
  });

  it("a different account signing in elsewhere makes this tab stale", async () => {
    const { first, second, server } = await twoTabs();
    server.userId = "user-b";
    await first.controller.checkSession();
    expect(first.view()).toEqual({ phase: "stale", reason: "account_changed" });
    // A fresh tab for user-b announces itself on the shared channel.
    const announce = createCrossTabChannel(`account-test-${process.pid}-${channelCount}`);
    opened.push({ dispose: () => announce.close() });
    announce.post({ type: "account", userId: "user-b" });
    await settled(second, () =>
      expect(second.view()).toEqual({ phase: "stale", reason: "account_changed" }),
    );
  });

  it("a guest tab learns about a sign-in in another tab", async () => {
    const server = createFakeServer({ userId: null });
    const { first, second } = await twoTabs(server);
    server.userId = "user-a";
    await first.controller.start();
    await settled(second, () =>
      expect(second.view()).toEqual({ phase: "stale", reason: "signed_in_elsewhere" }),
    );
  });

  it("a hidden tab detects a sign-out it missed when it rechecks", async () => {
    const { first, server } = await twoTabs();
    server.userId = null;
    await first.controller.checkSession();
    expect(first.view()).toEqual({ phase: "guest", busy: null });
    expect(first.displayed).toEqual(input(73));
  });
});
