import { vi } from "vitest";
import {
  type Api,
  type Deployment,
  type Journal,
  type Receipt,
  type Registry,
  type Role,
  scripts,
} from "./forecast-stop-only/types.ts";

export const accountId = "a".repeat(32);
export const collectorId = "11111111-1111-4111-8111-111111111111";
export const dispatcherId = "22222222-2222-4222-8222-222222222222";
export function fixture() {
  const registry: Registry = {
    epoch: 2,
    accountId,
    maintenanceHold: true,
    sourcePin: "b".repeat(64),
    registeredAt: "2026-10-03T00:00:00.000Z",
    approvalRef: "local-mock-approval",
    flags: { COLLECT_ENABLED: "false", DISPATCH_ENABLED: "false" },
    workers: {
      collector: { script: scripts.collector, versionId: collectorId, bundleHash: "c".repeat(64) },
      dispatcher: {
        script: scripts.dispatcher,
        versionId: dispatcherId,
        bundleHash: "d".repeat(64),
      },
    },
  };
  const entries: Record<Role, Deployment[]> = { collector: [], dispatcher: [] };
  const active: Record<Role, Deployment> = {
    collector: deployment(collectorId),
    dispatcher: deployment(dispatcherId),
  };
  const fail = new Set<Role>();
  let ordinal = 10;
  const api: Api = {
    registry: vi.fn(async () => structuredClone(registry)),
    version: vi.fn<Api["version"]>(async (_registry, role) => ({
      id: registry.workers[role].versionId,
      flags: { ENVIRONMENT: "staging", COLLECT_ENABLED: "false", DISPATCH_ENABLED: "false" },
    })),
    active: vi.fn<Api["active"]>(async (_registry, role) => structuredClone(active[role])),
    history: vi.fn<Api["history"]>(async (_registry, role) => structuredClone(entries[role])),
    deploy: vi.fn<Api["deploy"]>(async (_registry, role, message) => {
      if (fail.has(role)) throw new Error("api_http_403");
      const d = deployment(registry.workers[role].versionId, message, ordinal++);
      entries[role].push(d);
      active[role] = d;
      return { id: d.id };
    }),
    activeRuns: vi.fn(async () => 0),
  };
  const collector = memoryJournal(),
    dispatcher = memoryJournal();
  const protect = {
    production: vi.fn(async () => {}),
    alert: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  };
  return {
    api,
    registry,
    entries,
    active,
    fail,
    collector,
    dispatcher,
    journals: { collector, dispatcher },
    protect,
  };
}
export function memoryJournal() {
  const records: Receipt[] = [];
  const journal: Journal = {
    baselineEvidence: "provided",
    markIncomplete: vi.fn(async () => {
      journal.baselineEvidence = "incomplete";
    }),
    append: vi.fn<Journal["append"]>(async (r) => {
      records.push(structuredClone(r));
    }),
    read: vi.fn(async () => structuredClone(records)),
  };
  return Object.assign(journal, { records });
}
export function deployment(versionId: string, message = "", number = 1): Deployment {
  return {
    id: `${String(number).padStart(8, "0")}-3333-4333-8333-333333333333`,
    createdOn: new Date(Date.parse("2026-10-03T00:00:00Z") + number * 1000).toISOString(),
    versions: [{ versionId, percentage: 100 }],
    message,
  };
}
