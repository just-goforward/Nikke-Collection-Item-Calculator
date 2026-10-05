import {
  assertCertifiedEngineProfile,
  CERTIFIED_STAGING_ENGINE_PROFILE,
  type CertifiedEngineProfile,
} from "../../shared/certifiedEngineProfile.ts";
import {
  assertCertifiedForecastIdentity,
  type CertifiedForecastIdentity,
  sameCertifiedForecastIdentity,
} from "../../shared/certifiedForecastIdentity.ts";
import type { CertifiedOutput } from "../certified/types.ts";

export type CertifiedRuntimeOutput = CertifiedOutput & {
  runtimeBinding: {
    engineProfile: CertifiedEngineProfile;
    forecastIdentity: CertifiedForecastIdentity;
  };
};

function assertSolverProvenance(output: CertifiedOutput, identity: CertifiedForecastIdentity) {
  if (
    output.provenance.snapshotRevision !== identity.snapshotRevision ||
    output.provenance.snapshotSourceHash !== identity.sourceHash
  ) {
    throw new Error("Certified output provenance does not match the submitted snapshot.");
  }
}

/** Only the trusted worker binds standalone solver content after verifying provenance. */
export function bindCertifiedOutput(
  output: CertifiedOutput,
  identity: CertifiedForecastIdentity,
): CertifiedRuntimeOutput {
  assertSolverProvenance(output, identity);
  return {
    ...output,
    runtimeBinding: Object.freeze({
      engineProfile: Object.freeze(structuredClone(CERTIFIED_STAGING_ENGINE_PROFILE)),
      forecastIdentity: Object.freeze(assertCertifiedForecastIdentity(identity)),
    }),
  };
}

/** The output body and envelope must independently carry the complete same binding. */
export function assertCertifiedOutputBinding(
  output: CertifiedOutput,
  identity: CertifiedForecastIdentity,
) {
  const binding = Reflect.get(output, "runtimeBinding");
  if (!binding || typeof binding !== "object")
    throw new Error("Certified output runtime binding is missing.");
  assertCertifiedEngineProfile(binding.engineProfile);
  if (
    !sameCertifiedForecastIdentity(
      assertCertifiedForecastIdentity(binding.forecastIdentity),
      identity,
    )
  )
    throw new Error(
      "Certified output body forecast identity does not match the submitted snapshot.",
    );
  assertSolverProvenance(output, identity);
}
