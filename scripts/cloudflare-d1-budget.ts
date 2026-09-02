import { appendFile, readFile, writeFile } from "node:fs/promises";
import {
  type D1BudgetEvaluation,
  type D1UsageSnapshot,
  evaluateD1CanaryBudget,
  evaluateD1PreflightBudget,
  evaluateD1RuntimeBudget,
  fetchD1UsageSnapshot,
} from "../shared/cloudflarePaidUsage.ts";
import { assertD1QuotaEvidence, type D1QuotaEvidence } from "../shared/d1QuotaEvidence.ts";

const command = process.argv[2];
const args = parseArguments(process.argv.slice(3));
const outputPath = requiredArgument(args, "output");

if (command === "snapshot" || command === "preflight") {
  const snapshot = await fetchD1UsageSnapshot({
    accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
    analyticsToken: requiredEnvironment("CLOUDFLARE_D1_ANALYTICS_TOKEN"),
    billingToken: requiredEnvironment("CLOUDFLARE_BILLING_READ_TOKEN"),
  });
  if (command === "snapshot") {
    await writeJson(outputPath, snapshot);
    await githubOutputs({
      billing_period_start: snapshot.plan.periodStart,
      billing_period_end: snapshot.plan.periodEnd,
      captured_at: snapshot.capturedAt,
      database_count: String(snapshot.databases.length),
      worker_count: String(snapshot.workers.length),
    });
    console.log(
      JSON.stringify({
        version: snapshot.version,
        billingPeriodStart: snapshot.plan.periodStart,
        billingPeriodEnd: snapshot.plan.periodEnd,
        capturedAt: snapshot.capturedAt,
        databaseCount: snapshot.databases.length,
        workerCount: snapshot.workers.length,
      }),
    );
  } else {
    await finishEvaluation(outputPath, evaluateD1PreflightBudget(snapshot));
  }
} else if (command === "evaluate") {
  const baseline = await readJson<D1UsageSnapshot>(requiredArgument(args, "baseline"));
  const current = await fetchD1UsageSnapshot({
    accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
    analyticsToken: requiredEnvironment("CLOUDFLARE_D1_ANALYTICS_TOKEN"),
    billingToken: requiredEnvironment("CLOUDFLARE_BILLING_READ_TOKEN"),
  });
  const evaluation = evaluateD1CanaryBudget(baseline, current);
  await finishEvaluation(outputPath, evaluation);
} else if (command === "monitor") {
  const source = await readJson<unknown>(requiredArgument(args, "evidence"));
  const evidence = extractEvidence(source);
  const current = await fetchD1UsageSnapshot({
    accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID"),
    analyticsToken: requiredEnvironment("CLOUDFLARE_D1_ANALYTICS_TOKEN"),
    billingToken: requiredEnvironment("CLOUDFLARE_BILLING_READ_TOKEN"),
  });
  const evaluation = evaluateD1RuntimeBudget(evidence, current);
  await finishEvaluation(outputPath, evaluation);
} else {
  throw new Error(
    "Usage: cloudflare-d1-budget.ts snapshot|preflight|evaluate|monitor --output <path>",
  );
}

async function finishEvaluation(outputPath: string, evaluation: D1BudgetEvaluation) {
  await writeJson(outputPath, evaluation);
  await githubOutputs({
    budget_passed: String(evaluation.passed),
    budget_action: evaluation.action,
    budget_reasons: evaluation.reasons.join(","),
    current_percent: String(evaluation.metrics.currentPercent),
    projected_percent: String(evaluation.metrics.projectedPercent),
    governing_metric: evaluation.metrics.governingMetric,
    projected_worker_requests: String(evaluation.metrics.workerRequestsProjected),
    projected_worker_cpu_ms: String(evaluation.metrics.workerCpuMsProjected),
    projected_rows_read: String(evaluation.metrics.d1RowsReadProjected),
    projected_rows_written: String(evaluation.metrics.d1RowsWrittenProjected),
    projected_storage_bytes: String(evaluation.metrics.d1StorageBytesProjected),
  });
  console.log(JSON.stringify(evaluation, null, 2));
  if (!evaluation.passed) process.exitCode = 1;
}

function extractEvidence(value: unknown): D1QuotaEvidence {
  if (isRecord(value) && isRecord(value["quota"]) && "evidence" in value["quota"]) {
    return assertD1QuotaEvidence(value["quota"]["evidence"]);
  }
  if (isRecord(value) && "evidence" in value) {
    return assertD1QuotaEvidence(value["evidence"]);
  }
  return assertD1QuotaEvidence(value);
}

function parseArguments(values: string[]) {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("d1_budget_argument_invalid");
    result.set(key.slice(2), value);
  }
  return result;
}

function requiredArgument(args: Map<string, string>, name: string) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function githubOutputs(values: Record<string, string>) {
  const path = process.env["GITHUB_OUTPUT"];
  if (!path) return;
  await appendFile(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value.replace(/[\r\n]/g, " ")}`)
      .join("\n")}\n`,
    "utf8",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
