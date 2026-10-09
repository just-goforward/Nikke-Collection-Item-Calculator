import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile.ts";
import {
  assertCertifiedForecastIdentity,
  sameCertifiedForecastIdentity,
} from "../../shared/certifiedForecastIdentity.ts";
import type { CertifiedInput } from "../certified/types.ts";
import { loadCertifiedWasm } from "../certified/wasmBackend.ts";
import { solveCertifiedWasm } from "../certified/wasmSolver.ts";
import { assertTrustedCertifiedForecast } from "../lib/certifiedForecastTrust.ts";
import { bindCertifiedOutput, type CertifiedRuntimeOutput } from "./outputBinding.ts";
import {
  CERTIFIED_RESPONSE_PAYLOAD_CEILING,
  CERTIFIED_RUNTIME_PAYLOAD_CEILING,
  CERTIFIED_WORKER_MANAGED_CEILING,
  CERTIFIED_WORKER_RESPONSE_RESERVE_MS,
  type CertifiedRequest,
  type CertifiedResponse,
  payloadBytes,
  requireProfile,
} from "./protocol.ts";

async function bindSnapshot(request: Extract<CertifiedRequest<CertifiedInput>, { type: "solve" }>) {
  const identity = assertCertifiedForecastIdentity(request.forecastIdentity);
  const actual = await assertTrustedCertifiedForecast(request.input.snapshot, (bytes) => {
    if (bytes > CERTIFIED_RUNTIME_PAYLOAD_CEILING)
      throw new Error("Forecast hash workspace ceiling exceeded.");
  });
  if (!sameCertifiedForecastIdentity(identity, actual))
    throw new Error("Worker input snapshot does not match requested forecast identity.");
  return identity;
}
function assertTimeRemaining(deadlineAt: number) {
  if (Date.now() >= deadlineAt) throw new Error("Total deadline expired.");
}

/** Shared handler; the client owns serialization and hard cancellation by termination. */
export function createCertifiedWorkerHandler(
  post: (message: CertifiedResponse<CertifiedRuntimeOutput>) => void,
  readWasmBytes?: () => Promise<Uint8Array>,
) {
  let wasm: WebAssembly.Module | undefined;
  let generation: number | undefined;
  let busy = false;
  let closed = false;
  const reportFailure = (
    request: CertifiedRequest<CertifiedInput>,
    code: string,
    error: unknown,
  ) => {
    if (closed) return;
    post({
      type: "error",
      generation: request.generation,
      ...(request.type === "solve" ? { id: request.id } : {}),
      code,
      message: error instanceof Error ? error.message : String(error),
      engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE,
      ...(request.type === "solve" && request.forecastIdentity
        ? { forecastIdentity: request.forecastIdentity }
        : {}),
    });
  };
  const handle = async (request: CertifiedRequest<CertifiedInput>) => {
    if (closed) return;
    let ownsComputation = false;
    let failureCode = "profile_mismatch";
    try {
      requireProfile(request.engineProfile);
      failureCode = "protocol_invariant";
      if (request.type === "init") {
        if (generation !== undefined) throw new Error("Worker is already initialized.");
        generation = request.generation;
        failureCode = "wasm_initialization_failure";
        wasm = await loadCertifiedWasm(readWasmBytes);
        if (closed) return;
        post({ type: "initComplete", generation, engineProfile: request.engineProfile });
        return;
      }
      if (generation !== request.generation)
        throw new Error("Worker generation is not initialized.");
      if (busy) throw new Error("Concurrent certified computation is forbidden.");
      failureCode = "request_total_deadline";
      assertTimeRemaining(request.deadlineAt);
      busy = true;
      ownsComputation = true;
      failureCode = "forecast_identity_mismatch";
      const forecastIdentity = await bindSnapshot(request);
      if (closed) return;
      failureCode = "request_total_deadline";
      assertTimeRemaining(request.deadlineAt);
      post({
        type: "computeStarted",
        generation,
        id: request.id,
        engineProfile: CERTIFIED_STAGING_ENGINE_PROFILE,
        forecastIdentity,
      });
      failureCode = "solver_execution_failure";
      if (!wasm) throw new Error("certified_wasm_not_initialized");
      const output = solveCertifiedWasm(wasm, request.input, {
        maxManagedPayloadBytes: CERTIFIED_WORKER_MANAGED_CEILING,
        deadlineAt:
          performance.now() +
          Math.max(0, request.deadlineAt - Date.now() - CERTIFIED_WORKER_RESPONSE_RESERVE_MS),
        onCurrent: (output) => {
          failureCode = "protocol_invariant";
          const boundOutput = bindCertifiedOutput(output, forecastIdentity);
          failureCode = "response_payload_ceiling";
          if (payloadBytes(boundOutput) > CERTIFIED_RESPONSE_PAYLOAD_CEILING)
            throw new Error("Certified response payload ceiling exceeded.");
          if (!closed)
            post({
              type: "current",
              generation: request.generation,
              id: request.id,
              output: boundOutput,
              engineProfile: request.engineProfile,
              forecastIdentity,
            });
          failureCode = "solver_execution_failure";
        },
      });
      if (!closed) {
        failureCode = "protocol_invariant";
        const boundOutput = bindCertifiedOutput(output, forecastIdentity);
        failureCode = "response_payload_ceiling";
        if (payloadBytes(boundOutput) > CERTIFIED_RESPONSE_PAYLOAD_CEILING)
          throw new Error("Certified response payload ceiling exceeded.");
        failureCode = "request_total_deadline";
        assertTimeRemaining(request.deadlineAt);
        failureCode = "protocol_invariant";
        post({
          type: "result",
          generation,
          id: request.id,
          output: boundOutput,
          engineProfile: request.engineProfile,
          forecastIdentity,
        });
      }
    } catch (error) {
      reportFailure(request, failureCode, error);
    } finally {
      if (ownsComputation) busy = false;
    }
  };
  return {
    handle,
    close: () => {
      closed = true;
    },
  };
}
