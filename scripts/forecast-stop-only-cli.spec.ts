import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { main } from "./forecast-stop-only.ts";
import { accountId, fixture } from "./test-forecast-stop-only.ts";
import { stopTestDirectory } from "./test-forecast-stop-temp.ts";

it("actual CLI independently records Dispatcher failure, Collector success and REST recheck", async () => {
  const f = fixture();
  f.fail.add("dispatcher");
  const directory = stopTestDirectory("cli-");
  const baseline = stopTestDirectory("cli-baseline-");
  for (const role of ["collector", "dispatcher"])
    writeFileSync(`${baseline}/${role}-requests.jsonl`, "");
  const calls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.hostname === "api.github.com")
      return Response.json({ value: JSON.stringify(await f.api.registry()) });
    const role = url.pathname.includes("forecast-dispatcher-staging") ? "dispatcher" : "collector";
    if (url.pathname.includes("/versions/"))
      return Response.json({
        success: true,
        result: {
          id: f.registry.workers[role].versionId,
          resources: {
            bindings: [
              { type: "plain_text", name: "ENVIRONMENT", text: "staging" },
              {
                type: "plain_text",
                name: role === "collector" ? "COLLECT_ENABLED" : "DISPATCH_ENABLED",
                text: "false",
              },
            ],
          },
        },
      });
    if (init?.method === "POST") {
      if (role === "dispatcher") return new Response(null, { status: 403 });
      const body = JSON.parse(String(init.body));
      return Response.json({
        success: true,
        result: await f.api.deploy(f.registry, role, body.annotations["workers/message"]),
      });
    }
    return Response.json({
      success: true,
      result: {
        deployments: f.entries[role].map((d) => ({
          id: d.id,
          created_on: d.createdOn,
          annotations: { "workers/message": d.message },
          versions: d.versions.map((v) => ({ version_id: v.versionId, percentage: v.percentage })),
        })),
      },
      result_info: { total_pages: 1 },
    });
  });
  const vars = {
    FORECAST_STOP_ONLY_EXECUTION_APPROVED: "true",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    GITHUB_REPOSITORY: "just-goforward/Nikke-Collection-Item-Calculator",
    GH_TOKEN: "mock",
    CLOUDFLARE_API_TOKEN: "mock",
    BUDGET_STOP: "true",
    FORECAST_STOP_REQUEST_BASELINE_DIR: baseline,
  };
  const oldExitCode = process.exitCode;
  vi.stubGlobal("fetch", fetch);
  try {
    await main(["prepare", directory], vars);
    await main(["worker", directory, "dispatcher"], vars);
    expect(process.exitCode).toBe(1);
    await main(["worker", directory, "collector"], vars);
    await main(["finalize", directory], vars);
    const read = (name: string) => JSON.parse(readFileSync(`${directory}/${name}.json`, "utf8"));
    expect(read("dispatcher").state).toBe("unknown");
    expect(read("collector")).toMatchObject({ state: "verified", currentVerified: true });
    expect(read("aggregate")).toMatchObject({
      fail: true,
      alert: true,
      registryStable: true,
      epochComparison: "unavailable",
    });
    expect(calls.filter((url) => url.includes("actions/variables/"))).toHaveLength(2);
    expect(
      calls.every(
        (url) => !url.includes("/health") && !url.includes("/d1/") && !url.includes("/admin/"),
      ),
    ).toBe(true);
    expect(readFileSync(`${directory}/collector-requests.jsonl`, "utf8")).toContain('"submitted"');
  } finally {
    process.exitCode = oldExitCode;
    vi.unstubAllGlobals();
  }
});
