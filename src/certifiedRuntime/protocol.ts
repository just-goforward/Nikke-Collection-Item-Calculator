import {
  assertCertifiedEngineProfile,
  type CertifiedEngineProfile,
} from "../../shared/certifiedEngineProfile.ts";
import type { CertifiedForecastIdentity } from "../../shared/certifiedForecastIdentity.ts";

export const CERTIFIED_TOTAL_DEADLINE_MS = 15_000;
export const CERTIFIED_WORKER_RESPONSE_RESERVE_MS = 300;
export const CERTIFIED_RUNTIME_PAYLOAD_CEILING = 32 * 1024 * 1024;
export const CERTIFIED_WORKER_MANAGED_CEILING = 160 * 1024 * 1024;
export const CERTIFIED_RESPONSE_PAYLOAD_CEILING = 2 * 1024 * 1024;
export const CERTIFIED_RESPONSE_METADATA_CEILING = 16 * 1024;
export type CertifiedRequest<I> =
  | { type: "init"; generation: number; engineProfile: CertifiedEngineProfile }
  | {
      type: "solve";
      generation: number;
      id: number;
      sessionId: string;
      engineProfile: CertifiedEngineProfile;
      forecastIdentity?: CertifiedForecastIdentity;
      deadlineAt: number;
      input: I;
    };
export type CertifiedResponse<O> =
  | { type: "initComplete"; generation: number; engineProfile: CertifiedEngineProfile }
  | {
      type: "computeStarted";
      generation: number;
      id: number;
      engineProfile: CertifiedEngineProfile;
      forecastIdentity?: CertifiedForecastIdentity;
    }
  | {
      type: "current" | "result";
      generation: number;
      id: number;
      output: O;
      engineProfile: CertifiedEngineProfile;
      forecastIdentity?: CertifiedForecastIdentity;
    }
  | {
      type: "error";
      generation: number;
      id?: number;
      code: string;
      message: string;
      engineProfile: CertifiedEngineProfile;
      forecastIdentity?: CertifiedForecastIdentity;
    };

export function requireProfile(value: unknown): CertifiedEngineProfile {
  return assertCertifiedEngineProfile(value);
}

export type CertifiedTiming = {
  queuedMs: number;
  initMs: number;
  computeMs: number;
  responseMs: number;
  totalMs: number;
};
export type CertifiedMemory = {
  queuedPayloadBytes: number;
  activePayloadBytes: number;
  workerPayloadBytes: number;
  retiredPayloadBytes: number;
  partialPayloadBytes: number;
  responsePayloadBytes: number;
  workerResponsePayloadBytes: number;
  observerPayloadBytes: number;
  transientPayloadBytes: number;
  bindingPayloadBytes: number;
  workerBindingPayloadBytes: number;
  reservedResponseCapacityBytes: number;
  totalPayloadBytes: number;
};

/** Logical payload bytes, not a claim about process or WASM memory. */
export function payloadBytes(value: unknown): number {
  const seen = new Set<object>();
  const visit = (item: unknown): number => {
    if (typeof item === "string") return new TextEncoder().encode(item).byteLength;
    if (typeof item === "number") return 8;
    if (typeof item === "bigint") return 8 + Math.ceil(item.toString(2).length / 8);
    if (typeof item === "boolean") return 1;
    if (item === null || item === undefined) return 0;
    if (typeof item !== "object" || seen.has(item)) return 0;
    seen.add(item);
    if (ArrayBuffer.isView(item)) return item.byteLength;
    if (item instanceof ArrayBuffer) return item.byteLength;
    if (typeof SharedArrayBuffer !== "undefined" && item instanceof SharedArrayBuffer)
      return item.byteLength;
    if (item instanceof Map) return [...item].reduce((n, [k, v]) => n + visit(k) + visit(v), 0);
    if (item instanceof Set) return [...item].reduce((n, v) => n + visit(v), 0);
    return Object.entries(item).reduce((n, [k, v]) => n + visit(k) + visit(v), 0);
  };
  return visit(value);
}
