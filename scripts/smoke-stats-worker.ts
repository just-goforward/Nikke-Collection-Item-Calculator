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
    stats: statsResponse.status,
    preflight: preflightResponse.status,
    blockedOrigin: blockedOriginResponse.status,
    adminFailClosed: adminResponse.status,
  }),
);
