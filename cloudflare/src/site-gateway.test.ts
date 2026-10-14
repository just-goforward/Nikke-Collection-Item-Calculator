import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import gateway from "../../site-worker/src/worker";
import config from "../wrangler.toml?raw";
import type { WorkerEnv } from "./env";
import statsWorker from "./worker";
import { kitResultEvent } from "./worker.test-events";
import { WorkerTestHarness } from "./worker.test-harness";

const productionOrigin = "https://nikkecollection.com";
const stagingOrigin = "https://staging.nikkecollection.com";
const productionOrigins = JSON.parse(
  config.match(/^\[vars\]\s*\r?\nALLOWED_ORIGINS = ("[^"]*")/m)?.[1] ?? '""',
) as string;
const stagingOrigins = JSON.parse(
  config.match(/^\[env\.staging\.vars\]\s*\r?\nALLOWED_ORIGINS = ("[^"]*")/m)?.[1] ?? '""',
) as string;
const harness = new WorkerTestHarness();

beforeEach(async () => {
  await harness.setup();
  // Only the external Turnstile verifier is mocked; stats dispatch, validation,
  // quota guard, rate limiter, and D1 event/aggregate commits are real and local.
  harness.mockSiteverify({ body: { success: true, action: "kit_result" } });
});

afterEach(async () => {
  await harness.teardown();
});

async function submitThroughGateway(allowedOrigins: string, origin: string) {
  const statsEnv: WorkerEnv = { ...env, ALLOWED_ORIGINS: allowedOrigins };
  const STATS = {
    fetch: vi.fn(async (request: Request) => {
      const ctx = createExecutionContext();
      const response = await statsWorker.fetch!(
        request as Parameters<NonNullable<typeof statsWorker.fetch>>[0],
        statsEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    }),
  };
  const ASSETS = { fetch: vi.fn(async () => new Response("unexpected asset")) };
  const payload = {
    ...kitResultEvent("gateway-staging-origin-0001"),
    sourceHost: new URL(origin).hostname,
  };
  const request = new Request(`${stagingOrigin}/api/events`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.17",
      Cookie: "private-session=fixture",
      Authorization: "Bearer private-fixture",
    },
    body: JSON.stringify(payload),
  });
  const response = await gateway.fetch(request, { STATS, ASSETS });
  expect(STATS.fetch).toHaveBeenCalledTimes(1);
  const forwarded = STATS.fetch.mock.calls[0]?.[0];
  expect(forwarded?.url).toBe(request.url);
  expect(forwarded?.headers.get("Origin")).toBe(origin);
  expect(forwarded?.headers.has("Cookie")).toBe(false);
  expect(forwarded?.headers.has("Authorization")).toBe(false);
  expect(ASSETS.fetch).not.toHaveBeenCalled();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response;
}

describe("gateway with the real local stats handler and committed origin config", () => {
  it("adds the staging host only to staging, preserving the production allowlist", () => {
    expect(productionOrigins).toBe(productionOrigin);
    expect(stagingOrigins.split(",")).toEqual([productionOrigin, stagingOrigin]);
  });

  it.each([stagingOrigin, productionOrigin])(
    "accepts and commits a staging-environment submission from %s without changing Origin",
    async (origin) => {
      const response = await submitThroughGateway(stagingOrigins, origin);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(harness.siteverifyForms).toHaveLength(1);
      expect(await harness.countRows("event_ids")).toBe(1);
      expect(await harness.countRows("event_aggregates_game_day")).toBe(1);
    },
  );

  it.each([
    [productionOrigins, stagingOrigin],
    [stagingOrigins, "https://untrusted.example"],
  ])("rejects an origin outside its environment allowlist", async (allowed, origin) => {
    const response = await submitThroughGateway(allowed, origin);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(harness.siteverifyForms).toHaveLength(0);
    expect(await harness.countRows("event_ids")).toBe(0);
    expect(await harness.countRows("event_aggregates_game_day")).toBe(0);
  });
});
