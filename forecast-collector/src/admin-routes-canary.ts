import { readBoundedJson } from "../../shared/boundedHttp.ts";
import { assertD1QuotaEvidence } from "../../shared/d1QuotaEvidence.ts";
import {
  readUsageGuardEvidence,
  readUsageGuardState,
  type UsageGuardEvidence,
  type UsageGuardState,
} from "../../shared/usageGuard.ts";
import { readCanaryReport, readCanaryWindow, startCanaryDeployment } from "./canary";
import { sha256Hex, stableJson } from "./crypto";
import { type AdminRequestContext, json, opsEnvironment, requireGuardDb } from "./http-shared";
import { sanitizeOpsError } from "./ops";

const CANARY_ID = /^fc-[0-9a-f]{32}$/;

export async function handleAdminCanaryRoute(context: AdminRequestContext) {
  const { request, url } = context;
  if (request.method === "GET" && url.pathname === "/admin/canary-window") {
    return canaryWindow(context);
  }
  if (
    (request.method === "GET" || request.method === "POST") &&
    url.pathname === "/admin/canary-report"
  ) {
    return canaryReport(context);
  }
  if (request.method === "POST" && url.pathname === "/admin/canary-deployments/start") {
    return startCanary(context);
  }
  return null;
}

async function canaryWindow({ url, env }: AdminRequestContext) {
  const canaryId = url.searchParams.get("canaryId") ?? undefined;
  if (canaryId !== undefined && !CANARY_ID.test(canaryId)) {
    return json({ error: "canary_id_invalid" }, 400);
  }
  return json(
    await readCanaryWindow(
      env.FORECAST_DB,
      Date.now(),
      env.DEPLOY_SHA,
      opsEnvironment(env),
      canaryId,
    ),
  );
}

async function canaryReport({ request, url, env }: AdminRequestContext) {
  let canaryId = url.searchParams.get("canaryId") ?? undefined;
  if (canaryId !== undefined && !CANARY_ID.test(canaryId)) {
    return json({ error: "canary_id_invalid" }, 400);
  }
  let runtimeQuota: UsageGuardEvidence | UsageGuardState | undefined;
  let runtimeTelemetry: unknown;
  let runtimeBaseline: unknown;
  if (request.method === "POST") {
    try {
      const parsed = await parseFinalEvidence(request);
      canaryId = parsed.canaryId;
      runtimeQuota = parsed.runtimeQuota;
      runtimeTelemetry = parsed.runtimeTelemetry;
      runtimeBaseline = parsed.runtimeBaseline;
    } catch (error) {
      return json({ error: sanitizeOpsError(error) }, 400);
    }
  } else {
    runtimeQuota = await readUsageGuardState(requireGuardDb(env));
  }
  return json(
    await readCanaryReport(
      env.FORECAST_DB,
      Date.now(),
      env.DEPLOY_SHA,
      opsEnvironment(env),
      canaryId,
      runtimeQuota,
      runtimeTelemetry,
      runtimeBaseline,
    ),
  );
}

async function parseFinalEvidence(request: Request) {
  const body = await readBoundedJson(request, 1_000_000, "canary_final_evidence_body");
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("canary_final_evidence_body_invalid");
  }
  const record = body as Record<string, unknown>;
  if (typeof record["canaryId"] !== "string") {
    throw new Error("canary_final_evidence_contract_invalid");
  }
  const canaryId = record["canaryId"];
  if (!CANARY_ID.test(canaryId)) throw new Error("canary_id_invalid");
  let runtimeQuota: UsageGuardEvidence | undefined;
  if (record["quotaEvidence"] != null) {
    const evidence = assertD1QuotaEvidence(record["quotaEvidence"]);
    runtimeQuota = {
      action: evidence.action,
      observedAt: evidence.observedAt,
      periodStart: evidence.plan.periodStart,
      periodEnd: evidence.plan.periodEnd,
      evidenceHash: await sha256Hex(stableJson(evidence)),
      evidence,
    };
  }
  return {
    canaryId,
    runtimeQuota,
    runtimeTelemetry: record["runtimeTelemetry"],
    runtimeBaseline: record["runtimeBaseline"],
  };
}

async function startCanary({ request, env }: AdminRequestContext) {
  try {
    const record = await parseCanaryStartBody(request);
    const guard = await readUsageGuardEvidence(requireGuardDb(env));
    if (guard.action !== "normal") throw new Error(`cloudflare_paid_guard_${guard.action}`);
    const requestedEvidence = assertD1QuotaEvidence(record["quotaEvidence"]);
    if (
      requestedEvidence.plan.periodStart !== guard.evidence.plan.periodStart ||
      requestedEvidence.plan.periodEnd !== guard.evidence.plan.periodEnd ||
      requestedEvidence.action !== "normal"
    ) {
      throw new Error("canary_quota_evidence_period_or_action_mismatch");
    }
    return json({
      canary: await startCanaryDeployment(env.FORECAST_DB, {
        environment: opsEnvironment(env),
        canaryId: record["canaryId"],
        deploymentSha: env.DEPLOY_SHA,
        collectorCron: record["collectorCron"],
        dispatcherCron: record["dispatcherCron"],
        collectorVersionId: record["collectorVersionId"],
        dispatcherVersionId: record["dispatcherVersionId"],
        quotaEvidence: guard.evidence,
      }),
    });
  } catch (error) {
    const code = sanitizeOpsError(error);
    return json({ error: code }, code.includes("conflict") || code.includes("overlap") ? 409 : 400);
  }
}

async function parseCanaryStartBody(request: Request) {
  const body = await readBoundedJson(request, 65_536, "canary_start_body");
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("canary_start_body_invalid");
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record["canaryId"] !== "string" ||
    typeof record["collectorCron"] !== "string" ||
    typeof record["dispatcherCron"] !== "string" ||
    typeof record["collectorVersionId"] !== "string" ||
    typeof record["dispatcherVersionId"] !== "string" ||
    !("quotaEvidence" in record)
  ) {
    throw new Error("canary_start_contract_invalid");
  }
  return record as Record<string, unknown> & {
    canaryId: string;
    collectorCron: string;
    dispatcherCron: string;
    collectorVersionId: string;
    dispatcherVersionId: string;
  };
}
