import { describe, expect, it, vi } from "vitest";
import { D1_SCHEMA_CONTRACT_VERSION, REQUIRED_D1_SCHEMA } from "../shared/d1SchemaContract";
import {
  SOLVER_RECOVERY_EMIT_POLICY_VERSION,
  SOLVER_RECOVERY_EMIT_VERSION,
} from "../shared/solverRecoveryContract";
import { runStatsSmoke, statsSmokeFailureClass } from "./smoke-stats-worker";
import { STATS_GATEWAY_ORIGIN, STATS_PROBE_PATH } from "./stats-worker-health";

const token = "a".repeat(43);
const stats = {
  windowDays: 0,
  today: "2026-10-20",
  byKit: [],
  segmentStats: [],
  summary: {
    events: 0,
    attempts: 0,
    greatSuccesses: 0,
    greatSuccessRate: 0,
    todayEvents: 0,
    todayAttempts: 0,
    todayGreatSuccesses: 0,
    mostUsedKit: null,
    mostUsedKitPieces: 0,
  },
};
const health = {
  ok: true,
  schemaContractVersion: D1_SCHEMA_CONTRACT_VERSION,
  acceptedRecoveryVersions: [SOLVER_RECOVERY_EMIT_VERSION],
  acceptedRecoveryPolicyVersions: [SOLVER_RECOVERY_EMIT_POLICY_VERSION],
};

function fixture(profile: "gateway" | "direct" | "direct-staging" = "gateway") {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const cors = { "Access-Control-Allow-Origin": STATS_GATEWAY_ORIGIN };
    if (
      url.pathname === STATS_PROBE_PATH ||
      (profile !== "gateway" && url.pathname === "/api/health")
    ) {
      return headers.has("Authorization") || profile !== "gateway"
        ? Response.json(health, { headers: profile !== "gateway" ? cors : {} })
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.pathname === "/api/stats" && init?.method === "OPTIONS") {
      if (profile === "gateway")
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      return new Response(null, {
        status: headers.get("Origin") === STATS_GATEWAY_ORIGIN ? 204 : 403,
        headers: cors,
      });
    }
    if (url.pathname === "/api/stats") return Response.json(stats, { headers: cors });
    if (url.pathname === "/api/events")
      return Response.json({ error: "turnstile_failed" }, { status: 403, headers: cors });
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  return {
    profile,
    token,
    fetchImpl,
    sleep: async () => undefined,
    endpoint: {
      gateway: STATS_GATEWAY_ORIGIN,
      direct: "https://collection-kit-stats.tbvj159.workers.dev",
      "direct-staging": "https://collection-kit-stats-staging.tbvj159.workers.dev",
    }[profile],
  };
}

describe("stats smoke transport contract", () => {
  it.each(["gateway", "direct", "direct-staging"] as const)(
    "preserves full %s checks without leaking credentials",
    async (profile) => {
      const options = fixture(profile);
      const result = await runStatsSmoke(options);
      expect(result).toMatchObject({
        health: 200,
        stats: 200,
        writeContract: 403,
        preflight: profile === "gateway" ? 405 : 204,
        blockedOrigin: profile === "gateway" ? 405 : 403,
        adminFailClosed: 404,
        requests: profile === "gateway" ? 8 : 6,
      });
      for (const [input, init] of options.fetchImpl.mock.calls) {
        const url = new URL(String(input));
        const credential = new Headers(init?.headers).get("Authorization");
        if (credential) {
          expect(profile).toBe("gateway");
          expect(url.href).toBe(`${STATS_GATEWAY_ORIGIN}${STATS_PROBE_PATH}`);
          expect(credential).toBe(`Bearer ${token}`);
        }
        expect(init?.redirect).toBe("error");
      }
    },
  );

  it("frontend-only still probes schema/recovery and omits events", async () => {
    const options = fixture();
    expect(await runStatsSmoke({ ...options, mode: "frontend-contract-only" })).toMatchObject({
      health: 200,
      writeContract: "skipped",
      requests: 7,
    });
    expect(
      options.fetchImpl.mock.calls.some(
        ([input]) => new URL(String(input)).pathname === "/api/events",
      ),
    ).toBe(false);
  });

  it.each([
    { profile: undefined },
    { profile: "unknown" },
    { endpoint: "https://evil.example" },
    { endpoint: `${STATS_GATEWAY_ORIGIN}/api/stats` },
    { token: "short" },
    { allowedOrigin: "https://evil.example" },
    { profile: "direct", endpoint: STATS_GATEWAY_ORIGIN },
  ])("validates configuration before all network access: %j", async (change) => {
    const options = fixture();
    await expect(runStatsSmoke({ ...options, ...change })).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });

  it("validate-only is offline and readiness-only performs only the health episode", async () => {
    const options = fixture();
    await runStatsSmoke({ ...options, mode: "validate-only" });
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(await runStatsSmoke({ ...options, mode: "readiness-only" })).toMatchObject({
      health: 200,
      requests: 1,
    });
    expect(options.fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["direct-staging", "https://collection-kit-stats.tbvj159.workers.dev"],
    ["direct", "https://collection-kit-stats-staging.tbvj159.workers.dev"],
    ["direct-staging", "https://collection-kit-stats-staging.tbvj159.workers.dev/"],
    ["direct", "https://collection-kit-stats.tbvj159.workers.dev/"],
    ["gateway", `${STATS_GATEWAY_ORIGIN}/`],
  ])("rejects the wrong exact origin for %s before any request", async (profile, endpoint) => {
    const options = fixture();
    await expect(runStatsSmoke({ ...options, profile, endpoint })).rejects.toThrow(
      "endpoint/profile mismatch",
    );
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("recovery transport orchestration", () => {
  it.each([
    [503, "database_schema_not_ready", true],
    [503, "telemetry_budget_disabled", false],
    [500, "internal_error", undefined],
    [502, "service_unavailable", undefined],
  ])(
    "orchestrates unhealthy %s %s → authorized correction → healthy full verification",
    async (status, error, retryable) => {
      const options = fixture();
      const correction = vi.fn(async () => undefined);
      options.fetchImpl.mockResolvedValueOnce(Response.json({ error, retryable }, { status }));
      const readiness = await runStatsSmoke({ ...options, mode: "readiness-only" });
      expect(readiness).toMatchObject({
        transport: "backend-reached",
        health: status,
        backendHealth: error,
        requests: 1,
      });
      await correction();
      const result = await runStatsSmoke(options);
      expect(result).toMatchObject({ health: 200, stats: 200, writeContract: 403 });
      expect(correction).toHaveBeenCalledOnce();
      expect(options.fetchImpl).toHaveBeenCalledTimes(9);
    },
  );

  it("blocks corrective-operation orchestration when authentication fails", async () => {
    const options = fixture();
    options.fetchImpl.mockImplementation(async () =>
      Response.json({ error: "not_found" }, { status: 404 }),
    );
    const correction = vi.fn(async () => undefined);
    async function recover() {
      await runStatsSmoke({ ...options, mode: "readiness-only" });
      await correction();
      return runStatsSmoke(options);
    }
    await expect(recover()).rejects.toThrow("authentication/routing uncertainty");
    expect(correction).not.toHaveBeenCalled();
    expect(options.fetchImpl).toHaveBeenCalledTimes(60);
  });

  it.each([
    [503, "service_unavailable"],
    [502, "service_not_configured"],
    [503, "service_not_configured"],
  ])("blocks recovery on %s %s", async (status, error) => {
    const options = fixture();
    options.fetchImpl.mockResolvedValueOnce(Response.json({ error }, { status }));
    const correction = vi.fn(async () => undefined);
    async function recover() {
      await runStatsSmoke({ ...options, mode: "readiness-only" });
      await correction();
      return runStatsSmoke(options);
    }
    await expect(recover()).rejects.toThrow("verification unavailable (transport)");
    expect(correction).not.toHaveBeenCalled();
    expect(options.fetchImpl).toHaveBeenCalledOnce();
  });

  it("redacts arbitrary backend error text from the readiness summary", async () => {
    const options = fixture();
    options.fetchImpl.mockResolvedValueOnce(
      Response.json({ error: `private details ${token}` }, { status: 500 }),
    );
    const summary = await runStatsSmoke({ ...options, mode: "readiness-only" });
    expect(summary).toMatchObject({ health: 500, backendHealth: "backend_error" });
    expect(JSON.stringify(summary)).not.toContain(token);
    expect(JSON.stringify(summary)).not.toContain("private details");
  });
});

describe("unavailable verification failure classification", () => {
  it.each(["service_unavailable", "service_not_configured"])(
    "preserves the %s transport failure class for precautionary restore reporting",
    async (error) => {
      const options = fixture();
      options.fetchImpl.mockResolvedValueOnce(Response.json({ error }, { status: 503 }));
      const restore = vi.fn(async (_classification: string) => undefined);
      try {
        await runStatsSmoke(options);
        throw new Error("Expected unavailable transport");
      } catch (failure) {
        expect(String(failure)).toContain("verification unavailable (transport)");
        await restore(statsSmokeFailureClass(failure));
      }
      expect(restore).toHaveBeenCalledWith("transport");
      expect(options.fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [429, {}, "rate limited"],
    [200, { "cf-mitigated": "challenge" }, "challenge"],
  ])("classifies health %s exhaustion as transport", async (status, headers, message) => {
    const options = fixture();
    options.fetchImpl.mockImplementation(
      async () => new Response("not health", { status, headers }),
    );
    try {
      await runStatsSmoke(options);
      throw new Error("Expected unavailable verification");
    } catch (error) {
      expect(String(error)).toContain(message);
      expect(statsSmokeFailureClass(error)).toBe("transport");
    }
    expect(options.fetchImpl).toHaveBeenCalledTimes(60);
  });

  it("classifies a public stats challenge as transport without retrying it", async () => {
    const options = fixture();
    options.fetchImpl
      .mockResolvedValueOnce(Response.json(health))
      .mockResolvedValueOnce(
        new Response("challenge", { headers: { "cf-mitigated": "challenge" } }),
      );
    try {
      await runStatsSmoke(options);
      throw new Error("Expected unavailable verification");
    } catch (error) {
      expect(String(error)).toContain("public contract challenge");
      expect(statsSmokeFailureClass(error)).toBe("transport");
    }
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not misclassify a later backend contract failure as an earlier rate limit", async () => {
    const options = fixture();
    options.fetchImpl
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ error: "internal_error" }, { status: 500 }));
    try {
      await runStatsSmoke(options);
      throw new Error("Expected backend contract failure");
    } catch (error) {
      expect(String(error)).toContain("unexpected contract");
      expect(statsSmokeFailureClass(error)).toBe("other");
    }
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("stats smoke contract and budgets", () => {
  it.each([{ acceptedRecoveryVersions: [] }, { acceptedRecoveryPolicyVersions: [] }])(
    "fails frontend-only on incompatible recovery contracts %j",
    async (change) => {
      const options = fixture();
      options.fetchImpl.mockResolvedValueOnce(Response.json({ ...health, ...change }));
      await expect(runStatsSmoke({ ...options, mode: "frontend-contract-only" })).rejects.toThrow(
        "health contract",
      );
    },
  );

  it("pins the approved health budget to 28 schema probes plus one guard read", () => {
    expect(Object.keys(REQUIRED_D1_SCHEMA)).toHaveLength(28);
    expect(60 * (28 + 1) + 3).toBe(1_743);
    expect(3 * 60 * (28 + 1) + 2 * 3).toBe(5_226);
  });

  it("bounds a full pass at 60 health attempts plus seven public checks", async () => {
    const options = fixture();
    for (let index = 0; index < 59; index += 1) {
      options.fetchImpl.mockResolvedValueOnce(
        Response.json({ ...health, schemaContractVersion: D1_SCHEMA_CONTRACT_VERSION - 1 }),
      );
    }
    expect(await runStatsSmoke(options)).toMatchObject({ requests: 67, health: 200 });
    expect(options.fetchImpl).toHaveBeenCalledTimes(67);
  });

  it("does not accept a broken stats schema", async () => {
    const options = fixture();
    options.fetchImpl.mockResolvedValueOnce(Response.json(health)).mockResolvedValueOnce(
      Response.json(
        {},
        {
          headers: { "Access-Control-Allow-Origin": STATS_GATEWAY_ORIGIN },
        },
      ),
    );
    await expect(runStatsSmoke(options)).rejects.toThrow("frontend contract");
  });
});
