import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: "certified-runtime-fixture",
        configureServer(vite) {
          vite.middlewares.use("/certified-runtime-test", (_request, response) => {
            response.setHeader("Content-Type", "text/html");
            response.end("<!doctype html><title>Certified runtime</title>");
          });
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: {
        ignored: [
          "**/.tmp/**",
          "**/.certified-*/**",
          "**/benchmarks/results/**",
          "**/test-results/**",
        ],
      },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing browser fixture address.");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
});

test("real browser Worker queue expiry, completed-signal cleanup, stale errors and partial hard abort", async ({
  page,
}) => {
  await page.goto(`${origin}/certified-runtime-test`);
  const evidence = await page.evaluate(async () => {
    const load = (path: string): Promise<Record<string, unknown>> =>
      import(/* @vite-ignore */ path);
    const module = await load("/src/certifiedRuntime/browserHarness.ts");
    const profile = await load("/shared/certifiedEngineProfile.ts");
    const { client, state } = (
      module[
        "createLifecycleBrowserHarness"
      ] as typeof import("../src/certifiedRuntime/browserHarness").createLifecycleBrowserHarness
    )();
    const engineProfile = profile[
      "CERTIFIED_STAGING_ENGINE_PROFILE"
    ] as import("../shared/certifiedEngineProfile").CertifiedEngineProfile;
    const request = (value: string, delayMs: number, options: Record<string, unknown> = {}) =>
      client.request(
        { value, delayMs, block: true },
        { sessionId: value, engineProfile, ...options },
      );
    try {
      const a = request("A", 300);
      const b = request("B", 5, { totalDeadlineMs: 150 }).then(
        () => "wrong",
        (error: { code: string }) => error.code,
      );
      const bCode = await b;
      const aValue = (await a).output;
      const untouched = state.terminated;
      const oldSignal = new AbortController();
      await request("done", 5, { signal: oldSignal.signal });
      const next = request("next", 10);
      oldSignal.abort();
      const nextValue = (await next).output;
      const abort = new AbortController();
      let signalCurrent: () => void = () => {};
      const current = new Promise<void>((resolve) => {
        signalCurrent = resolve;
      });
      const partial = client.request(
        { value: "full", delayMs: 500, block: true, partial: "certified-current" },
        {
          sessionId: "partial",
          engineProfile,
          signal: abort.signal,
          onCurrent: () => signalCurrent(),
        },
      );
      await current;
      const staleError = state.staleErrors[0];
      abort.abort();
      const retired = client.memory().retiredPayloadBytes;
      const partialValue = (await partial).output;
      const replacement = request("replacement", 10);
      staleError?.(new Error("retired generation"));
      const replacementValue = (await replacement).output;
      const retiredAfterInit = client.memory().retiredPayloadBytes;
      const originalSetTimeout = window.setTimeout;
      window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
        originalSetTimeout(
          callback,
          delay && delay > 900 && delay <= 1000 ? 1800 : delay,
          ...args,
        )) as typeof window.setTimeout;
      let deadlineErrorPartial: string;
      try {
        const task = client.request(
          {
            value: "unreachable",
            partial: "deadline-exact-current",
            delayMs: 0,
            failureCode: "request_total_deadline",
            errorAtDeadline: true,
          },
          { sessionId: "deadline-error-first", engineProfile, totalDeadlineMs: 1000 },
        );
        deadlineErrorPartial = (await task).output;
      } finally {
        window.setTimeout = originalSetTimeout;
      }
      await request("deadline-replacement", 5);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        bCode,
        aValue,
        untouched,
        nextValue,
        partialValue,
        retired,
        retiredAfterInit,
        replacementValue,
        deadlineErrorPartial,
        created: state.created,
        terminated: state.terminated,
      };
    } finally {
      await client.dispose();
    }
  });
  expect(evidence.bCode).toBe("deadline");
  expect(evidence.aValue).toBe("A");
  expect(evidence.untouched).toBe(0);
  expect(evidence.nextValue).toBe("next");
  expect(evidence.partialValue).toBe("certified-current");
  expect(evidence.retired).toBeGreaterThan(0);
  expect(evidence.retiredAfterInit).toBe(0);
  expect(evidence.replacementValue).toBe("replacement");
  expect(evidence.deadlineErrorPartial).toBe("deadline-exact-current");
  expect(evidence.created).toBe(evidence.terminated);
});

test("actual certified browser Worker completes repeated sequential solves under one 15s total budget", async ({
  page,
}) => {
  await page.goto(`${origin}/certified-runtime-test`);
  const results = await page.evaluate(async () => {
    const load = (path: string): Promise<Record<string, unknown>> =>
      import(/* @vite-ignore */ path);
    const module = await load("/src/certifiedRuntime/browserClient.ts");
    const fixtures = await load("/src/certifiedRuntime/integrationFixture.ts");
    const profile = await load("/shared/certifiedEngineProfile.ts");
    const client = (
      module[
        "createBrowserCertifiedClient"
      ] as typeof import("../src/certifiedRuntime/browserClient").createBrowserCertifiedClient
    )();
    const fixture = fixtures[
      "certifiedWorkerFixture"
    ] as typeof import("../src/certifiedRuntime/integrationFixture").certifiedWorkerFixture;
    const engineProfile = profile[
      "CERTIFIED_STAGING_ENGINE_PROFILE"
    ] as import("../shared/certifiedEngineProfile").CertifiedEngineProfile;
    try {
      const output = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        const result = await client.request(await fixture(repeat % 2 === 1), {
          sessionId: "actual-solver",
          engineProfile,
        });
        output.push({
          status: result.output.status,
          current: result.output.current?.status,
          kit: result.output.current?.kit,
          successP: result.output.current?.value.display.successP,
          waiting: result.output.waiting.status,
          totalMs: result.timing.totalMs,
          idlePayloadBytes: client.memory().totalPayloadBytes,
        });
      }
      return output;
    } finally {
      await client.dispose();
    }
  });
  expect(results).toHaveLength(3);
  for (const result of results) {
    expect(result.status).toBe("completed");
    expect(result.current).toBe("use_certified");
    expect(result.kit).toBe("blue");
    expect(result.successP).toBe(1);
    expect(result.waiting).toBe(results.indexOf(result) % 2 === 1 ? "certified" : "not_requested");
    expect(result.totalMs).toBeLessThan(15000);
    expect(result.idlePayloadBytes).toBe(0);
  }
});

test("actual browser client and Worker independently reject unapproved snapshots and bind every reply", async ({
  page,
}) => {
  await page.goto(`${origin}/certified-runtime-test`);
  const result = await page.evaluate(async () => {
    type Reply = import("../src/certifiedRuntime/protocol").CertifiedResponse<
      import("../src/certifiedRuntime/outputBinding").CertifiedRuntimeOutput
    >;
    const load = (path: string): Promise<Record<string, unknown>> =>
      import(/* @vite-ignore */ path);
    const clients = await load("/src/certifiedRuntime/browserClient.ts");
    const fixtures = await load("/src/certifiedRuntime/integrationFixture.ts");
    const identities = await load("/shared/certifiedForecastIdentity.ts");
    const profiles = await load("/shared/certifiedEngineProfile.ts");
    const createClient = clients[
      "createBrowserCertifiedClient"
    ] as typeof import("../src/certifiedRuntime/browserClient").createBrowserCertifiedClient;
    const fixture = fixtures[
      "certifiedWorkerFixture"
    ] as typeof import("../src/certifiedRuntime/integrationFixture").certifiedWorkerFixture;
    const identify = identities[
      "createCertifiedForecastIdentity"
    ] as typeof import("../shared/certifiedForecastIdentity").createCertifiedForecastIdentity;
    const engineProfile = profiles[
      "CERTIFIED_STAGING_ENGINE_PROFILE"
    ] as import("../shared/certifiedEngineProfile").CertifiedEngineProfile;
    const approved = await fixture();
    const altered = {
      ...approved,
      snapshot: {
        ...approved.snapshot,
        provenance: [...approved.snapshot.provenance, "unapproved-self-consistent-content"],
      },
    };
    const client = createClient();
    let clientRejected = false;
    try {
      await client.request(altered, { sessionId: "unapproved-client", engineProfile });
    } catch {
      clientRejected = true;
    } finally {
      await client.dispose();
    }
    const worker = new Worker("/src/certifiedRuntime/browserWorker.ts", { type: "module" });
    const exchange = (message: unknown) =>
      new Promise<Reply>((resolveReply, rejectReply) => {
        const onError = (error: ErrorEvent) => {
          worker.removeEventListener("message", onMessage);
          rejectReply(error);
        };
        const onMessage = (event: MessageEvent<Reply>) => {
          worker.removeEventListener("error", onError);
          resolveReply(event.data);
        };
        worker.addEventListener("error", onError, { once: true });
        worker.addEventListener("message", onMessage, { once: true });
        worker.postMessage(message);
      });
    try {
      await exchange({ type: "init", generation: 1, engineProfile });
      const alteredIdentity = await identify(altered.snapshot);
      const rejection = await exchange({
        type: "solve",
        generation: 1,
        id: 1,
        sessionId: "unapproved-worker",
        engineProfile,
        forecastIdentity: alteredIdentity,
        input: altered,
        deadlineAt: Date.now() + 15000,
      });
      const identity = await identify(approved.snapshot);
      const responses: Reply[] = [];
      await new Promise<void>((resolveSolve, rejectSolve) => {
        const onError = (error: ErrorEvent) => {
          worker.removeEventListener("message", onMessage);
          rejectSolve(error);
        };
        const onMessage = (event: MessageEvent<Reply>) => {
          responses.push(event.data);
          if (event.data.type === "result" || event.data.type === "error") {
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            resolveSolve();
          }
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError, { once: true });
        worker.postMessage({
          type: "solve",
          generation: 1,
          id: 2,
          sessionId: "approved-worker",
          engineProfile,
          forecastIdentity: identity,
          input: approved,
          deadlineAt: Date.now() + 15000,
        });
      });
      return { clientRejected, rejection, alteredIdentity, identity, engineProfile, responses };
    } finally {
      worker.terminate();
    }
  });
  expect(result.clientRejected).toBe(true);
  expect(result.rejection.type).toBe("error");
  expect(result.rejection.engineProfile).toEqual(result.engineProfile);
  if (result.rejection.type !== "error") throw new Error("Expected trusted anchor rejection.");
  expect(result.rejection.code).toBe("forecast_identity_mismatch");
  expect(result.rejection.forecastIdentity).toEqual(result.alteredIdentity);
  expect(result.responses.map((response) => response.type)).toEqual([
    "computeStarted",
    "current",
    "result",
  ]);
  for (const response of result.responses) {
    expect(response.engineProfile).toEqual(result.engineProfile);
    if (response.type === "initComplete") throw new Error("Unexpected repeated init.");
    expect(response.forecastIdentity).toEqual(result.identity);
    if ("output" in response) {
      expect(response.output.runtimeBinding.engineProfile).toEqual(result.engineProfile);
      expect(response.output.runtimeBinding.forecastIdentity).toEqual(result.identity);
    }
  }
});
