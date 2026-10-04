import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restAdapters } from "./forecast-stop-only/adapters.ts";
import { executeMode } from "./forecast-stop-only/cli.ts";
import { reason } from "./forecast-stop-only/registry.ts";

export async function main(args: string[], vars: NodeJS.ProcessEnv = process.env) {
  // This is an additional accidental-execution guard, not a grant of approval.
  // Default/local/mock use never creates adapters or reads account credentials.
  if (vars["FORECAST_STOP_ONLY_EXECUTION_APPROVED"] !== "true")
    throw new Error("stop_only_execution_not_approved");
  const [mode, packet, roleValue] = args;
  if (!packet || !["prepare", "worker", "finalize", "operator"].includes(mode ?? ""))
    throw new Error("stop_only_arguments_invalid");
  const expectedArguments = mode === "worker" || mode === "operator" ? 3 : 2;
  if (args.length !== expectedArguments) throw new Error("stop_only_arguments_invalid");
  const accountId = vars["CLOUDFLARE_ACCOUNT_ID"] ?? "";
  const api = restAdapters({
    accountId,
    repository: vars["GITHUB_REPOSITORY"] ?? "",
    githubToken: vars["GH_TOKEN"] ?? "",
    cloudflareToken: vars["CLOUDFLARE_API_TOKEN"] ?? "",
  });
  return executeMode(mode, packet, roleValue, api, accountId, vars);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(reason(error));
    process.exitCode = 1;
  }
}
