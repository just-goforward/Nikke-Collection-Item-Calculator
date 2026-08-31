import {
  finishDispatcherInvocation,
  listDueAlerts,
  markAlertSendFailed,
  markAlertSent,
  markDispatchAccepted,
  markDispatchDiscordSent,
  markDispatchFailed,
  markDispatchRequested,
  raiseOpsAlert,
  readActionableWork,
  reserveNextDispatch,
  resolveOpsAlert,
  sanitizeErrorCode,
  startDispatcherInvocation,
  updateObservedAlerts,
} from "./db";
import {
  DiscordMessageError,
  dispatchAcceptedMessage,
  opsAlertMessage,
  opsRecoveryMessage,
  sendDiscordMessage,
} from "./discord";
import { dispatchProposalWorkflow, GithubDispatchError } from "./github-app";
import type { DispatcherEnv } from "./types";

const RETRY_DELAY_MS = 5 * 60 * 1_000;

export async function runDispatcher(env: DispatcherEnv, options: { scheduledTime?: number } = {}) {
  const scheduledTime = options.scheduledTime ?? Date.now();
  const invocationId = await startDispatcherInvocation(env.FORECAST_DB, {
    environment: env.ENVIRONMENT,
    deploymentSha: env.DEPLOY_SHA,
    scheduledTime,
  });
  if (!invocationId) {
    console.log(
      JSON.stringify({
        event: "forecast_dispatcher_duplicate_invocation",
        environment: env.ENVIRONMENT,
        deploymentSha: env.DEPLOY_SHA,
        scheduledTime,
      }),
    );
    return {
      invocationId: null,
      actionableCount: 0,
      dispatchId: null,
      status: "duplicate" as const,
      errorCode: null,
    };
  }
  let actionableCount = 0;
  let dispatchId: string | undefined;
  let invocationError: string | undefined;
  try {
    const work = await readActionableWork(env.FORECAST_DB, env.ENVIRONMENT);
    actionableCount = work.pendingCount + work.candidateCount;
    const reservation = await reserveNextDispatch(env.FORECAST_DB, {
      environment: env.ENVIRONMENT,
      invocationId,
      deploymentSha: env.DEPLOY_SHA,
      work,
      nowMs: Date.now(),
    });
    if (reservation) {
      dispatchId = reservation.dispatchId;
      await markDispatchRequested(
        env.FORECAST_DB,
        reservation.dispatchId,
        invocationId,
        Date.now(),
      );
      try {
        await dispatchProposalWorkflow(env, {
          dispatchId: reservation.dispatchId,
          mode: reservation.mode,
        });
        const acceptedAt = Date.now();
        await markDispatchAccepted(
          env.FORECAST_DB,
          reservation.dispatchId,
          invocationId,
          acceptedAt,
        );
        await resolveOpsAlert(env.FORECAST_DB, githubAlertKey(env), acceptedAt);
        await resolveOpsAlert(env.FORECAST_DB, `watchdog-fallback:${env.ENVIRONMENT}`, acceptedAt);
        try {
          const sent = await sendDiscordMessage(env, dispatchAcceptedMessage(env, reservation));
          await markDispatchDiscordSent(
            env.FORECAST_DB,
            reservation.dispatchId,
            sent.messageId,
            Date.now(),
          );
          await resolveOpsAlert(env.FORECAST_DB, discordAlertKey(env), Date.now());
        } catch (error) {
          const code = dispatcherErrorCode(error);
          await raiseOpsAlert(env.FORECAST_DB, {
            alertKey: discordAlertKey(env),
            environment: env.ENVIRONMENT,
            severity: "critical",
            component: "discord",
            errorCode: code,
            context: { dispatchId: reservation.dispatchId },
            notifyAfterCount: error instanceof DiscordMessageError && error.retryable ? 3 : 1,
            nowMs: Date.now(),
          });
        }
      } catch (error) {
        const code = dispatcherErrorCode(error);
        const retryAfterMs =
          error instanceof GithubDispatchError && error.retryAfterMs !== null
            ? error.retryAfterMs
            : RETRY_DELAY_MS;
        const failureDisposition = await markDispatchFailed(env.FORECAST_DB, {
          dispatchId: reservation.dispatchId,
          invocationId,
          errorCode: code,
          httpStatus: error instanceof GithubDispatchError ? error.status : null,
          retryAtMs: Date.now() + Math.max(RETRY_DELAY_MS, retryAfterMs),
          nowMs: Date.now(),
        });
        if (failureDisposition === "failed") {
          await raiseOpsAlert(env.FORECAST_DB, {
            alertKey: githubAlertKey(env),
            environment: env.ENVIRONMENT,
            severity: "critical",
            component: "github-app",
            errorCode: code,
            context: {
              dispatchId: reservation.dispatchId,
              httpStatus: error instanceof GithubDispatchError ? error.status : null,
            },
            notifyAfterCount: error instanceof GithubDispatchError && error.retryable ? 3 : 1,
            nowMs: Date.now(),
          });
          invocationError = code;
        } else {
          await resolveOpsAlert(env.FORECAST_DB, githubAlertKey(env), Date.now());
        }
      }
    }
    await updateObservedAlerts(env.FORECAST_DB, env.ENVIRONMENT, Date.now());
    await flushDiscordAlerts(env);
  } catch (error) {
    invocationError = dispatcherErrorCode(error);
    try {
      await raiseOpsAlert(env.FORECAST_DB, {
        alertKey: `dispatcher-internal:${env.ENVIRONMENT}`,
        environment: env.ENVIRONMENT,
        severity: "critical",
        component: "dispatcher",
        errorCode: invocationError,
        nowMs: Date.now(),
      });
      await flushDiscordAlerts(env);
    } catch {
      // The invocation row remains the durable evidence if D1 or Discord is unavailable.
    }
  } finally {
    await finishDispatcherInvocation(env.FORECAST_DB, invocationId, {
      status: invocationError ? "failure" : "completed",
      actionableCount,
      ...(dispatchId ? { dispatchId } : {}),
      ...(invocationError ? { errorCode: invocationError } : {}),
    });
    console.log(
      JSON.stringify({
        event: "forecast_dispatcher_invocation",
        environment: env.ENVIRONMENT,
        deploymentSha: env.DEPLOY_SHA,
        invocationId,
        actionableCount,
        dispatchId: dispatchId ?? null,
        status: invocationError ? "failure" : "completed",
        errorCode: invocationError ?? null,
      }),
    );
  }
  return {
    invocationId,
    actionableCount,
    dispatchId: dispatchId ?? null,
    status: invocationError ? ("failure" as const) : ("completed" as const),
    errorCode: invocationError ?? null,
  };
}

async function flushDiscordAlerts(env: DispatcherEnv) {
  const alerts = await listDueAlerts(env.FORECAST_DB, env.ENVIRONMENT, Date.now());
  for (const alert of alerts) {
    try {
      const payload =
        alert.state === "resolved" ? opsRecoveryMessage(alert) : opsAlertMessage(alert);
      const sent = await sendDiscordMessage(env, payload);
      await markAlertSent(env.FORECAST_DB, alert, sent.messageId, Date.now());
    } catch (error) {
      await markAlertSendFailed(
        env.FORECAST_DB,
        alert.alertKey,
        dispatcherErrorCode(error),
        Date.now(),
      );
    }
  }
}

function githubAlertKey(env: DispatcherEnv) {
  return `github-dispatch:${env.ENVIRONMENT}`;
}

function discordAlertKey(env: DispatcherEnv) {
  return `discord-dispatch-notice:${env.ENVIRONMENT}`;
}

function dispatcherErrorCode(error: unknown) {
  return sanitizeErrorCode(error instanceof Error ? error.message : "unknown");
}
