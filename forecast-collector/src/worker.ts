import { assertUsageAllowed, UsageGuardError } from "../../shared/usageGuard.ts";
import { collectionSchedule, rotationBoard } from "./collection-schedule";
import { runCollection } from "./collector";
import { handleHttpRequest } from "./http";
import { automationOperation, requireGuardDb } from "./http-shared";
import {
  activeProfilePhase,
  type ProfileCounts,
  profileIngestionAdmitted,
  profilePhase,
} from "./profile";
import { runRotationIngestion } from "./rotation-ingestion";
import { runRuntimeIngestion } from "./runtime-ingestion";
import type { CollectorEnv } from "./types";

export default {
  async scheduled(event, env, context) {
    console.log(
      JSON.stringify({
        event:
          profilePhase(env) === "off"
            ? "forecast_canary_scheduled_invocation"
            : "forecast_profile_scheduled_invocation",
        component: "collector",
        environment: env.ENVIRONMENT,
        deploymentSha: env.DEPLOY_SHA,
        slot: new Date(event.scheduledTime).toISOString(),
      }),
    );
    if (env.COLLECT_ENABLED !== "true") {
      logProfile(env, event.scheduledTime, "collection_disabled");
      console.log(
        JSON.stringify({
          event: "forecast_collection_skipped",
          environment: env.ENVIRONMENT,
          reason: "collection_disabled",
        }),
      );
      return;
    }
    try {
      await assertUsageAllowed(requireGuardDb(env), automationOperation(env));
    } catch (error) {
      if (error instanceof UsageGuardError) {
        logProfile(env, event.scheduledTime, "usage_guard_disabled");
        console.warn(
          JSON.stringify({
            event: "forecast_collection_quota_disabled",
            environment: env.ENVIRONMENT,
            action: error.action,
          }),
        );
        return;
      }
      logProfile(env, event.scheduledTime, "usage_guard_failed");
      throw error;
    }
    context.waitUntil(
      profilePhase(env) !== "off"
        ? runProfile(env, event.scheduledTime)
        : collectionSchedule(env) === "rotation"
          ? runRotation(env, event.scheduledTime)
          : runCollection(env, { nowMs: event.scheduledTime }).then(async (summary) => {
              if (summary.outcome === "completed") await runRuntimeIngestion(env);
              return summary;
            }),
    );
  },

  fetch(request, env, context) {
    return handleHttpRequest(request, env, context);
  },
} satisfies ExportedHandler<CollectorEnv>;

async function runRotation(env: CollectorEnv, scheduledTime: number) {
  const board = rotationBoard(scheduledTime);
  const result =
    board === null
      ? await runRotationIngestion(env, scheduledTime)
      : await runCollection(env, { nowMs: scheduledTime, board, rotation: true });
  console.log(
    JSON.stringify({
      event: "forecast_rotation_slot",
      slot: new Date(scheduledTime).toISOString(),
      board,
      outcome: result.outcome,
      reason:
        board === null && result.outcome === "held" ? "admission_or_lease_held" : result.outcome,
    }),
  );
}

async function runProfile(env: CollectorEnv, scheduledTime: number) {
  const phase = activeProfilePhase(env, scheduledTime);
  const counts: ProfileCounts = { rowsPolled: 0, noticesReserved: 0, bodyBytes: 0 };
  let outcome = "failed";
  try {
    if (phase === "ingest-only") {
      if (!(await profileIngestionAdmitted(env.FORECAST_DB, Date.now()))) {
        outcome = "skipped_no_recent_completed_collection";
        return;
      }
      // The read above is only a skip diagnostic; the lease INSERT rechecks and
      // consumes eligibility atomically, including changes since that read.
      outcome = (await runRuntimeIngestion(env, { counts, requireProfileAdmission: true })).outcome;
    } else {
      outcome = (
        await runCollection(env, {
          nowMs: scheduledTime,
          ...(phase === "board-48" ? { board: 48 as const } : {}),
          ...(phase === "board-56" ? { board: 56 as const } : {}),
          counts,
        })
      ).outcome;
    }
  } finally {
    logProfile(env, scheduledTime, outcome, counts);
  }
}

function logProfile(
  env: CollectorEnv,
  scheduledTime: number,
  outcome: string,
  counts: ProfileCounts = { rowsPolled: 0, noticesReserved: 0, bodyBytes: 0 },
) {
  const phase = activeProfilePhase(env, scheduledTime);
  if (phase === "off") return;
  console.log(
    JSON.stringify({
      event: "forecast_collector_profile",
      phase,
      slot: new Date(scheduledTime).toISOString(),
      outcome,
      ...counts,
    }),
  );
}
