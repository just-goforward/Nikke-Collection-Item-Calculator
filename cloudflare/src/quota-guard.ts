import {
  assertUsageAllowed,
  UsageGuardError,
  type UsageGuardOperation,
} from "../../shared/usageGuard";
import type { WorkerEnv } from "./env";
import { HttpError } from "./http-error";

export async function assertQuotaAllows(env: WorkerEnv, operation: UsageGuardOperation) {
  try {
    return await assertUsageAllowed(env.USAGE_GUARD_DB, operation);
  } catch (error) {
    if (error instanceof UsageGuardError) {
      throw new HttpError(503, error.code, false);
    }
    throw error;
  }
}
