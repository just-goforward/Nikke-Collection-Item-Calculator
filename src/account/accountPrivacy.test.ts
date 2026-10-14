import { describe, expect, it } from "vitest";
import type { SignedInView } from "./accountState";
import { exportFileName } from "./accountState";
import {
  createFakeServer,
  createHarness,
  failure,
  input,
  networkFailure,
  recordingChannel,
} from "./accountTestHarness";
import { EMPTY_WORKSPACE_DOCUMENT, writeCalculatorInput } from "./workspaceDocument";
import { createMemoryWorkspaceStore } from "./workspaceStore";

function signedIn(view: ReturnType<ReturnType<typeof createHarness>["view"]>): SignedInView {
  if (view.phase !== "signed-in") throw new Error(`Expected signed-in view, got ${view.phase}.`);
  return view;
}

describe("consent", () => {
  it("asks once at first login and saves the explicit answer with CAS and account context", async () => {
    const server = createFakeServer({ consent: { participation: null, decisionVersion: 0 } });
    const harness = createHarness(server);
    await harness.controller.start();
    expect(signedIn(harness.view()).consentPrompt).toBe(true);
    await harness.controller.setConsent(false);
    const call = server.calls.find((entry) => entry.method === "putConsent");
    expect(call).toMatchObject({
      userId: "user-a",
      body: { participation: false, baseDecisionVersion: 0, opId: "op-1" },
    });
    expect(signedIn(harness.view())).toMatchObject({
      consentPrompt: false,
      consent: { participation: false, decisionVersion: 1 },
      busy: null,
    });
    expect(harness.notice()).toBe("consent_saved");
  });

  it("deciding later leaves the decision open without blocking personal features", async () => {
    const server = createFakeServer({ consent: { participation: null, decisionVersion: 0 } });
    const harness = createHarness(server);
    await harness.controller.start();
    harness.controller.dismissConsentPrompt();
    expect(signedIn(harness.view()).consentPrompt).toBe(false);
    harness.edit(input(3));
    await harness.runTimers();
    expect(signedIn(harness.view()).sync).toBe("synced");
    expect(server.calls.some((entry) => entry.method === "putConsent")).toBe(false);
  });

  it("a stale decision version refetches the current consent", async () => {
    const server = createFakeServer({ consent: { participation: false, decisionVersion: 1 } });
    const harness = createHarness(server);
    await harness.controller.start();
    server.consent = { participation: true, decisionVersion: 2 };
    await harness.controller.setConsent(true);
    expect(signedIn(harness.view()).consent).toEqual({ participation: true, decisionVersion: 2 });
    expect(harness.notice()).toBe("consent_conflict");
  });

  it("retries a pending consent change with the same opId", async () => {
    const server = createFakeServer();
    const harness = createHarness(server);
    await harness.controller.start();
    server.overrides.putConsent = [failure(409, "consent_change_pending"), networkFailure];
    await harness.controller.setConsent(true);
    expect(harness.notice()).toBe("consent_pending");
    await harness.controller.setConsent(true);
    await harness.controller.setConsent(true);
    const opIds = server.calls
      .filter((entry) => entry.method === "putConsent")
      .map((entry) => (entry.body as { opId: string }).opId);
    expect(opIds).toEqual(["op-1", "op-1", "op-1"]);
    expect(signedIn(harness.view()).consent.participation).toBe(true);
  });
});

describe("sessions, export and deletion", () => {
  it("revoke-all sends the account context and signs this tab out", async () => {
    const server = createFakeServer();
    const harness = createHarness(server);
    await harness.controller.start();
    await harness.controller.revokeAllSessions();
    expect(server.calls.find((entry) => entry.method === "revokeAll")).toMatchObject({
      userId: "user-a",
      body: { opId: "op-1" },
    });
    expect(harness.view()).toEqual({ phase: "guest", busy: null });
    expect(harness.notice()).toBe("revoked");
  });

  it("a failed logout keeps the account signed in and explains why", async () => {
    const server = createFakeServer();
    const harness = createHarness(server);
    await harness.controller.start();
    server.overrides.logout = [networkFailure];
    await harness.controller.logout();
    expect(signedIn(harness.view()).busy).toBeNull();
    expect(harness.notice()).toBe("network");
  });

  it("exports the server's personal document as a JSON download", async () => {
    const server = createFakeServer({ revision: 3 });
    const harness = createHarness(server);
    await harness.controller.start();
    await harness.controller.exportData();
    const exported = {
      schemaVersion: 1,
      account: { userId: "user-a" },
      workspace: { userId: "user-a", revision: 3 },
    };
    expect(harness.downloads).toEqual([
      {
        fileName: "collection-kit-account-export-2025-10-09.json",
        text: `${JSON.stringify(exported, null, 2)}\n`,
      },
    ]);
    expect(exportFileName(1_760_000_000_000)).toBe("collection-kit-account-export-2025-10-09.json");
    expect(server.calls.find((entry) => entry.method === "exportData")?.userId).toBe("user-a");
  });

  it("never downloads an export after the session switched to another account", async () => {
    const server = createFakeServer({ revision: 3 });
    const harness = createHarness(server);
    await harness.controller.start();
    server.userId = "user-b";
    await harness.controller.exportData();
    expect(harness.downloads).toEqual([]);
    expect(harness.view()).toEqual({ phase: "stale", reason: "context_stale" });
  });

  it("deletes the account with context and opId, removes even unsynced copies, keeps guest data", async () => {
    const server = createFakeServer({ deletionStatus: "pending" });
    const store = createMemoryWorkspaceStore();
    await store.writeGuest({
      document: writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, input(73)),
      restoreOnReturn: false,
      updatedAt: 1,
    });
    const channel = recordingChannel();
    const harness = createHarness(server, { store, channel });
    await harness.controller.start();
    server.overrides.putWorkspace = [networkFailure];
    harness.edit(input(9));
    await harness.runTimers(1);
    await harness.controller.deleteAccount();
    expect(server.calls.find((entry) => entry.method === "deleteAccount")).toMatchObject({
      userId: "user-a",
      body: { opId: "op-2" },
    });
    expect(await store.readDrafts("user-a")).toEqual([]);
    expect(harness.displayed).toEqual(input(73));
    expect(channel.posted).toContainEqual({ type: "deleted", userId: "user-a" });
    expect(harness.notice()).toBe("deletion_pending");
  });

  it("reuses the deletion opId after a lost acknowledgement", async () => {
    const server = createFakeServer();
    const harness = createHarness(server);
    await harness.controller.start();
    server.overrides.deleteAccount = [networkFailure];
    await harness.controller.deleteAccount();
    expect(signedIn(harness.view()).busy).toBeNull();
    await harness.controller.deleteAccount();
    const opIds = server.calls
      .filter((entry) => entry.method === "deleteAccount")
      .map((entry) => (entry.body as { opId: string }).opId);
    expect(opIds).toEqual(["op-1", "op-1"]);
    expect(harness.notice()).toBe("deleted");
  });
});
