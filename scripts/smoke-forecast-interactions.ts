const baseUrl = requiredArgument(2, "Router URL").replace(/\/$/, "");
const expectedSha = requiredEnvironment("FORECAST_EXPECTED_DEPLOY_SHA");
const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(20_000) });
if (!response.ok) throw new Error(`forecast_interactions_health_${response.status}`);
const body = (await response.json()) as unknown;
if (!isRecord(body) || body["status"] !== "ok" || body["deploymentSha"] !== expectedSha) {
  throw new Error("forecast_interactions_health_identity_mismatch");
}
const databases = body["databases"];
if (!isRecord(databases)) throw new Error("forecast_interactions_health_databases_missing");
const productionEnabled = body["productionMutationsEnabled"] === true;
for (const environment of ["staging", ...(productionEnabled ? (["production"] as const) : [])]) {
  const database = databases[environment];
  if (!isRecord(database) || Number(database["schemaVersion"]) < 8) {
    throw new Error(`forecast_interactions_${environment}_schema_not_ready`);
  }
}
console.log(`Forecast interactions Router is ready at ${baseUrl}.`);

function requiredArgument(index: number, label: string) {
  const value = process.argv[index]?.trim();
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
