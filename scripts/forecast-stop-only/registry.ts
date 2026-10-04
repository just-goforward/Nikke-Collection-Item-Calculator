import { z } from "zod";
import { type Api, type Deployment, type Registry, type Role, scripts } from "./types.ts";

const target = (role: Role) =>
  z
    .object({
      script: z.literal(scripts[role]),
      versionId: z.uuid(),
      bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
const registrySchema = z
  .object({
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    maintenanceHold: z.boolean(),
    sourcePin: z.string().regex(/^[a-f0-9]{64}$/),
    registeredAt: z.iso.datetime(),
    approvalRef: z.string().trim().min(1).max(500),
    flags: z
      .object({ COLLECT_ENABLED: z.literal("false"), DISPATCH_ENABLED: z.literal("false") })
      .strict(),
    workers: z
      .object({ collector: target("collector"), dispatcher: target("dispatcher") })
      .strict(),
  })
  .strict();

export function parseRegistry(value: unknown, accountId: string): Registry {
  const registry = registrySchema.parse(value);
  if (registry.accountId !== accountId) throw new Error("registry_account_mismatch");
  if (registry.workers.collector.versionId === registry.workers.dispatcher.versionId)
    throw new Error("registry_pair_invalid");
  return registry;
}

export function sameRegistry(a: Registry, b: Registry) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function epochCheck(epoch: number, baseline?: number) {
  if (baseline === undefined) return "unavailable" as const;
  if (!Number.isSafeInteger(baseline) || baseline < 1) throw new Error("epoch_baseline_invalid");
  if (epoch < baseline) throw new Error("epoch_decreased");
  return "compared" as const;
}

export async function checkVersion(api: Api, registry: Registry, role: Role) {
  const version = await api.version(registry, role);
  if (version.id !== registry.workers[role].versionId) throw new Error("version_identity_mismatch");
  const flag = role === "collector" ? "COLLECT_ENABLED" : "DISPATCH_ENABLED";
  if (version.flags[flag] !== "false" || version.flags["ENVIRONMENT"] !== "staging")
    throw new Error("version_flags_invalid");
}

export function matches(deployment: Deployment, registry: Registry, role: Role) {
  return (
    deployment.versions.length === 1 &&
    deployment.versions[0]?.versionId === registry.workers[role].versionId &&
    deployment.versions[0]?.percentage === 100
  );
}

export async function currentMatches(api: Api, registry: Registry, role: Role) {
  // A successful observation is not a fence against a later accepted request.
  const active = await api.active(registry, role);
  await checkVersion(api, registry, role);
  return matches(active, registry, role);
}

export function reason(error: unknown) {
  // Never copy remote bodies, secret bindings, or exception messages into evidence.
  return error instanceof Error && /^[a-z_]+(?:_\d+)?$/.test(error.message)
    ? error.message
    : "operation_unavailable";
}
