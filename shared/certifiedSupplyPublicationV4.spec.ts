import { describe, expect, it } from "vitest";
import { assertCertifiedRuntimeSupplySnapshot } from "./certifiedSupply";
import { dateStart, iso, ruleAt } from "./certifiedSupplyModel";
import {
  ARTIFACT_DOMAIN,
  canonicalPublicationJson,
  encodeBase64,
  POINTER_DOMAIN,
  publicationCandidate,
  publicationHash,
  signPublication,
  verifyPublication,
} from "./forecastPublication";
import { verifyPublicationBytes } from "./forecastPublicationBytes";
import {
  buildV3SupplyForecastCandidate,
  type SupplyForecastGrant,
} from "./supplyForecastCandidate";
import registry from "./supplyForecasts.json";

function historicalCandidate() {
  const entry = registry.forecasts.find((value) => value.id === registry.approvedForecastId);
  if (!entry) throw new Error("approved_fixture_missing");
  const snapshot = assertCertifiedRuntimeSupplySnapshot(Reflect.get(entry, "certifiedSnapshot"));
  const soloPeriods = snapshot.soloRounds
    .filter((round) => round.startGameDate > snapshot.coverage.currentDay && round.endGameDate)
    .slice(0, 3)
    .map((round) => ({
      effectiveFrom: `${round.startGameDate}T05:00:00+09:00`,
      effectiveUntil: `${round.endGameDate}T05:00:00+09:00`,
      scheduleStatus: "estimated" as const,
    }));
  const primary = soloPeriods[0];
  if (!primary) throw new Error("period_fixture_missing");
  return buildV3SupplyForecastCandidate({
    candidateId: "forecast-publication-compatibility",
    forecastId: entry.id,
    generatedAt: snapshot.asOf,
    sourceStatus: "x_unavailable",
    dispatchPolicyId: "dispatch-policy-v1",
    schedule: {
      status: "estimated",
      cadenceDays: null,
      soloStart: primary.effectiveFrom,
      soloEnd: primary.effectiveUntil,
      soloPeriods,
      collaborationPeriods: [],
    },
    sourceEvidence: entry.sourceEvidence,
    warnings: [],
    certifiedSnapshot: snapshot,
  });
}

describe("historical and v4 signed publication compatibility", () => {
  it("keeps historical bytes and admits v4 grants with equivalent repeated-law references", async () => {
    const historical = historicalCandidate();
    const before = canonicalPublicationJson(historical);
    const seed = historical.certifiedSnapshot;
    if (!seed) throw new Error("snapshot_fixture_missing");
    const day = seed.coverage.currentDay;
    const rule = ruleAt(seed.rules, dateStart(day));
    if (!rule) throw new Error("rule_fixture_missing");
    const grant: SupplyForecastGrant = {
      id: `grant:naver-board-11:123:${day}:1`,
      grantGameDate: day,
      refs: [{ lawId: "regular-box-v1", count: 64 }],
      claimWindowAssumed: true,
      sourceIds: ["fixture"],
      restatementOf: [],
    };
    const current = buildV3SupplyForecastCandidate({
      ...historical,
      grants: [grant],
      certifiedSnapshot: {
        ...seed,
        version: "certified-daily-v4",
        events: [
          ...seed.events,
          {
            id: grant.id,
            gameDate: day,
            at: iso(dateStart(day)),
            kind: "grant",
            status: "confirmed",
            refs: [
              { lawId: "regular-box-v1", count: 32 },
              { lawId: "regular-box-v1", count: 32 },
            ],
            ruleId: rule.id,
            claimWindowAssumed: true,
            sourceIds: grant.sourceIds,
            restatementOf: [],
          },
        ],
      },
      schedule: {
        ...historical.schedule,
        soloPeriods: historical.schedule.soloPeriods.map((period) => {
          const round = seed.soloRounds.find(
            (value) => value.startGameDate === period.effectiveFrom.slice(0, 10),
          );
          if (!round) throw new Error("round_fixture_missing");
          return { ...period, round: round.round, segment: 1 };
        }),
      },
    });
    expect(current.payloadVersion).toBe(5);
    expect(canonicalPublicationJson(publicationCandidate(historical))).toBe(before);
    const key = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const trust = {
      environment: "staging" as const,
      keyId: "fixture",
      minimumSequence: 1,
      publicKeyBase64: encodeBase64(
        new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)),
      ),
    };
    for (const candidate of [historical, current]) {
      const contentHash = await publicationHash(candidate);
      const pointer = await signPublication(
        {
          domain: POINTER_DOMAIN,
          environment: "staging",
          keyId: "fixture",
          sequence: 1,
          mode: "active",
          candidateId: candidate.candidateId,
          contentHash,
          operationId: "123",
          issuedAt: 1788231600000,
        },
        key.privateKey,
      );
      const authorization = await signPublication(
        {
          domain: ARTIFACT_DOMAIN,
          environment: "staging",
          keyId: "fixture",
          candidateId: candidate.candidateId,
          contentHash,
        },
        key.privateKey,
      );
      const envelope = { pointer, artifact: { authorization, candidate } };
      await expect(verifyPublication(envelope, trust)).resolves.toEqual(envelope);
      const bytes = {
        pointer: { ...pointer, statement: canonicalPublicationJson(pointer.statement) },
        artifact: {
          authorization: {
            ...authorization,
            statement: canonicalPublicationJson(authorization.statement),
          },
          candidate: canonicalPublicationJson(candidate),
        },
      };
      const verified = await verifyPublicationBytes(bytes, trust);
      expect(verified.snapshot).toEqual(candidate.certifiedSnapshot);
    }
    expect(canonicalPublicationJson(historical)).toBe(before);
  });
});
