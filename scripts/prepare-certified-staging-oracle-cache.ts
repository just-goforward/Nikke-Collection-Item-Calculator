import { prepareIndependentPhysicalRatesCache } from "./certified-staging-oracle-cache.ts";

// V5 only; missing, stale or poisoned evidence is fatal, not a legacy fallback.
console.log(JSON.stringify(prepareIndependentPhysicalRatesCache(), null, 2));
