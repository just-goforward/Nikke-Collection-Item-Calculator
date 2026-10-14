import { describe, expect, it } from "vitest";
import type { WorkspacePut } from "../../personal-data/src/contracts";
import type { SignedInView } from "./accountState";
import { createFakeServer, createHarness, failure, input } from "./accountTestHarness";
import {
  EMPTY_WORKSPACE_DOCUMENT,
  readCalculatorInput,
  writeCalculatorInput,
} from "./workspaceDocument";

function signedIn(view: ReturnType<ReturnType<typeof createHarness>["view"]>): SignedInView {
  if (view.phase !== "signed-in") throw new Error(`Expected signed-in view, got ${view.phase}.`);
  return view;
}

/** Signed in at revision 4 with blue=20, then another device saves blue=50 as revision 9. */
async function conflicted() {
  const server = createFakeServer({
    revision: 4,
    document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(20)),
  });
  const harness = createHarness(server);
  await harness.controller.start();
  server.revision = 9;
  server.document = writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(50));
  harness.edit(input(31));
  await harness.runTimers();
  return { server, harness };
}

function putBodies(server: ReturnType<typeof createFakeServer>) {
  return server.calls
    .filter((call) => call.method === "putWorkspace")
    .map((call) => call.body as WorkspacePut);
}

describe("409 revision_conflict", () => {
  it("stops syncing and offers both versions", async () => {
    const { harness } = await conflicted();
    expect(signedIn(harness.view())).toMatchObject({
      sync: "conflict",
      conflict: { serverRevision: 9, server: input(50), local: input(31) },
    });
    harness.edit(input(32));
    await harness.runTimers();
    expect(harness.pendingTimers()).toEqual([]);
  });

  it("keep server: applies the server inputs and adopts its revision without saving", async () => {
    const { server, harness } = await conflicted();
    await harness.controller.resolveConflict("server");
    await harness.controller.whenIdle();
    expect(harness.displayed).toEqual(input(50));
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 9, conflict: null });
    expect(putBodies(server)).toHaveLength(1);
    expect(await harness.draft()).toBeNull();
  });

  it("overwrite: saves this device's inputs on top of the server revision with a new opId", async () => {
    const { server, harness } = await conflicted();
    await harness.controller.resolveConflict("local");
    const [first, overwrite] = putBodies(server);
    expect(overwrite?.baseRevision).toBe(9);
    expect(overwrite?.opId).not.toBe(first?.opId);
    expect(readCalculatorInput(server.document)).toEqual(input(31));
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 10 });
  });

  it("cancel: pauses sync, keeps local edits, and resuming checks the server again", async () => {
    const { server, harness } = await conflicted();
    await harness.controller.resolveConflict("cancel");
    expect(signedIn(harness.view())).toMatchObject({ sync: "paused", conflict: null });
    expect(await harness.draft()).toMatchObject({ baseRevision: 4 });
    harness.edit(input(33));
    await harness.runTimers();
    expect(putBodies(server)).toHaveLength(1);
    await harness.controller.resumeSync();
    expect(signedIn(harness.view()).conflict).toEqual({
      serverRevision: 9,
      server: input(50),
      local: input(33),
      serverBytes: null,
      localBytes: null,
      serverUnreadable: false,
    });
  });

  it("resolves silently when both sides already hold the same inputs", async () => {
    const server = createFakeServer({ revision: 1 });
    const harness = createHarness(server);
    await harness.controller.start();
    server.revision = 3;
    server.document = writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(8));
    harness.edit(input(8));
    await harness.runTimers();
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 3, conflict: null });
  });
});

describe("account context failures", () => {
  it("409 account_context_stale stops all writes and marks the tab stale", async () => {
    const server = createFakeServer({ revision: 1 });
    const harness = createHarness(server);
    await harness.controller.start();
    server.userId = "user-b";
    harness.edit(input(7));
    await harness.runTimers();
    expect(harness.view()).toEqual({ phase: "stale", reason: "context_stale" });
    harness.edit(input(8));
    await harness.runTimers();
    expect(putBodies(server)).toHaveLength(1);
    // The edit made before the tab went stale is on the device; later edits are locked out.
    const draft = await harness.draft();
    expect(draft && readCalculatorInput(draft.document)).toEqual(input(7));
  });

  it("428 account_context_required is reported as a stale tab, not retried", async () => {
    const server = createFakeServer({ revision: 1 });
    const harness = createHarness(server);
    await harness.controller.start();
    server.overrides.putWorkspace = [failure(428, "account_context_required")];
    harness.edit(input(7));
    await harness.runTimers();
    expect(harness.view()).toEqual({ phase: "stale", reason: "context_required" });
    expect(harness.pendingTimers()).toEqual([]);
  });

  it("an expired session returns to guest data and keeps unsynced account edits on the device", async () => {
    const server = createFakeServer({ revision: 1 });
    const harness = createHarness(server);
    await harness.controller.start();
    server.userId = null;
    harness.edit(input(7));
    await harness.runTimers();
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(harness.notice()).toBe("session_expired");
    const kept = await harness.draft();
    expect(kept && readCalculatorInput(kept.document)).toEqual(input(7));
  });
});
