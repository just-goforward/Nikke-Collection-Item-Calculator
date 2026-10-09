/** Runtime integration fixture: runs in a real Worker, never imported by the app. */
import { type CertifiedRequest, type CertifiedResponse, requireProfile } from "./protocol.ts";
export type LifecycleFixtureInput = {
  delayMs: number;
  value: string;
  block?: boolean;
  partial?: string;
  failureCode?: string;
  errorAtDeadline?: boolean;
  resultIdentityMutation?: boolean;
  resultProfileMutation?: boolean;
  computeIdentityMutation?: boolean;
  computeProfileMutation?: boolean;
  errorIdentityMutation?: boolean;
  errorProfileMutation?: boolean;
  omitComputeIdentity?: boolean;
  omitErrorIdentity?: boolean;
};
export function installLifecycleFixture(
  receive: (listener: (message: CertifiedRequest<LifecycleFixtureInput>) => void) => void,
  post: (message: CertifiedResponse<string>) => void,
  initializationDelayMs = 0,
) {
  receive((message) => {
    try {
      requireProfile(message.engineProfile);
      if (message.type === "init") {
        setTimeout(
          () =>
            post({
              type: "initComplete",
              generation: message.generation,
              engineProfile: message.engineProfile,
            }),
          initializationDelayMs,
        );
        return;
      }
      const computeBinding: Pick<typeof message, "forecastIdentity"> = {};
      if (message.forecastIdentity && !message.input.omitComputeIdentity) {
        computeBinding.forecastIdentity = message.input.computeIdentityMutation
          ? { ...message.forecastIdentity, snapshotHash: "b".repeat(64) }
          : message.forecastIdentity;
      }
      post({
        type: "computeStarted",
        generation: message.generation,
        id: message.id,
        engineProfile: message.input.computeProfileMutation
          ? { ...message.engineProfile, codeHash: "b".repeat(64) }
          : message.engineProfile,
        ...computeBinding,
      });
      if (message.input.partial)
        post({
          type: "current",
          generation: message.generation,
          id: message.id,
          output: message.input.partial,
          engineProfile: message.engineProfile,
          ...(message.forecastIdentity ? { forecastIdentity: message.forecastIdentity } : {}),
        });
      const finish = () => {
        if (message.input.failureCode) {
          const errorBinding: Pick<typeof message, "forecastIdentity"> = {};
          if (message.forecastIdentity && !message.input.omitErrorIdentity) {
            errorBinding.forecastIdentity = message.input.errorIdentityMutation
              ? { ...message.forecastIdentity, snapshotHash: "b".repeat(64) }
              : message.forecastIdentity;
          }
          return post({
            type: "error",
            code: message.input.failureCode,
            message: "Fixture Worker failure after exact current.",
            engineProfile: message.input.errorProfileMutation
              ? { ...message.engineProfile, codeHash: "b".repeat(64) }
              : message.engineProfile,
            ...errorBinding,
            generation: message.generation,
            id: message.id,
          });
        }
        const resultBinding: Pick<typeof message, "forecastIdentity"> = {};
        if (message.forecastIdentity) {
          resultBinding.forecastIdentity = message.input.resultIdentityMutation
            ? { ...message.forecastIdentity, forecastId: "fixture-mismatch" }
            : message.forecastIdentity;
        }
        return post({
          type: "result",
          output: message.input.value,
          engineProfile: message.input.resultProfileMutation
            ? { ...message.engineProfile, codeHash: "b".repeat(64) }
            : message.engineProfile,
          ...resultBinding,
          generation: message.generation,
          id: message.id,
        });
      };
      if (message.input.errorAtDeadline) {
        setTimeout(finish, Math.max(0, message.deadlineAt - Date.now()));
        return;
      }
      if (message.input.block) {
        const until = performance.now() + message.input.delayMs;
        while (performance.now() < until) {
          /* Real CPU work cannot receive cancellation. */
        }
        finish();
      } else setTimeout(finish, message.input.delayMs);
    } catch (error) {
      post({
        type: "error",
        generation: message.generation,
        ...(message.type === "solve" ? { id: message.id } : {}),
        code: "profile",
        message: String(error),
        engineProfile: message.engineProfile,
        ...(message.type === "solve" && message.forecastIdentity
          ? { forecastIdentity: message.forecastIdentity }
          : {}),
      });
    }
  });
}
