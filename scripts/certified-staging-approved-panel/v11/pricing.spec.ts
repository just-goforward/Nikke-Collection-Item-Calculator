import { expect, it } from "vitest";
import {
  certifiedRecurringRate,
  expectedCertifiedRefs,
  viewCertifiedSupplySnapshot,
} from "../../../shared/certifiedSupply.ts";
import { fromWire, wire } from "../../certified-staging-oracle.ts";
import { calculateBoundaries } from "./calculate.ts";
import { independentThreeCohorts } from "./physical.ts";
import { PRIORS, recurringRate } from "./pricing.ts";
import { prepareSnapshot } from "./snapshot.ts";

it("binds v5 pricing, dated median boundaries and grant means to the collector snapshot", async () => {
  const first = await prepareSnapshot();
  expect(await prepareSnapshot()).toEqual(first);
  const { snapshot } = first;
  const cohorts = independentThreeCohorts();
  expect(recurringRate(snapshot, cohorts)).toEqual(certifiedRecurringRate(snapshot));
  const boundaries = calculateBoundaries(snapshot, cohorts);
  expect(boundaries.predictions).toHaveLength(5);
  expect(boundaries.grants).toHaveLength(1);
  for (const prediction of boundaries.predictions) {
    const viewed = viewCertifiedSupplySnapshot(snapshot, prediction.asOf);
    const next = viewed.soloRounds.find((round) => round.round === 43);
    expect(next?.segments?.[0]?.effectiveFrom).toBe(prediction.start);
    expect(next?.segments?.[0]?.effectiveUntil).toBe(prediction.end);
    expect(viewed.delayState.offsetDays).toBe(prediction.offsetDays);
  }
  for (const grant of boundaries.grants) {
    const event = snapshot.events.find((entry) => entry.id === grant.id);
    expect(event?.at).toBe(grant.at);
    if (!event) throw new Error("Missing grant");
    expect(grant.expected.map(fromWire)).toEqual(
      expectedCertifiedRefs(event.refs, PRIORS, { laws: snapshot.laws }),
    );
  }
  expect(PRIORS.map(wire)).toEqual([
    { numerator: "1", denominator: "6" },
    { numerator: "1", denominator: "3" },
    { numerator: "1", denominator: "2" },
  ]);
  for (const field of ["dispatch", "normalShop", "weeklyFixed", "soloDays"] as const) {
    const changed = structuredClone(snapshot);
    changed.rules = changed.rules.map((rule) => ({ ...rule, [field]: [] }));
    expect(() => recurringRate(changed, cohorts)).toThrow();
  }
  expect(() => recurringRate({ ...snapshot, version: "certified-daily-v4" }, cohorts)).toThrow();
  expect(() =>
    recurringRate(
      {
        ...snapshot,
        cadence: { ...snapshot.cadence, numerator: 28, denominator: 1 },
      },
      cohorts,
    ),
  ).toThrow("Observed mean");
}, 120_000);
