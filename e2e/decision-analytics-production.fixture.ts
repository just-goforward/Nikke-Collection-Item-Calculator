import type { Bands, ProducerContext } from "../shared/decisionAnalyticsV3";
import type { PublicationBytes } from "../shared/forecastPublicationBytes";
import {
  installVerifiedDecisionMapping, type VerifiedDecisionMapping,
} from "../src/analytics/decisionAcquisition";
import {
  createProductionDecision, type DecisionProductionCatalog,
} from "../src/analytics/decisionProduction";
import { publicationBytesHash } from "../shared/forecastPublicationBytes";

/** Complete immutable public candidates, signed with this fixture's fresh synthetic key. */
export async function outcomeAnalyticsFixtures() {
  const { forecastAsyncFixtures } = await import("./forecast-async.fixtures");
  const fixtures = await forecastAsyncFixtures();
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  fixtures.trust.publicKeyBase64 = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64");
  const sign = async (value: object) => {
    const statement = JSON.stringify(value);
    return { statement, signature: Buffer.from(await crypto.subtle.sign(
      "Ed25519", keys.privateKey, new TextEncoder().encode(statement),
    )).toString("base64") };
  };
  for (const key of ["a", "b", "renewal", "rollback", "median"] as const) {
    const publication = fixtures[key];
    const candidate = JSON.stringify({
      ...JSON.parse(publication.artifact!.candidate),
      schedule: { soloPeriods: [], collaborationPeriods: [] },
    });
    const contentHash = await publicationBytesHash(candidate);
    publication.pointer = await sign({ ...JSON.parse(publication.pointer.statement), contentHash });
    publication.artifact = {
      candidate,
      authorization: await sign({ ...JSON.parse(publication.artifact!.authorization.statement), contentHash }),
    };
  }
  fixtures.off.pointer = await sign(JSON.parse(fixtures.off.pointer.statement));
  return fixtures;
}

type Environment = NonNullable<Parameters<typeof createProductionDecision>[1]>;

/** Test-only inputs; callers supply denied-outbound fetch and synthetic Turnstile API.
 * This does not replace transport: requests traverse the real outcome-v4 transport.
 */
export function decisionProductionFixture(options: {
  producer: ProducerContext;
  cases: readonly { publication: PublicationBytes; expectedSupply: Bands }[];
  environment: Environment;
}) {
  const cases = options.cases.map(({ publication, expectedSupply }) => {
    if (!publication.artifact) throw new Error("synthetic_active_publication_required");
    const pointer = JSON.parse(publication.pointer.statement);
    return {
      contentHash: pointer.contentHash,
      candidate: JSON.stringify(JSON.parse(publication.artifact.candidate)),
      expectedSupply: Object.freeze({ ...expectedSupply }),
    };
  });
  const mapping: VerifiedDecisionMapping = ({ actual, signedCandidate, snapshot }) => {
    if (snapshot.asOf !== actual.asOf) return undefined;
    const matches = cases.filter(entry => entry.contentHash === actual.contentHash &&
      entry.candidate === JSON.stringify(signedCandidate));
    return matches.length === 1 ? matches[0]!.expectedSupply : undefined;
  };
  const catalog: DecisionProductionCatalog = {
    enabled: true,
    producer: options.producer,
    allowedProducers: [options.producer],
    turnstileSiteKey: "TEST_ONLY_decision_episode",
    publications: [],
  };
  return {
    mapping,
    catalog,
    async create() {
      installVerifiedDecisionMapping(mapping);
      return createProductionDecision(() => catalog, options.environment);
    },
    cleanup() { installVerifiedDecisionMapping(undefined); },
  };
}
