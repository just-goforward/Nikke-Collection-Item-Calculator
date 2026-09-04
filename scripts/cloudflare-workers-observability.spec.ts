import { describe, expect, it, vi } from "vitest";
import {
  buildInvocationQuery,
  collectForecastRuntimeTelemetry,
  parseInvocationSamples,
  splitInvocationQueryWindows,
  unavailableForecastRuntimeTelemetry,
} from "./lib/cloudflare-workers-observability.ts";

const SHA = "a".repeat(40);
const START = "2026-09-03T00:00:00.000Z";
const END = "2026-09-03T08:00:00.000Z";
const SHORT_END = "2026-09-03T00:30:00.000Z";
const COLLECTOR_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const DISPATCHER_VERSION_ID = "22222222-2222-4222-8222-222222222222";

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

  it("splits a long immutable window into bounded half-hour queries", () => {
    const windows = splitInvocationQueryWindows(START, END);

    expect(windows).toHaveLength(16);
    expect(windows[0]).toEqual({ startedAt: START, endedAt: SHORT_END });
    expect(windows.at(-1)).toEqual({
      startedAt: "2026-09-03T07:30:00.000Z",
      endedAt: END,
    });
  });

  it("extracts only privacy-reduced scheduled invocation evidence", async () => {
    const samples = await parseInvocationSamples(fixture("req-secret-1", "ok"), {
      component: "collector",
      scriptName: "collection-kit-forecast-collector-staging",
      deploymentSha: SHA,
      expectedScriptVersion: `${SHA}-both-v10`,
      expectedScriptVersionId: COLLECTOR_VERSION_ID,
      startedAt: START,
      endedAt: END,
    });
    expect(samples).toEqual([
      expect.objectContaining({
        slot: "2026-09-03T00:03:00.000Z",
        scriptVersionId: COLLECTOR_VERSION_ID,
        scriptVersionTag: `${SHA}-both-v10`,
        identitySource: "tag",
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
      expectedScriptVersion: `${SHA}-both-v10`,
      expectedScriptVersionId: COLLECTOR_VERSION_ID,
      startedAt: START,
      endedAt: END,
    });
    expect(samples[0]?.outcome).toBe("exceededCpu");
  });

  it("represents a marker without a runtime summary as a coverage gap", async () => {
    const value = fixture("req-marker-without-runtime", "ok");
    const events = invocationEvents(value, "req-marker-without-runtime");
    const runtimeWorkers = events[0]?.["$workers"];
    if (!isRecord(runtimeWorkers)) throw new Error("missing_runtime_workers");
    delete runtimeWorkers["cpuTimeMs"];

    const samples = await parseInvocationSamples(value, expectedCollector());

    expect(samples).toEqual([]);
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
        expectedScriptVersion: `${SHA}-both-v10`,
        expectedScriptVersionId: COLLECTOR_VERSION_ID,
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
        collectorScriptVersion: `${SHA}-both-v10`,
        dispatcherScriptVersion: `${SHA}-v10`,
        collectorScriptVersionId: COLLECTOR_VERSION_ID,
        dispatcherScriptVersionId: DISPATCHER_VERSION_ID,
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
      endedAt: SHORT_END,
      collectorScriptVersion: `${SHA}-both-v10`,
      dispatcherScriptVersion: `${SHA}-v10`,
      collectorScriptVersionId: COLLECTOR_VERSION_ID,
      dispatcherScriptVersionId: DISPATCHER_VERSION_ID,
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
    });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(evidence.workers.map((worker) => worker.samples.length)).toEqual([1, 1]);
  });
});

describe("Workers Observability bounded query windows", () => {
  it("combines complete invocation evidence from all half-hour slices", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        queryId: string;
        timeframe: { from: number; to: number };
      };
      const collector = body.queryId.includes("collector-staging");
      const slot = new Date(body.timeframe.from + 3 * 60 * 1_000).toISOString();
      return Response.json(
        fixture(
          `${collector ? "collector" : "dispatcher"}-${body.timeframe.from}`,
          "ok",
          collector ? "collector" : "dispatcher",
          slot,
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
      collectorScriptVersion: `${SHA}-both-v10`,
      dispatcherScriptVersion: `${SHA}-v10`,
      collectorScriptVersionId: COLLECTOR_VERSION_ID,
      dispatcherScriptVersionId: DISPATCHER_VERSION_ID,
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
    });

    expect(fetchImpl).toHaveBeenCalledTimes(32);
    expect(evidence.workers.map((worker) => worker.samples.length)).toEqual([16, 16]);
  });
});

describe("Workers Observability optional version identity", () => {
  it("accepts the documented optional tag when an immutable version ID is present", async () => {
    const value = fixture("req-id-only", "ok");
    const events = invocationEvents(value, "req-id-only");
    const workers = events[0]?.["$workers"];
    if (!isRecord(workers)) throw new Error("missing_runtime_workers");
    workers["scriptVersion"] = { id: COLLECTOR_VERSION_ID };

    const samples = await parseInvocationSamples(value, expectedCollector());

    expect(samples[0]).toMatchObject({
      scriptVersionId: COLLECTOR_VERSION_ID,
      scriptVersionTag: null,
      identitySource: "version_id",
    });
  });

  it("finds version metadata in a separate event from the CPU summary", async () => {
    const value = fixture("req-split", "ok");
    const events = invocationEvents(value, "req-split");
    const runtimeWorkers = events[0]?.["$workers"];
    const markerWorkers = events[1]?.["$workers"];
    if (!isRecord(runtimeWorkers) || !isRecord(markerWorkers)) throw new Error("missing_workers");
    delete runtimeWorkers["scriptVersion"];
    markerWorkers["scriptVersion"] = {
      id: COLLECTOR_VERSION_ID,
      tag: `${SHA}-both-v10`,
    };

    const samples = await parseInvocationSamples(value, expectedCollector());

    expect(samples[0]?.identitySource).toBe("tag");
  });

  it("accepts marker identity when Cloudflare omits all optional version metadata", async () => {
    const value = fixture("req-marker-only", "ok");
    const events = invocationEvents(value, "req-marker-only");
    for (const event of events) {
      const workers = event["$workers"];
      if (isRecord(workers)) delete workers["scriptVersion"];
    }

    const samples = await parseInvocationSamples(value, expectedCollector());

    expect(samples[0]).toMatchObject({
      scriptVersionId: null,
      scriptVersionTag: null,
      identitySource: "marker",
    });
  });

  it("rejects a conflicting immutable version ID", async () => {
    const value = fixture("req-wrong-version", "ok");
    const events = invocationEvents(value, "req-wrong-version");
    const workers = events[0]?.["$workers"];
    if (!isRecord(workers)) throw new Error("missing_runtime_workers");
    workers["scriptVersion"] = { id: DISPATCHER_VERSION_ID };

    await expect(parseInvocationSamples(value, expectedCollector())).rejects.toThrow(
      "observability_version_identity_mismatch",
    );
  });
});

function fixture(
  requestId: string,
  outcome: string,
  component: "collector" | "dispatcher" = "collector",
  slot = "2026-09-03T00:03:00.000Z",
) {
  const scriptName = `collection-kit-forecast-${component}-staging`;
  const scriptVersion = component === "collector" ? `${SHA}-both-v10` : `${SHA}-v10`;
  const scriptVersionId = component === "collector" ? COLLECTOR_VERSION_ID : DISPATCHER_VERSION_ID;
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
              scriptVersion: { id: scriptVersionId, tag: scriptVersion },
            },
          },
          {
            source: JSON.stringify(marker(slot, component)),
            $metadata: { id: "custom-event", service: scriptName },
            $workers: { eventType: "scheduled", scriptName },
          },
        ],
      },
    },
  };
}

function expectedCollector() {
  return {
    component: "collector" as const,
    scriptName: "collection-kit-forecast-collector-staging",
    deploymentSha: SHA,
    expectedScriptVersion: `${SHA}-both-v10`,
    expectedScriptVersionId: COLLECTOR_VERSION_ID,
    startedAt: START,
    endedAt: END,
  };
}

function invocationEvents(value: ReturnType<typeof fixture>, requestId: string) {
  const events = (value.result.invocations as Record<string, Array<Record<string, unknown>>>)[
    requestId
  ];
  if (!events) throw new Error("missing_fixture_invocation");
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function marker(slot: string, component: "collector" | "dispatcher" = "collector") {
  return {
    event: "forecast_canary_scheduled_invocation",
    component,
    deploymentSha: SHA,
    slot,
  };
}
