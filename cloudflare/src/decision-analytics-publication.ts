import { createCertifiedForecastIdentity } from "../../shared/certifiedForecastIdentity";
import { viewCertifiedSupplySnapshot, type CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import {
  BANDS, DecisionAnalyticsError, type Bands, type ProducerContext, type StageData,
} from "../../shared/decisionAnalyticsV3";
import {
  createPublicationSequenceGuard, verifyPublicationBytes, type PublicationBytes,
} from "../../shared/forecastPublicationBytes";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../shared/generated/certifiedEngineBuild";
import { createForecastEndpoint, type ForecastEnv } from "../../site-worker/src/forecast";
import { parseProducers, type CalculationAuthorization } from "./decision-analytics-handler";
import type { WorkerEnv } from "./env";

export type DecisionPublicAcquisition = Readonly<{
  contentHash: string; runtimeSnapshotHash: string; asOf: string;
}>;
export type DecisionMappingInput = Readonly<{
  actual: DecisionPublicAcquisition;
  snapshot: CertifiedSupplySnapshot;
  signedCandidate: unknown;
}>;
export type DecisionPublicMapping = (input: DecisionMappingInput) => Bands | undefined;
type AuthenticatedPublicationContext = Readonly<{
  contentHash: string; snapshot: CertifiedSupplySnapshot; signedCandidate: unknown;
}>;

/** Internal installation from the approved catalog, not request/unsigned JSON data.
 * v3 does not send asOf or snapshotHash. A production acquisition projection must
 * therefore be approved with the mapping; never substitute the admission clock. */
export type DecisionMetadataInstallation = Readonly<{
  producer: ProducerContext;
  trust: Readonly<{ environment: "production"; keyId: string; publicKeyBase64: string }>;
  acquire?: (context: AuthenticatedPublicationContext) =>
    DecisionPublicAcquisition | undefined | Promise<DecisionPublicAcquisition | undefined>;
  mapping?: DecisionPublicMapping;
}>;
export type DecisionRequestResolver = (
  request: Request, env: WorkerEnv, calculation: StageData["calculation"],
) => Promise<CalculationAuthorization>;

function unavailable(): never {
  throw new DecisionAnalyticsError(503, "analytics_not_ready");
}

/** Uses the existing guarded primary-read consumer and signature/identity
 * validators. No new publication store, remote fetch, or request-derived trust. */
export function createProductionDecisionResolver(
  installation?: DecisionMetadataInstallation,
  now: () => number = Date.now,
): DecisionRequestResolver {
  const producers = installation ? parseProducers(JSON.stringify([installation.producer])) : null;
  const producer = producers?.[0];
  const trust = installation ? Object.freeze({ ...installation.trust }) : undefined;
  const acquire = installation?.acquire;
  const mapping = installation?.mapping;
  const endpoint = createForecastEndpoint(now);
  const sequences = new WeakMap<NonNullable<ForecastEnv["FORECAST_DB"]>, ReturnType<typeof createPublicationSequenceGuard>>();
  return async (request, env, calculation) => {
    if (!producer || producer.producerCodeHash !== CERTIFIED_ENGINE_CODE_HASH ||
        !trust || trust.environment !== "production" || !trust.keyId || !trust.publicKeyBase64 ||
        !acquire || !mapping) unavailable();
    if (producer.producerVersion !== calculation.producerVersion ||
        producer.producerCodeHash !== calculation.producerCodeHash)
      throw new DecisionAnalyticsError(400, "unsupported_producer");
    const forecastEnv: ForecastEnv = env;
    if (forecastEnv.SITE_ENV !== "production" || !forecastEnv.FORECAST_DB) unavailable();
    try {
      const started = now();
      const headers = new Headers();
      const ip = request.headers.get("CF-Connecting-IP");
      if (ip) headers.set("CF-Connecting-IP", ip);
      const response = await endpoint(new Request(new URL("/api/forecast", request.url), { headers }), forecastEnv);
      if (!response.ok) unavailable();
      const body = await response.json<PublicationBytes & { remainingMs: number }>();
      // Same non-sliding freshness contract as the existing production consumer.
      if (!Number.isFinite(body.remainingMs) || body.remainingMs <= 0 || body.remainingMs > 60_000) unavailable();
      const expiresAt = started + body.remainingMs;
      let sequence = sequences.get(forecastEnv.FORECAST_DB);
      if (!sequence) {
        sequence = createPublicationSequenceGuard();
        sequences.set(forecastEnv.FORECAST_DB, sequence);
      }
      const publication = { pointer: body.pointer, artifact: body.artifact };
      const verified = await verifyPublicationBytes(publication, {
        ...trust, minimumSequence: sequence.minimumSequence, onPointer: sequence.observe,
      });
      sequence.accept(verified.pointer.sequence);
      if (verified.pointer.mode !== "active" || !verified.snapshot || !publication.artifact) unavailable();
      if (verified.pointer.contentHash !== calculation.publicationContentHash)
        throw new DecisionAnalyticsError(400, "unsupported_publication_content");
      const contentHash = verified.pointer.contentHash;
      if (!contentHash || now() >= expiresAt) unavailable();
      const signedCandidate: unknown = JSON.parse(publication.artifact.candidate);
      const acquired = await acquire({
        contentHash, snapshot: structuredClone(verified.snapshot), signedCandidate: structuredClone(signedCandidate),
      });
      if (!acquired || acquired.contentHash !== contentHash || typeof acquired.asOf !== "string") unavailable();
      const actual = Object.freeze({
        contentHash, runtimeSnapshotHash: acquired.runtimeSnapshotHash, asOf: acquired.asOf,
      });
      const snapshot = viewCertifiedSupplySnapshot(verified.snapshot, actual.asOf);
      const identity = await createCertifiedForecastIdentity(snapshot);
      if (identity.snapshotHash !== actual.runtimeSnapshotHash) unavailable();
      const expected = mapping({ actual, snapshot, signedCandidate });
      if (!expected || Object.keys(expected).length !== 3 ||
          !(["blue", "purple", "yellow"] as const).every(color => BANDS.includes(expected[color]))) unavailable();
      if ((["blue", "purple", "yellow"] as const).some(color => expected[color] !== calculation.expectedSupply[color]))
        throw new DecisionAnalyticsError(400, "unsupported_expected_supply");
      if (now() >= expiresAt) unavailable();
      return { expiresAt };
    } catch (error) {
      if (error instanceof DecisionAnalyticsError) throw error;
      unavailable();
    }
  };
}
