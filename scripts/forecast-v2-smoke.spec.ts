import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cleanups: Array<() => void | Promise<void>> = [];
const sha = "a".repeat(40);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(body: (request: IncomingMessage) => unknown) {
  const instance = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body(request)));
  });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => instance.close(() => resolve())));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("missing_test_server_address");
  return `http://127.0.0.1:${address.port}`;
}

it("collector smoke verifies identity and candidates using GET requests only", async () => {
  const calls: { method: string | undefined; path: string; authorization: string | undefined }[] =
    [];
  const url = await server((request) => {
    const path = request.url ?? "";
    calls.push({
      method: request.method,
      path,
      authorization: request.headers.authorization,
    });
    switch (path) {
      case "/health":
        return { status: "ok" };
      case "/admin/canary-report":
        return { deploymentSha: sha };
      case "/admin/schedule-ledger":
        return { events: [] };
      case "/admin/candidates":
        return { candidates: [] };
      default:
        return { error: "unexpected_route" };
    }
  });
  await execFileAsync(
    process.execPath,
    ["scripts/smoke-forecast-collector.ts", url, "test-admin-token"],
    { env: { ...process.env, FORECAST_EXPECTED_DEPLOY_SHA: sha } },
  );
  expect(calls).toEqual([
    { method: "GET", path: "/health", authorization: undefined },
    { method: "GET", path: "/admin/canary-report", authorization: "Bearer test-admin-token" },
    { method: "GET", path: "/admin/schedule-ledger", authorization: "Bearer test-admin-token" },
    { method: "GET", path: "/admin/candidates", authorization: "Bearer test-admin-token" },
  ]);
});

async function dispatcherSmoke(query: unknown) {
  const calls: string[] = [];
  const url = await server((request) => {
    calls.push(`${request.method} ${request.url}`);
    return { status: "ok", operations: { dispatcher: { status: "missing" } } };
  });
  const root = mkdtempSync(join(tmpdir(), "forecast-outbox-smoke-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "outbox.json");
  writeFileSync(path, JSON.stringify(query));
  const result = await execFileAsync(process.execPath, [
    "scripts/smoke-forecast-dispatcher.ts",
    url,
    path,
  ]);
  expect(calls).toEqual(["GET /health"]);
  return result;
}

function outboxes(state: string | null) {
  return [
    {
      success: true,
      results: [
        { queue: "publication", environment: "staging", state },
        { queue: "v2", environment: "staging", state },
      ],
    },
  ];
}

it.each([null, "pending", "sending", "sent", "dead"])(
  "dispatcher storage smoke accepts schema-valid state %s without claiming delivery",
  async (state) => {
    const result = await dispatcherSmoke(outboxes(state));
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      environment: "staging",
      outboxTablesReadable: true,
    });
    expect(result.stdout).not.toContain("discordSent");
  },
);

it("rejects a failed D1 query", async () => {
  await expect(dispatcherSmoke([{ success: false, results: [] }])).rejects.toMatchObject({
    stderr: expect.stringContaining("Staging outbox query failed"),
  });
});

it("rejects a missing outbox table result", async () => {
  const query = outboxes(null);
  query[0]?.results.pop();
  await expect(dispatcherSmoke(query)).rejects.toMatchObject({
    stderr: expect.stringContaining("Staging outbox query is incomplete"),
  });
});

it("rejects production outbox evidence", async () => {
  const query = outboxes("pending");
  for (const row of query[0]?.results ?? []) row.environment = "production";
  await expect(dispatcherSmoke(query)).rejects.toMatchObject({
    stderr: expect.stringContaining("Staging outbox query contract is invalid"),
  });
});

it("rejects legacy workflow-dispatch states", async () => {
  await expect(dispatcherSmoke(outboxes("succeeded"))).rejects.toMatchObject({
    stderr: expect.stringContaining("Staging outbox query contract is invalid"),
  });
});
