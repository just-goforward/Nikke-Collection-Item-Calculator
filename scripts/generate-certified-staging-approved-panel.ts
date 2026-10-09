import { writeFileSync } from "node:fs";
import {
  APPROVED_PANEL_PATH,
  generateIndependentApprovedPanel,
} from "./certified-staging-approved-panel.ts";

// Frozen input/physical enumeration hashes and the enumeration source identity
// must match before this independent generator can replace expected values.
const rows = generateIndependentApprovedPanel();
writeFileSync(APPROVED_PANEL_PATH, `${JSON.stringify(rows, null, 2)}\n`);
console.log(
  JSON.stringify({ path: APPROVED_PANEL_PATH, cases: rows.length, independentWaiting: "NOTRUN" }),
);
