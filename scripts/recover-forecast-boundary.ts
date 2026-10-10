import { pathToFileURL } from "node:url";
import { readBoundedJson } from "../shared/boundedHttp.ts";

type RecoveryRequest = {
  mode: "recover-boundary";
  environment: "staging";
  source: "naver-board-48" | "naver-board-56";
  expectedCommittedItemId: string;
};
type RecoverySettings = { url: string; token: string; deploymentSha: string };

export function boundaryRecoveryRequest(
  source: string,
  expectedItemId: string,
): RecoveryRequest | null {
  if (source === "none" && expectedItemId === "") return null;
  if (!["48", "56"].includes(source) || !/^[1-9]\d{0,19}$/.test(expectedItemId))
    throw new Error("forecast_boundary_recovery_inputs_invalid");
  return {
    mode: "recover-boundary",
    environment: "staging",
    source: source === "48" ? "naver-board-48" : "naver-board-56",
    expectedCommittedItemId: expectedItemId,
  };
}

export async function executeBoundaryRecovery(
  body: RecoveryRequest,
  settings: RecoverySettings,
  fetcher: typeof fetch = fetch,
) {
  const origin = recoveryOrigin(settings);
  const report = await request("/admin/canary-report");
  if (
    !isRecord(report) ||
    report["environment"] !== "staging" ||
    report["deploymentSha"] !== settings.deploymentSha
  )
    throw new Error("forecast_boundary_recovery_deployment_mismatch");
  const result = await request("/admin/source-queue/process", body);
  if (
    !isRecord(result) ||
    result["recovered"] !== true ||
    result["source"] !== body.source ||
    !Number.isInteger(result["queuedItems"]) ||
    Number(result["queuedItems"]) < 0 ||
    Number(result["queuedItems"]) > 40
  )
    throw new Error("forecast_boundary_recovery_response_invalid");
  return { recovered: true, source: body.source, queuedItems: Number(result["queuedItems"]) };

  async function request(path: string, payload?: RecoveryRequest) {
    let response: Response;
    try {
      response = await fetcher(new URL(path, origin), {
        method: payload ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${settings.token}`,
          "content-type": "application/json",
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(payload ? 50_000 : 20_000),
      });
    } catch {
      throw new Error("forecast_boundary_recovery_network");
    }
    if (!response.ok) throw new Error(`forecast_boundary_recovery_http_${response.status}`);
    return readBoundedJson(response, 1_000_000, "forecast_boundary_recovery_response");
  }
}

function recoveryOrigin(settings: RecoverySettings) {
  const origin = new URL(settings.url);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !settings.token ||
    !/^[a-f0-9]{40}$/.test(settings.deploymentSha)
  )
    throw new Error("forecast_boundary_recovery_configuration_invalid");
  return origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
  if (process.argv.length !== 3 || !["--validate", "--apply"].includes(process.argv[2] ?? ""))
    throw new Error("forecast_boundary_recovery_command_invalid");
  const body = boundaryRecoveryRequest(
    process.env["RECOVERY_SOURCE"] ?? "none",
    process.env["EXPECTED_COMMITTED_ITEM_ID"] ?? "",
  );
  if (
    body &&
    (process.env["GITHUB_EVENT_NAME"] !== "workflow_dispatch" ||
      process.env["GITHUB_REF"] !== "refs/heads/main")
  )
    throw new Error("forecast_boundary_recovery_trusted_dispatch_required");
  if (process.argv[2] === "--validate") return;
  if (!body) throw new Error("forecast_boundary_recovery_opt_in_required");
  const result = await executeBoundaryRecovery(body, {
    url: process.env["FORECAST_COLLECTOR_STAGING_URL"] ?? "",
    token: process.env["FORECAST_COLLECTOR_ADMIN_TOKEN"] ?? "",
    deploymentSha: process.env["FORECAST_EXPECTED_DEPLOY_SHA"] ?? "",
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never log server bodies, credentials, request options or caller-supplied text.
    console.error(
      "Forecast boundary recovery failed; held state must be reviewed before any retry.",
    );
    process.exitCode = 1;
  });
}
