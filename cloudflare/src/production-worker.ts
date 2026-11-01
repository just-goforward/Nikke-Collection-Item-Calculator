import { createProductionStatsWorker } from "./worker";
import { decisionMetadataInstallation } from "./generated/decision-production-installation";
export { Ingest, PublicStats, RawReader, Diagnostics } from "./stats-capabilities";

// The approved catalog must install the shared mapping and acquisition projection.
// Until then the production adapter rejects new M2 admission, without static fallback.
export default createProductionStatsWorker(decisionMetadataInstallation);
