import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
const EXPECTED_SHA = "a".repeat(40);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Forecast interaction Router readiness", () => {
  it("waits for an older deployment SHA to stop serving", async () => {
    let requests = 0;
    const result = await runSmoke(() => {
      requests += 1;
      return health(requests < 3 ? "b".repeat(40) : EXPECTED_SHA);
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Forecast interactions Router is ready");
    expect(requests).toBe(3);
  });

  it("fails immediately when the current deployment returns a malformed contract", async () => {
    let requests = 0;

    await expect(
      runSmoke(() => {
        requests += 1;
        return { status: "ok", deploymentSha: EXPECTED_SHA };
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("forecast_interactions_health_databases_missing"),
    });
    expect(requests).toBe(1);
  });
});

async function runSmoke(body: () => unknown) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing_test_server_address");

  return execFileAsync(
    process.execPath,
    ["scripts/smoke-forecast-interactions.ts", `http://127.0.0.1:${address.port}`],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORECAST_EXPECTED_DEPLOY_SHA: EXPECTED_SHA,
        FORECAST_READINESS_TIMEOUT_MS: "1000",
        FORECAST_READINESS_RETRY_MS: "10",
      },
    },
  );
}

function health(deploymentSha: string) {
  return {
    status: "ok",
    deploymentSha,
    productionMutationsEnabled: false,
    databases: { staging: { schemaVersion: 9 } },
  };
}
