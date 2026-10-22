import { expect, it } from "vitest";
import { calculatePanel } from "./certified-staging-approved-panel/v11/calculate.ts";
import { verifyEngines } from "./certified-staging-approved-panel/v11/engine-check.ts";
import { independentThreeCohorts } from "./certified-staging-approved-panel/v11/physical.ts";
import { prepareSnapshot } from "./certified-staging-approved-panel/v11/snapshot.ts";

it("matches solveCertified and solveCertifiedWasm against all 24 independent v5 cases", async () => {
  const { snapshot } = await prepareSnapshot();
  expect(snapshot.version).toBe("certified-daily-v5");
  const panel = calculatePanel(snapshot, independentThreeCohorts());
  expect(panel).toHaveLength(24);
  expect(await verifyEngines(snapshot, panel)).toBe(24);
}, 180_000);
