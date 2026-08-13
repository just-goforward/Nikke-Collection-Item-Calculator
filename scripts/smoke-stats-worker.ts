import { StatsApiResponseSchema } from "../src/schemas.ts";

const endpoint = process.argv[2];
const allowedOrigin = process.argv[3] ?? "https://just-goforward.github.io";

if (!endpoint) {
  throw new Error("Usage: npm run smoke:stats-worker -- <worker-url> [allowed-origin]");
}

const baseUrl = new URL(endpoint);
baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function endpointUrl(path: string): URL {
  return new URL(path, `${baseUrl.toString().replace(/\/+$/, "")}/`);
}

function assertCors(response: Response, test: string) {
  assert(
    response.headers.get("access-control-allow-origin") === allowedOrigin,
    `${test}: expected Access-Control-Allow-Origin ${allowedOrigin}`,
  );
}

const statsResponse = await fetch(endpointUrl("api/stats"), {
  headers: { Accept: "application/json", Origin: allowedOrigin },
});
assert(statsResponse.status === 200, `stats: expected 200, received ${statsResponse.status}`);
assertCors(statsResponse, "stats");

const stats: unknown = await statsResponse.json();
const parsedStats = StatsApiResponseSchema.safeParse(stats);
assert(
  parsedStats.success,
  `stats: response does not satisfy the frontend contract: ${JSON.stringify(parsedStats.error?.issues ?? [])}`,
);

const healthResponse = await fetch(endpointUrl("api/health"), {
  headers: { Accept: "application/json", Origin: allowedOrigin },
});
assert(healthResponse.status === 200, `health: expected 200, received ${healthResponse.status}`);
assertCors(healthResponse, "health");
const health = (await healthResponse.json()) as {
  ok?: unknown;
  schemaContractVersion?: unknown;
};
assert(
  health.ok === true && health.schemaContractVersion === 1,
  `health: unexpected schema contract response: ${JSON.stringify(health)}`,
);

const writeContractResponse = await fetch(endpointUrl("api/events"), {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: allowedOrigin },
  body: JSON.stringify({
    version: 1,
    eventId: `worker-smoke-${Date.now()}`,
    turnstileToken: "worker-smoke-invalid-token",
    event: {
      kind: "runtime_invariant",
      invariantVersion: 1,
      code: "worker_idle_pending",
      component: "worker_client",
      lane: "unknown",
    },
  }),
});
assert(
  writeContractResponse.status === 403,
  `write contract: expected Turnstile rejection 403, received ${writeContractResponse.status}`,
);
assertCors(writeContractResponse, "write contract");
const writeContractBody = (await writeContractResponse.json()) as { error?: unknown };
assert(
  writeContractBody.error === "turnstile_failed",
  `write contract: event did not reach Turnstile verification: ${JSON.stringify(writeContractBody)}`,
);

const preflightResponse = await fetch(endpointUrl("api/stats"), {
  method: "OPTIONS",
  headers: {
    Origin: allowedOrigin,
    "Access-Control-Request-Method": "GET",
  },
});
assert(
  preflightResponse.status === 204,
  `preflight: expected 204, received ${preflightResponse.status}`,
);
assertCors(preflightResponse, "preflight");

const blockedOriginResponse = await fetch(endpointUrl("api/stats"), {
  headers: { Origin: "https://worker-smoke.invalid" },
});
assert(
  blockedOriginResponse.status === 403,
  `blocked origin: expected 403, received ${blockedOriginResponse.status}`,
);

const adminResponse = await fetch(endpointUrl("api/admin/solver-diagnostics"), {
  headers: { Origin: allowedOrigin },
});
assert(
  adminResponse.status === 403 || adminResponse.status === 404,
  `admin: expected fail-closed 403 or 404, received ${adminResponse.status}`,
);

console.log(
  JSON.stringify({
    endpoint: baseUrl.toString().replace(/\/+$/, ""),
    health: healthResponse.status,
    stats: statsResponse.status,
    writeContract: writeContractResponse.status,
    preflight: preflightResponse.status,
    blockedOrigin: blockedOriginResponse.status,
    adminFailClosed: adminResponse.status,
  }),
);
