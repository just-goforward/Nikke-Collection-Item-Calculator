import { describe, expect, it, vi } from "vitest";
import {
  buildInvocationQuery,
  collectForecastRuntimeTelemetry,
  parseInvocationSamples,
  unavailableForecastRuntimeTelemetry,
} from "./lib/cloudflare-workers-observability.ts";

const SHA = "a".repeat(40);
const START = "2026-09-03T00:00:00.000Z";
const END = "2026-09-03T08:00:00.000Z";

describe("Workers Observability forecast runtime evidence", () => {
  it("builds an invocation query constrained to one script and exact window", () => {
    expect(buildInvocationQuery("worker-name", START, END)).toMatchObject({
      timeframe: { from: Date.parse(START), to: Date.parse(END) },
      view: "invocations",
      limit: 2_000,
      parameters: {
        datasets: ["cloudflare-workers"],
        filters: [{ key: "$metadata.service", operation: "eq", value: "worker-name" }],
      },
    });
  });

  it("extracts only privacy-reduced scheduled invocation evidence", async () => {
    const samples = await parseInvocationSamples(fixture("req-secret-1", "ok"), {
      component: "collector",
      scriptName: "collection-kit-forecast-collector-staging",
      deploymentSha: SHA,
      expectedScriptVersion: `${SHA}-both-v9`,
      startedAt: START,
      endedAt: END,
    });
    expect(samples).toEqual([
      expect.objectContaining({
        slot: "2026-09-03T00:03:00.000Z",
        scriptVersion: `${SHA}-both-v9`,
        eventType: "scheduled",
        cpuTimeMs: 41.169,
        outcome: "ok",
      }),
    ]);
    expect(samples[0]?.requestIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(samples)).not.toContain("req-secret-1");
  });

  it("keeps unsuccessful runtime outcomes as evidence for the hard gate", async () => {
    const samples = await parseInvocationSamples(fixture("req-2", "exceededCpu"), {
      component: "collector",
      scriptName: "collection-kit-forecast-collector-staging",
      deploymentSha: SHA,
      expectedScriptVersion: `${SHA}-both-v9`,
      startedAt: START,
      endedAt: END,
    });
    expect(samples[0]?.outcome).toBe("exceededCpu");
  });

  it("rejects a marker outside the immutable query window", async () => {
    const value = fixture("req-3", "ok");
    const invocation = (value.result.invocations as Record<string, Array<Record<string, unknown>>>)[
      "req-3"
    ];
    if (!invocation?.[1]) throw new Error("missing_fixture_marker");
    invocation[1]["source"] = JSON.stringify(marker("2026-09-04T00:03:00.000Z"));
    await expect(
      parseInvocationSamples(value, {
        component: "collector",
        scriptName: "collection-kit-forecast-collector-staging",
        deploymentSha: SHA,
        expectedScriptVersion: `${SHA}-both-v9`,
        startedAt: START,
        endedAt: END,
      }),
    ).rejects.toThrow("observability_marker_slot_outside_window");
  });

  it("serializes final query failures as explicit incomplete evidence", () => {
    const evidence = unavailableForecastRuntimeTelemetry(
      {
        canaryId: `fc-${"b".repeat(32)}`,
        deploymentSha: SHA,
        startedAt: START,
        endedAt: END,
        collectorScriptVersion: `${SHA}-both-v9`,
        dispatcherScriptVersion: `${SHA}-v9`,
      },
      new Error("observability_http_403"),
    );

    expect(evidence.collectionErrors).toEqual(["observability_http_403"]);
    expect(evidence.workers).toEqual([
      expect.objectContaining({ component: "collector", samples: [] }),
      expect.objectContaining({ component: "dispatcher", samples: [] }),
    ]);
  });

  it("retries 429 responses and returns the two worker samples", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls <= 2) return new Response("rate limited", { status: 429 });
      const body = JSON.parse(String(init?.body)) as { queryId: string };
      const collector = body.queryId.includes("collector-staging");
      return Response.json(
        fixture(
          collector ? "collector-request" : "dispatcher-request",
          "ok",
          collector ? "collector" : "dispatcher",
        ),
      );
    });

    const evidence = await collectForecastRuntimeTelemetry({
      accountId: "c".repeat(32),
      token: "test-token",
      canaryId: `fc-${"b".repeat(32)}`,
      deploymentSha: SHA,
      startedAt: START,
      endedAt: END,
      collectorScriptVersion: `${SHA}-both-v9`,
      dispatcherScriptVersion: `${SHA}-v9`,
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
    });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(evidence.workers.map((worker) => worker.samples.length)).toEqual([1, 1]);
  });
});

function fixture(
  requestId: string,
  outcome: string,
  component: "collector" | "dispatcher" = "collector",
) {
  const scriptName = `collection-kit-forecast-${component}-staging`;
  const scriptVersion = component === "collector" ? `${SHA}-both-v9` : `${SHA}-v9`;
  return {
    errors: [],
    result: {
      invocations: {
        [requestId]: [
          {
            source: "cron",
            $metadata: { id: "runtime-event", service: scriptName },
            $workers: {
              cpuTimeMs: 41.169,
              eventType: "scheduled",
              outcome,
              requestId,
              scriptName,
              scriptVersion: { tag: scriptVersion },
            },
          },
          {
            source: JSON.stringify(marker("2026-09-03T00:03:00.000Z", component)),
            $metadata: { id: "custom-event", service: scriptName },
            $workers: { eventType: "scheduled", scriptName },
          },
        ],
      },
    },
  };
}

function marker(slot: string, component: "collector" | "dispatcher" = "collector") {
  return {
    event: "forecast_canary_scheduled_invocation",
    component,
    deploymentSha: SHA,
    slot,
  };
}
