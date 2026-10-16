import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { assertCertifiedRuntimeSupplySnapshot } from "../shared/certifiedSupply";
import { publicationWire } from "../shared/forecast-publication/consumer-wire";
import {
  ARTIFACT_DOMAIN,
  encodeBase64,
  POINTER_DOMAIN,
  publicationHash,
  signPublication,
} from "../shared/forecastPublication";
import type { PublicationBytes } from "../shared/forecastPublicationBytes";
import { buildV3SupplyForecastCandidate } from "../shared/supplyForecastCandidate";
import registry from "../shared/supplyForecasts.json" with { type: "json" };

let server: ViteDevServer;
let origin: string;
let active: PublicationBytes;
let off: PublicationBytes;
let trust: { environment: "staging"; keyId: string; publicKeyBase64: string };
const asOf = "2026-10-07T03:00:00.000Z";
const envKeys = [
  "VITE_FORECAST_RUNTIME",
  "VITE_FORECAST_PUBLIC_KEY_ID",
  "VITE_FORECAST_PUBLIC_KEY_BASE64",
];
const previousEnv = envKeys.map((key) => process.env[key]);
test.beforeAll(async () => {
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  trust = {
    environment: "staging",
    keyId: "browser-throwaway",
    publicKeyBase64: encodeBase64(
      new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    ),
  };
  const entry = registry.forecasts.find((value) => value.id === registry.approvedForecastId);
  if (!entry) throw new Error("fixture_missing");
  const snapshot = structuredClone(
    assertCertifiedRuntimeSupplySnapshot(Reflect.get(entry, "certifiedSnapshot")),
  );
  snapshot.revision = "browser-runtime-approved";
  const periods = snapshot.soloRounds
    .filter((round) => round.startGameDate > snapshot.coverage.currentDay && round.endGameDate)
    .slice(0, 3)
    .map((round) => ({
      effectiveFrom: `${round.startGameDate}T05:00:00+09:00`,
      effectiveUntil: `${round.endGameDate}T05:00:00+09:00`,
      scheduleStatus: "estimated" as const,
    }));
  const primary = periods[0];
  if (!primary) throw new Error("fixture_period_missing");
  const candidate = buildV3SupplyForecastCandidate({
    candidateId: "forecast-browser-consumer-fixture",
    forecastId: entry.id,
    generatedAt: snapshot.asOf,
    sourceStatus: "x_unavailable",
    dispatchPolicyId: "dispatch-policy-v1",
    schedule: {
      status: "estimated",
      cadenceDays: null,
      soloStart: primary.effectiveFrom,
      soloEnd: primary.effectiveUntil,
      soloPeriods: periods,
      collaborationPeriods: [],
    },
    sourceEvidence: entry.sourceEvidence,
    warnings: [],
    certifiedSnapshot: snapshot,
  });
  const statement = {
    environment: trust.environment,
    keyId: trust.keyId,
    candidateId: candidate.candidateId,
    contentHash: await publicationHash(candidate),
  };
  const pointer = await signPublication(
    {
      ...statement,
      domain: POINTER_DOMAIN,
      sequence: 1,
      mode: "active",
      operationId: "12345",
      issuedAt: Date.parse(asOf),
    },
    keys.privateKey,
  );
  active = publicationWire({
    pointer,
    artifact: {
      candidate,
      authorization: await signPublication(
        {
          ...statement,
          domain: ARTIFACT_DOMAIN,
        },
        keys.privateKey,
      ),
    },
  });
  off = publicationWire({
    pointer: await signPublication(
      {
        ...pointer.statement,
        sequence: 2,
        mode: "off",
        candidateId: null,
        contentHash: null,
      },
      keys.privateKey,
    ),
    artifact: null,
  });
  process.env["VITE_FORECAST_RUNTIME"] = "staging";
  process.env["VITE_FORECAST_PUBLIC_KEY_ID"] = trust.keyId;
  process.env["VITE_FORECAST_PUBLIC_KEY_BASE64"] = trust.publicKeyBase64;
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: "forecast-browser-fixture",
        configureServer(vite) {
          vite.middlewares.use("/forecast-test", (_request, response) => {
            response.setHeader("Content-Type", "text/html");
            response.end("<!doctype html><title>Forecast runtime test</title>");
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
  envKeys.forEach((key, index) => {
    const old = previousEnv[index];
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
});

test("native Ed25519, byte tampering, off/replay, resume and one proof per real Worker calculation", async ({
  page,
  context,
}) => {
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (route) => route.abort(),
  );
  await page.goto(`${origin}/forecast-test`);
  const result = await page.evaluate(
    async ({ active, off, trust, asOf }) => {
      const load = (path: string): Promise<Record<string, unknown>> =>
        import(/* @vite-ignore */ path);
      const module = await load("/src/lib/runtimeForecast.ts");
      const create = module[
        "createRuntimeForecastClient"
      ] as typeof import("../src/lib/runtimeForecast").createRuntimeForecastClient;
      let wire = active;
      let calls = 0;
      const request: typeof fetch = async () => {
        calls++;
        return Response.json({ ...wire, remainingMs: 60_000 });
      };
      const client = create({ enabled: true, trust, fetch: request });
      const capability = await crypto.subtle
        .importKey(
          "raw",
          Uint8Array.from(atob(trust.publicKeyBase64), (value) => value.charCodeAt(0)),
          "Ed25519",
          false,
          ["verify"],
        )
        .then(
          () => true,
          (error: unknown) => {
            if (error instanceof DOMException && error.name === "NotSupportedError") return false;
            throw error;
          },
        );
      let status = "";
      const unsubscribe = client.subscribe((value) => {
        status = value;
      });
      const selected = await client.acquire(asOf);
      unsubscribe();
      if (!capability) return { unsupported: true, selected, status };
      if (!selected) throw new Error("native_signature_rejected");
      const workerModule = await load("/src/certifiedRuntime/browserClient.ts");
      const profileModule = await load("/shared/certifiedEngineProfile.ts");
      const worker = (
        workerModule[
          "createBrowserCertifiedClient"
        ] as typeof import("../src/certifiedRuntime/browserClient").createBrowserCertifiedClient
      )();
      try {
        const pending = worker.request(
          {
            grade: "SR",
            level: 15,
            exp: 0,
            stock: [0, 0, 0],
            asOf,
            snapshot: selected.snapshot,
            forecastPublication: selected.publication,
            computeWaiting: false,
            computeMinimumWait: false,
          },
          {
            sessionId: "runtime-test",
            engineProfile: profileModule[
              "CERTIFIED_STAGING_ENGINE_PROFILE"
            ] as import("../shared/certifiedEngineProfile").CertifiedEngineProfile,
          },
        );
        wire = off;
        const stopped = await client.acquire(asOf);
        const calculated = await pending;
        wire = active;
        const replay = await client.acquire(asOf);
        const tampered = structuredClone(active);
        if (!tampered.artifact) throw new Error("fixture_missing");
        tampered.artifact.candidate += " ";
        const rejected = await create({
          enabled: true,
          trust,
          fetch: async () => Response.json({ ...tampered, remainingMs: 60_000 }),
        }).acquire(asOf);
        const visibility = Object.assign(new EventTarget(), {
          visibilityState: "visible" as DocumentVisibilityState,
        });
        wire = off;
        const before = calls;
        const dispose = client.watch(visibility, () => {});
        await client.refresh();
        visibility.dispatchEvent(new Event("visibilitychange"));
        await client.refresh();
        dispose();
        return {
          stopped,
          replay,
          rejected,
          resumeChecks: calls - before,
          submitted: selected.snapshot.revision,
          calculated: calculated.output.provenance.snapshotRevision,
        };
      } finally {
        await worker.dispose();
      }
    },
    { active, off, trust, asOf },
  );
  if ("unsupported" in result) {
    expect(result).toMatchObject({ unsupported: true, selected: null, status: "unavailable" });
    const info = test.info();
    info.annotations.push({
      type: "Ed25519",
      description: "Native API unsupported; bundled fallback verified.",
    });
    return;
  }
  expect(result).toMatchObject({
    stopped: null,
    replay: null,
    rejected: null,
    submitted: "browser-runtime-approved",
    calculated: "browser-runtime-approved",
  });
  expect(result.resumeChecks).toBeGreaterThanOrEqual(2);
});
