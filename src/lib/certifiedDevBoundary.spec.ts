import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import { createCertifiedForecastIdentity } from "../../shared/certifiedForecastIdentity";
import type { CertifiedRuntimeOutput } from "../certifiedRuntime/outputBinding";
import type { CertifiedResponse } from "../certifiedRuntime/protocol";
import { createCertifiedWorkerHandler } from "../certifiedRuntime/workerHandler";
import { prepareCertifiedForecast } from "./certifiedForecast";
import { assertTrustedCertifiedForecast } from "./certifiedForecastTrust";
import { prepareLocalCertifiedForecast } from "./certifiedLocalForecast";

afterEach(() => vi.unstubAllEnvs());

it.each(["", "staging"])(
  "rejects local input at both trust boundaries in a deployed %j build",
  async (runtime) => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_FORECAST_RUNTIME", "");
    const local = await prepareLocalCertifiedForecast("2026-10-18T00:00:00.000Z");
    const identity = await createCertifiedForecastIdentity(local);
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_FORECAST_RUNTIME", runtime);
    await expect(prepareLocalCertifiedForecast(local.asOf)).rejects.toThrow(
      "certified_local_policy_disabled",
    );
    await expect(
      assertTrustedCertifiedForecast(local, () => {}, undefined, "local"),
    ).rejects.toThrow("certified_forecast_not_approved");
    const messages: CertifiedResponse<CertifiedRuntimeOutput>[] = [];
    const worker = createCertifiedWorkerHandler(
      (message) => messages.push(message),
      () => readFile("public/certified_solver.wasm"),
    );
    await worker.handle({
      type: "init",
      generation: 1,
      engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE,
    });
    await worker.handle({
      type: "solve",
      generation: 1,
      id: 1,
      sessionId: "forged-local",
      engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE,
      forecastIdentity: identity,
      deadlineAt: Date.now() + 15_000,
      input: {
        grade: "R",
        level: 0,
        exp: 0,
        stock: [0, 0, 0],
        asOf: local.asOf,
        snapshot: local,
        forecastSource: "local",
      },
    });
    expect(messages.at(-1)).toMatchObject({
      type: "error",
      code: "forecast_identity_mismatch",
      message: "certified_forecast_not_approved",
    });
    expect(messages.some((message) => message.type === "computeStarted")).toBe(false);
    worker.close();
  },
);

it("continues admitting the approved bundle in a production build", async () => {
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_FORECAST_RUNTIME", "");
  const approved = await prepareCertifiedForecast("2026-10-18T00:00:00.000Z");
  expect(approved.version).toBe("certified-daily-v3");
  expect(await assertTrustedCertifiedForecast(approved, () => {})).toEqual(
    await createCertifiedForecastIdentity(approved),
  );
});
