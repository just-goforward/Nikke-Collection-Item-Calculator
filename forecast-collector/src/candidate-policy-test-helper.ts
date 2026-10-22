import assert from "node:assert/strict";
import physical from "../../scripts/certified-staging-approved-panel/v6/independent-physical-cohorts.json";
import { add, fromWire, mul, type Q, q, toNumber } from "../../shared/certifiedRational";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { SupplyForecastCandidateEnvelope } from "../../shared/supplyForecastCandidate";
import { sha256Hex, stableJson } from "./crypto";

const dayStart = (date: string) => Date.parse(`${date}T05:00:00+09:00`);
type QTriple = readonly [Q, Q, Q];

/** Policy-only oracle, starting from a byte-authenticated v4 envelope.
 * Physical means come from the sealed independent 0/1/2-reroll enumeration;
 * no candidate builder or product projection/prior computation is used here.
 * Rational arithmetic and wire conversion are shared; the policy and ledger sum are restated.
 */
export async function fixedPolicyEnvelope(historical: SupplyForecastCandidateEnvelope) {
  const candidate = structuredClone(historical.candidate);
  const snapshot = candidate.certifiedSnapshot;
  assert.ok(snapshot);
  assert.equal(snapshot.version, "certified-daily-v4");
  assert.equal(physical.cohorts.length, 3);
  const dispatch = ([0, 1, 2] as const).map((color) =>
    physical.cohorts.reduce((total, cohort, index) => {
      const value = cohort[color];
      assert.ok(value);
      return add(total, mul(fromWire(value), q(index + 1, 6)));
    }, q(0)),
  ) as [ReturnType<typeof q>, ReturnType<typeof q>, ReturnType<typeof q>];
  snapshot.version = "certified-daily-v5";
  snapshot.rules = snapshot.rules.map((rule) => {
    assert.equal(rule.id, "schedule-kit-v4:documented-physical-supply-v2");
    return { ...rule, id: "schedule-kit-v5:documented-physical-supply-v2" };
  });
  snapshot.events = snapshot.events.map((event) => ({
    ...event,
    ruleId: "schedule-kit-v5:documented-physical-supply-v2",
  }));
  snapshot.provenance = snapshot.provenance.map((value) =>
    value === "schedule-kit-v4" ? "schedule-kit-v5" : value,
  );
  candidate.payloadVersion = 6;
  candidate.rulesVersion = "schedule-kit-v5";
  const ledgerHash = await sha256Hex(stableJson(snapshot));
  candidate.candidateId = `forecast-${(
    await sha256Hex(
      stableJson({ rulesVersion: "schedule-kit-v5", sourceHash: snapshot.sourceHash, ledgerHash }),
    )
  ).slice(0, 24)}`;
  candidate.profiles = candidate.profiles.map((profile) => {
    assert.ok(profile.referenceFrom && profile.referenceUntil);
    const totals = referenceTotals(
      snapshot,
      Date.parse(profile.referenceFrom),
      Date.parse(profile.referenceUntil),
      dispatch,
    );
    return {
      ...profile,
      expectedGain: {
        blue: toNumber(totals[0]),
        purple: toNumber(totals[1]),
        yellow: toNumber(totals[2]),
      },
    };
  });
  return { candidate, payloadHash: await sha256Hex(stableJson(candidate)) };
}

function referenceTotals(
  snapshot: CertifiedSupplySnapshot,
  from: number,
  until: number,
  dispatch: QTriple,
): QTriple {
  const counts = new Map<string, number>();
  for (const event of snapshot.events) {
    const at = dayStart(event.gameDate);
    if (at < from || at >= until || event.cancelled) continue;
    if (event.kind === "solo") {
      const round = snapshot.soloRounds.find((row) => row.round === event.round);
      assert.ok(round);
      if (round.status === "unverified") continue;
      if (
        round.status === "estimated" &&
        dayStart(round.startGameDate) <= Date.parse(snapshot.asOf)
      )
        continue;
    }
    for (const ref of event.refs) counts.set(ref.lawId, (counts.get(ref.lawId) ?? 0) + ref.count);
  }
  const means: Readonly<Record<string, QTriple>> = {
    "dispatch-board-v1": dispatch,
    "regular-box-v1": [q(12, 5), q(1, 5), q(0)],
    "box-ii-v1": [q(7, 2), q(2, 5), q(1, 5)],
    "deterministic:10,10,0": [q(10), q(10), q(0)],
  };
  const total: [ReturnType<typeof q>, ReturnType<typeof q>, ReturnType<typeof q>] = [
    q(0),
    q(0),
    q(0),
  ];
  for (const [id, count] of counts) {
    const mean = means[id];
    assert.ok(mean, `unmodeled oracle law: ${id}`);
    for (const color of [0, 1, 2] as const)
      total[color] = add(total[color], mul(mean[color], q(count)));
  }
  return total;
}
