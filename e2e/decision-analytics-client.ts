import { createCertifiedForecastIdentity } from "../shared/certifiedForecastIdentity";
import type { CertifiedInput } from "../src/certified/types";
import type { createBrowserCertifiedClient as Factory } from "../src/certifiedRuntime/browserClient";
import type { CertifiedRuntimeOutput } from "../src/certifiedRuntime/outputBinding";
import { serviceTestOutput, serviceTestWait } from "../src/hooks/serviceCertifiedTestFixtures";
import { ServiceCertifiedCancelled } from "../src/hooks/serviceCertifiedTypes";

type Options = Parameters<ReturnType<typeof Factory>["request"]>[1];
type Pending = {
  input: CertifiedInput;
  options: Options;
  resolve: (value: { output: CertifiedRuntimeOutput }) => void;
  reject: (reason: unknown) => void;
};
export type SyntheticResult = { uses?: number; wait?: boolean; preserve?: boolean };
export const requests: Pending[] = [];
export const evidence = { disposals: 0, checkpoints: 0, completions: 0 };
const waiters = new Map<number, () => void>();

// This is the already-validated client-output boundary, not a solver or a
// replacement adapter/projector. Only the production adapter stamps acquisition.
export function createBrowserCertifiedClient() {
  return {
    request(input: CertifiedInput, options: Options) {
      return new Promise<{ output: CertifiedRuntimeOutput }>((resolve, reject) => {
        const index = requests.length;
        requests.push({ input: structuredClone(input), options, resolve, reject });
        waiters.get(index)?.();
        waiters.delete(index);
      });
    },
    async dispose() { ++evidence.disposals; },
  };
}

export function waitRequest(index: number) {
  return requests[index] ? Promise.resolve() :
    new Promise<void>((resolve) => { waiters.set(index, resolve); });
}

async function output(index: number, result: SyntheticResult): Promise<CertifiedRuntimeOutput> {
  const request = requests[index];
  if (!request) throw new Error(`missing_synthetic_request:${index}`);
  const value = serviceTestOutput();
  const uses = result.uses ?? 2;
  const current = value.current!;
  value.current = result.preserve ? {
    ...current, status: "preserve", kit: null, uses: 0, pieces: 0, optimalActionMask: 0,
  } : { ...current, uses, pieces: uses * 10 };
  if (result.wait !== false) value.stableRecommendation = serviceTestWait(3);
  value.runtimeBinding = {
    engineProfile: structuredClone(request.options.engineProfile!),
    forecastIdentity: await createCertifiedForecastIdentity(request.input.snapshot),
  };
  value.provenance = {
    ...value.provenance,
    snapshotRevision: request.input.snapshot.revision,
    snapshotSourceHash: request.input.snapshot.sourceHash,
  };
  return value;
}

export async function current(index: number, result: SyntheticResult = {}) {
  const value = await output(index, { ...result, wait: false });
  ++evidence.checkpoints;
  requests[index]!.options.onCurrent?.(value);
}

export async function finish(index: number, result: SyntheticResult = {}) {
  const value = await output(index, result);
  ++evidence.completions;
  requests[index]!.resolve({ output: value });
}

export function fail(index: number, reason: "error" | "limit" | "cancel") {
  const request = requests[index];
  if (!request) throw new Error(`missing_synthetic_request:${index}`);
  request.reject(reason === "cancel" ? new ServiceCertifiedCancelled() :
    new Error(reason === "limit" ? "certified_total_deadline" : "controlled_synthetic_failure"));
}
