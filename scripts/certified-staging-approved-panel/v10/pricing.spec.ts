import { expect, it } from "vitest";
import { certifiedRecurringRate, expectedCertifiedRefs } from "../../../shared/certifiedSupply.ts";
import { q, wire } from "../../certified-staging-oracle.ts";
import { independentFourCohorts } from "../v8/physical.ts";
import {
  assertCadence,
  expectedRefs,
  observedCadence,
  type Priors,
  recurringRate,
} from "./pricing.ts";
import { prepareSnapshot } from "./snapshot.ts";

it("uses median 28 for predictions but independently observed mean 1253/41 for rates", async () => {
  const { snapshot } = await prepareSnapshot();
  expect(observedCadence()).toEqual({ numerator: 1253, denominator: 41, medianDays: 28 });
  expect(() =>
    assertCadence({ ...snapshot, cadence: { ...snapshot.cadence, numerator: 28, denominator: 1 } }),
  ).toThrow("Observed mean numerator");
  const cohorts = independentFourCohorts();
  const priors: Priors = [q(1, 7), q(2, 7), q(3, 7), q(1, 7)];
  expect(recurringRate(snapshot, priors, cohorts)).toEqual(
    certifiedRecurringRate(snapshot, priors.map(wire) as never),
  );
  const grant = snapshot.events.find((event) => event.kind === "grant");
  expect(grant).toBeDefined();
  if (!grant) throw new Error("Missing grant");
  expect(expectedRefs(grant.refs, priors, cohorts)).toEqual(
    expectedCertifiedRefs(grant.refs, priors, { laws: snapshot.laws }),
  );
}, 120_000);
