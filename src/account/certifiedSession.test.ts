import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDocument, WorkspacePut } from "../../personal-data/src/contracts";
import {
  certifiedSessionSummary,
  isEmptyCertifiedSession,
  validateCertifiedSessionText,
} from "../certifiedUi/accountSession";
import { serializeCertifiedCalculatorSession } from "../certifiedUi/calculatorSessionPersistence";
import { createCertifiedSession } from "../certifiedUi/session";
import type { SignedInView } from "./accountState";
import {
  createFakeServer,
  createHarness,
  createItemHarness,
  type FakeServer,
  input,
} from "./accountTestHarness";
import { CERTIFIED_SESSION_ITEM_TYPE, createCertifiedSessionCodec } from "./certifiedSessionItem";
import { createCrossTabChannel } from "./crossTab";
import { EMPTY_WORKSPACE_DOCUMENT, readCalculatorInput } from "./workspaceDocument";
import { utf8Bytes } from "./workspaceItem";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "./workspaceStore";

const codec = createCertifiedSessionCodec({
  validate: validateCertifiedSessionText,
  summary: certifiedSessionSummary,
  isEmpty: isEmptyCertifiedSession,
  emptyText: () => sessionText([0, 0, 0], "empty"),
});

function sessionText(stock: [number, number, number], id = "session") {
  const session = {
    ...createCertifiedSession("approved", { grade: "SR", level: 2, exp: 0 }, stock),
    id,
  };
  return serializeCertifiedCalculatorSession(session, null);
}

function documentWith(...items: WorkspaceDocument["items"]): WorkspaceDocument {
  return { schemaVersion: 1, items, lifetimeStages: [] };
}

function signedIn(view: ReturnType<ReturnType<typeof createHarness>["view"]>): SignedInView {
  if (view.phase !== "signed-in") throw new Error(`Expected signed-in view, got ${view.phase}.`);
  return view;
}

function putBodies(server: FakeServer) {
  return server.calls
    .filter((call) => call.method === "putWorkspace")
    .map((call) => call.body as WorkspacePut);
}

function certifiedHarness(
  server: FakeServer,
  options: {
    guest?: string | null;
    store?: WorkspaceStore;
    channel?: ReturnType<typeof createCrossTabChannel>;
  } = {},
) {
  return createItemHarness(server, codec, sessionText([7, 7, 7], "guest-shown"), {
    ...(options.store ? { store: options.store } : {}),
    ...(options.channel ? { channel: options.channel } : {}),
    ownGuest: { value: options.guest ?? null },
  });
}

describe("certified-session workspace item", () => {
  it("round-trips the storage text and preserves every other item and version", () => {
    const foreign = { type: "calculator-input", version: 1, input: { kept: true } };
    const newer = { type: CERTIFIED_SESSION_ITEM_TYPE, version: 2, session: { future: true } };
    const text = sessionText([40, 3, 0]);
    const document = codec.write(documentWith(foreign, newer), text);
    expect(document.items).toEqual([
      foreign,
      newer,
      { type: CERTIFIED_SESSION_ITEM_TYPE, version: 1, session: JSON.parse(text) },
    ]);
    expect(codec.read(document)).toEqual({ status: "value", value: text });
    expect(codec.read(codec.write(document, sessionText([1, 0, 0])))).toEqual({
      status: "value",
      value: sessionText([1, 0, 0]),
    });
    expect(codec.read(documentWith(foreign, newer))).toEqual({ status: "absent" });
    expect(codec.summary(text)).toEqual({
      grade: "SR",
      level: 2,
      exp: 0,
      stock: { blue: 40, purple: 3, yellow: 0 },
    });
    expect(codec.bytes(text)).toBe(utf8Bytes(text));
  });

  it("rejects a corrupt item whole instead of applying any part of it", () => {
    const valid = JSON.parse(sessionText([40, 3, 0]));
    for (const session of [
      "text",
      null,
      { ...valid, stock: [40, -1, 0] },
      { ...valid, receipts: [{ eventId: "x" }] },
    ]) {
      const document = documentWith({ type: CERTIFIED_SESSION_ITEM_TYPE, version: 1, session });
      expect(codec.read(document)).toEqual({ status: "unreadable" });
    }
  });

  it("detects untouched sessions so they are never offered for a guest copy", () => {
    expect(codec.isEmpty(sessionText([0, 0, 0]))).toBe(false);
    const fresh = createCertifiedSession("approved", { grade: "R", level: 0, exp: 0 }, [0, 0, 0]);
    expect(codec.isEmpty(serializeCertifiedCalculatorSession(fresh, null))).toBe(true);
    const stocked = { ...fresh, stock: [10, 0, 0] as const };
    expect(codec.isEmpty(serializeCertifiedCalculatorSession(stocked, null))).toBe(false);
  });
});

describe("certified session sync", () => {
  it("shows an empty session for an empty account and offers the guest session explicitly", async () => {
    const server = createFakeServer({ revision: 1 });
    const store = createMemoryWorkspaceStore();
    const guest = sessionText([30, 2, 1], "guest");
    const harness = certifiedHarness(server, { guest, store });
    await harness.controller.start();
    // The guest session shown at boot is never adopted as account data.
    expect(harness.displayed).toBe(sessionText([0, 0, 0], "empty"));
    const view = signedIn(harness.view());
    expect(view.guestImport).toEqual(codec.summary(guest));
    expect(view.itemBytes).toBe(utf8Bytes(harness.displayed));
    expect(putBodies(server)).toEqual([]);

    await harness.controller.copyGuestInputs();
    expect(harness.displayed).toBe(guest);
    expect(codec.read(server.document)).toEqual({ status: "value", value: guest });
    // Guest data stays in the engine's own storage; the shared guest store is never written.
    expect(await store.readGuest()).toBeNull();
    expect(await store.readAccount("user-a")).toMatchObject({ dirty: false, baseRevision: 2 });
  });

  it("syncs edits next to the production item and returns to the guest session on logout", async () => {
    const server = createFakeServer({
      revision: 3,
      document: documentWith({
        type: "calculator-input",
        version: 1,
        input: { grade: "R", level: 3, exp: 0, stock: { blue: 5, purple: 0, yellow: 0 } },
      }),
    });
    const guest = sessionText([30, 2, 1], "guest");
    const harness = certifiedHarness(server, { guest });
    await harness.controller.start();
    harness.edit(sessionText([12, 0, 0]));
    await harness.runTimers();
    expect(readCalculatorInput(server.document)).toEqual(input(5));
    expect(codec.read(server.document)).toEqual({
      status: "value",
      value: sessionText([12, 0, 0]),
    });
    await harness.controller.logout();
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(harness.displayed).toBe(guest);
  });

  it("never applies an unreadable server copy and replaces it only on explicit overwrite", async () => {
    const corrupt = { type: CERTIFIED_SESSION_ITEM_TYPE, version: 1, session: { stock: "bad" } };
    const server = createFakeServer({ revision: 2, document: documentWith(corrupt) });
    const harness = certifiedHarness(server);
    await harness.controller.start();
    expect(harness.displayed).toBe(sessionText([0, 0, 0], "empty"));
    expect(signedIn(harness.view())).toMatchObject({
      sync: "conflict",
      conflict: { server: null, serverBytes: null, serverUnreadable: true },
    });
    await harness.controller.resolveConflict("server");
    expect(signedIn(harness.view()).sync).toBe("conflict");

    await harness.controller.resolveConflict("cancel");
    harness.edit(sessionText([9, 0, 0]));
    await harness.runTimers();
    await harness.controller.resumeSync();
    expect(putBodies(server)).toEqual([]);
    expect(server.document.items).toEqual([corrupt]);
    expect(signedIn(harness.view()).conflict?.serverUnreadable).toBe(true);

    await harness.controller.resolveConflict("local");
    expect(putBodies(server)).toHaveLength(1);
    expect(codec.read(server.document)).toEqual({ status: "value", value: sessionText([9, 0, 0]) });
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", revision: 3 });
  });

  it("shows both sizes in a conflict", async () => {
    const server = createFakeServer({
      revision: 1,
      document: codec.write(EMPTY_WORKSPACE_DOCUMENT, sessionText([1, 0, 0])),
    });
    const harness = certifiedHarness(server);
    await harness.controller.start();
    server.revision = 2;
    server.document = codec.write(EMPTY_WORKSPACE_DOCUMENT, sessionText([50, 0, 0]));
    harness.edit(sessionText([31, 0, 0]));
    await harness.runTimers();
    expect(signedIn(harness.view()).conflict).toEqual({
      serverRevision: 2,
      server: codec.summary(sessionText([50, 0, 0])),
      local: codec.summary(sessionText([31, 0, 0])),
      serverBytes: utf8Bytes(sessionText([50, 0, 0])),
      localBytes: utf8Bytes(sessionText([31, 0, 0])),
      serverUnreadable: false,
    });
  });

  it("does not send a request over the 2,000,000-byte body limit and keeps the edits", async () => {
    const big = createCertifiedSessionCodec({
      validate: (text) => text,
      summary: () => input(0),
      isEmpty: () => false,
      emptyText: () => JSON.stringify({ size: 0 }),
    });
    const server = createFakeServer({ revision: 1 });
    const store = createMemoryWorkspaceStore();
    const harness = createItemHarness(server, big, JSON.stringify({ size: 0 }), {
      store,
      ownGuest: { value: null },
    });
    await harness.controller.start();
    const huge = JSON.stringify({ size: 1, pad: "x".repeat(2_000_000) });
    harness.edit(huge);
    await harness.runTimers();
    expect(putBodies(server)).toEqual([]);
    expect(signedIn(harness.view())).toMatchObject({ sync: "error", tooLarge: true });
    expect(signedIn(harness.view()).itemBytes).toBe(utf8Bytes(huge));
    expect(harness.notice()).toBe("request_too_large");
    expect(await store.readAccount("user-a")).toMatchObject({ dirty: true });

    harness.edit(JSON.stringify({ size: 2 }));
    await harness.runTimers();
    expect(putBodies(server)).toHaveLength(1);
    expect(signedIn(harness.view())).toMatchObject({ sync: "synced", tooLarge: false });
  });
});

describe("certified cross-tab and cross-engine sync", () => {
  const opened: Array<{ dispose(): void }> = [];
  let count = 0;
  afterEach(() => {
    for (const entry of opened.splice(0)) entry.dispose();
  });

  function channel() {
    return createCrossTabChannel(`certified-test-${process.pid}-${count}`);
  }

  it("a save in one certified tab updates a clean certified tab", async () => {
    count += 1;
    const server = createFakeServer({ revision: 1 });
    const store = createMemoryWorkspaceStore();
    const first = certifiedHarness(server, { store, channel: channel() });
    const second = certifiedHarness(server, { store, channel: channel() });
    opened.push(first.controller, second.controller);
    await Promise.all([first.controller.start(), second.controller.start()]);
    first.edit(sessionText([12, 0, 0]));
    await first.runTimers();
    await vi.waitFor(async () => {
      await second.controller.whenIdle();
      expect(second.displayed).toBe(sessionText([12, 0, 0]));
    });
  });

  it("a production save in between does not raise a conflict for the certified edit", async () => {
    count += 1;
    const server = createFakeServer({ revision: 1 });
    const production = createHarness(server, { channel: channel() });
    const certified = certifiedHarness(server, { channel: channel() });
    opened.push(production.controller, certified.controller);
    await Promise.all([production.controller.start(), certified.controller.start()]);
    certified.edit(sessionText([3, 0, 0]));
    production.edit(input(8));
    await production.runTimers();
    await certified.runTimers();
    expect(signedIn(certified.view())).toMatchObject({ sync: "synced", conflict: null });
    expect(readCalculatorInput(server.document)).toEqual(input(8));
    expect(codec.read(server.document)).toEqual({ status: "value", value: sessionText([3, 0, 0]) });
    // The certified tab keeps its session; the revision broadcast re-applies nothing.
    expect(certified.applied.at(-1)).toBe(sessionText([0, 0, 0], "empty"));
  });
});
