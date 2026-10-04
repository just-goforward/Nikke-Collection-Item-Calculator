import {
  checkVersion,
  currentMatches,
  epochCheck,
  parseRegistry,
  reason,
  sameRegistry,
} from "./registry.ts";
import { newAttempt, resolvePending, submit } from "./requests.ts";
import { type Api, type Journal, type Role, roles } from "./types.ts";

export async function operatorStop(
  api: Api,
  journal: Journal,
  accountId: string,
  role: Role,
  baseline?: number,
) {
  let epochComparison: "unavailable" | "compared" = "unavailable";
  const blocked = (cause: string) => ({
    fail: true,
    alert: true,
    nextStageAllowed: false,
    reason: cause,
    epochComparison,
  });
  if (journal.baselineEvidence !== "provided") return blocked("request_baseline_unavailable");
  try {
    const registry = parseRegistry(await api.registry(), accountId);
    epochComparison = epochCheck(registry.epoch, baseline);
    if (epochComparison !== "compared") return blocked("epoch_baseline_unavailable");
    for (const target of roles) await checkVersion(api, registry, target);
    if (await resolvePending(api, journal, registry)) return blocked("previous_request_unresolved");
    const before = new Set((await api.history(registry, role)).map((d) => d.id));
    const attempt = newAttempt(registry, role, "operator");
    // Evidence is durable on the operator machine, not automatically durable on
    // a hosted runner. Missing packets require a separate operator judgement.
    await journal.append({ attempt, state: "prepared" });
    if ((await api.activeRuns()) !== 0) {
      await journal.append({ attempt, state: "not_submitted" });
      return blocked("watchdog_run_active");
    }
    // This fresh read reduces stale context exposure; it is NOT an atomic fence.
    if (!sameRegistry(registry, parseRegistry(await api.registry(), accountId))) {
      await journal.append({ attempt, state: "not_submitted" });
      return blocked("registry_changed");
    }
    const result = await submit(api, journal, registry, role, { origin: "operator" }, attempt);
    const after = await api.history(registry, role);
    const stopObserved = after.some(
      (d) =>
        !before.has(d.id) &&
        d.message !== attempt.message &&
        d.message.startsWith("forecast-stop/v1:") &&
        d.message.endsWith(";kind=watchdog"),
    );
    const otherDeployment = after.some((d) => !before.has(d.id) && d.message !== attempt.message);
    const stable = sameRegistry(registry, parseRegistry(await api.registry(), accountId));
    if (!stable) return { ...blocked("registry_changed"), result };
    if (stopObserved) {
      // Yield only to this validated frozen pair. Do not follow changing epochs,
      // retry an unknown request, or infer a target from main or old context.
      const yieldResult =
        result.requestResolved && !(await currentMatches(api, registry, role))
          ? await submit(api, journal, registry, role, { origin: "operator" })
          : undefined;
      return { ...blocked("later_stop_observed"), result, yieldResult };
    }
    const currentVerified = await currentMatches(api, registry, role);
    const fail = result.state !== "verified" || !currentVerified || otherDeployment;
    return {
      result,
      currentVerified,
      fail,
      alert: fail,
      nextStageAllowed: !fail,
      reason: otherDeployment ? "concurrent_deployment_observed" : result.reason,
      epochComparison,
    };
  } catch (error) {
    return blocked(reason(error));
  }
}
