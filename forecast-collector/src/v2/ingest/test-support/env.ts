import { env } from "cloudflare:workers";
import type { CollectorEnv } from "../../../types";

// Same explicit construction as the existing collector tests (e.g. canary.test.ts):
// only the bindings a CollectorEnv needs, with FORECAST_V2_MODE genuinely absent
// unless a test sets it.
export const collectorTestEnv: CollectorEnv = {
  FORECAST_DB: env.FORECAST_DB,
  USAGE_GUARD_DB: env.USAGE_GUARD_DB,
  ADMIN_RATE_LIMITER: env.ADMIN_RATE_LIMITER,
  ADMIN_TOKEN: env.ADMIN_TOKEN,
  ENVIRONMENT: "test",
  DEPLOY_SHA: env.DEPLOY_SHA,
  POLL_MODE: "both",
};
