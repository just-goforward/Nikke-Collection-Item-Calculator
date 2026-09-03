import { appendFile, readFile, writeFile } from "node:fs/promises";
import {
  evaluateObserverCanary,
  type ObserverCanaryRow,
  type ObserverCanaryRunRow,
} from "../stats-observer/src/canary.ts";

const canary = (
  await firstResult<ObserverCanaryRow>(requiredEnvironment("OBSERVER_CANARY_ROW"))
)[0];
if (!canary) throw new Error("observer_canary_not_found");
const runs = await firstResult<ObserverCanaryRunRow>(requiredEnvironment("OBSERVER_CANARY_RUNS"));
const alerts = await firstResult<{ count: number }>(requiredEnvironment("OBSERVER_CANARY_ALERTS"));
const rejections = await firstResult<{ count: number }>(
  requiredEnvironment("OBSERVER_CANARY_REJECTIONS"),
);
const report = evaluateObserverCanary({
  canary,
  runs,
  unsentAlerts: Number(alerts[0]?.count ?? 0),
  contractRejections: Number(rejections[0]?.count ?? 0),
  nowMs: Date.now(),
});

const outputPath = process.env["OBSERVER_CANARY_REPORT_OUTPUT"];
if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const githubOutput = process.env["GITHUB_OUTPUT"];
if (githubOutput) {
  await appendFile(
    githubOutput,
    `passed=${report.passed}\ncanary_id=${report.canaryId}\ndeployment_sha=${report.deploymentSha}\n`,
    "utf8",
  );
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

async function firstResult<T>(path: string): Promise<T[]> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value) || !isRecord(value[0]) || !Array.isArray(value[0]["results"])) {
    throw new Error(`Invalid Wrangler D1 result: ${path}`);
  }
  return value[0]["results"] as T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
