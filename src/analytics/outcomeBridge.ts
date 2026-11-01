import { parseOutcomeEnvelope, type OutcomeCommit, type OutcomeEvent, type OutcomeMethod, type OutcomeResponse } from "../../shared/decisionOutcomeV4";
import { acquisitionForResult, requestDecisionAcquisition, verifiedPublicReference } from "./decisionAcquisition";
import type { AcceptedOutcomeContext } from "./acceptedOutcome";
import type { DecisionLifecycle } from "./decisionLifecycle";
import type { RunProvider } from "./decisionRun";
import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";

type Options = {
  captureProducer: () => RunProvider | undefined;
  providerReady: () => boolean;
  randomUUID: () => string;
  now: () => number;
  send: (event: OutcomeEvent, signal: AbortSignal) => Promise<OutcomeResponse>;
};
type Owner = {
  provider: RunProvider;
  data?: Omit<OutcomeCommit["data"], "holdings" | "chosenMethod" | "recommendedUses" | "outcome" | "attemptCount" | "legacySettlement">;
  reportId?: string;
  patched?: boolean;
  legacySettlement?: StatsSubmissionEvent;
  settlementSent?: boolean;
};
type Entry = { event: OutcomeEvent; attempts: number; expires: number };
const method = (kit: AcceptedOutcomeContext["action"]): OutcomeMethod =>
  kit === "blue" ? "use_blue" : kit === "purple" ? "use_purple" : "use_yellow";

/** Outcome-only RAM outbox. A solver owner never allocates a report or contacts the server. */
export function createOutcomeBridge(options: Options) {
  let enabled = true;
  let current: Owner | undefined;
  const owners = new WeakSet<object>();
  const reservations = new Set<object>();
  let queue: Entry[] = [];
  let active: AbortController | undefined;
  let drain: Promise<void> | undefined;
  const ready = () => enabled && options.providerReady();
  const flush = (): Promise<void> => {
    if (drain) return drain;
    drain = (async () => {
      while (ready() && queue.length) {
        const entry = queue[0]!;
        if (entry.expires <= options.now() || entry.attempts >= 3) { queue.shift(); continue; }
        active = new AbortController();
        entry.attempts++;
        let response: OutcomeResponse;
        try { response = await options.send(entry.event, active.signal); }
        catch { response = { error: "analytics_unavailable", retryable: true }; }
        active = undefined;
        if (!enabled) return;
        if ("ok" in response || !response.retryable || entry.attempts >= 3) queue.shift();
      }
    })().catch(() => undefined).finally(() => { drain = undefined; });
    return drain;
  };
  const append = (event: Record<string, unknown>) => {
    if (!ready() || queue.length + reservations.size >= 20) return false;
    const normalized = parseOutcomeEnvelope({
      ...event, turnstileToken: "validation-only-not-a-network-token",
    }).event;
    queue.push({ event: normalized, attempts: 0, expires: options.now() + 15 * 60_000 });
    void flush();
    return true;
  };
  const lifecycle: DecisionLifecycle = {
    begin(input) {
      current = undefined;
      if (!ready()) return undefined;
      const provider = options.captureProducer();
      if (!provider) return undefined;
      requestDecisionAcquisition(input);
      current = { provider: { ...provider } };
      owners.add(current);
      return current;
    },
    accepted(owner, input, result) {
      if (!ready() || owner !== current || !current || current.data) return;
      const certified = result.certified;
      const acquisition = acquisitionForResult(result);
      const supplyReference = acquisition && verifiedPublicReference(acquisition);
      if (!certified || !supplyReference || !certified.action || input.start.level >= 15) return;
      const output = certified.output;
      if (current.provider.producerCodeHash !== output.runtimeBinding.engineProfile.codeHash ||
          output.refusal || output.claimNotice || output.current?.status === "complete") return;
      const selection = output.stableRecommendation?.selection;
      const guidance = output.stableRecommendation?.guidance;
      current.data = {
        producerVersion: current.provider.producerVersion, producerCodeHash: current.provider.producerCodeHash,
        supplyReference, recommendedCurrent: method(certified.action.kit),
        waitRecommended: certified.final === true && selection?.status === "WAIT" && guidance?.status === "WAIT" &&
          selection.day === guidance.day,
      };
    },
    captureOutcomeOwner: () => current?.data ? current : undefined,
    prepareOutcome(owner, context) {
      if (!ready() || owner !== current || !current?.data || current.reportId ||
          queue.length + reservations.size >= 20) return undefined;
      const prepared = Object.freeze({ owner, holdings: context.stock, chosenMethod: method(context.action),
        recommendedUses: context.recommendedUses });
      reservations.add(prepared);
      return prepared;
    },
    releaseOutcomePreparation(prepared) {
      if (prepared && typeof prepared === "object") reservations.delete(prepared);
    },
    retainLegacySettlement(owner, event) {
      const report = owner as Owner | undefined;
      if (!report || !owners.has(report)) return;
      report.legacySettlement = event;
      if (report.reportId && !report.settlementSent && append({
        version: 4, kind: "confirmed_outcome", operation: "attempt_patch", reportId: report.reportId,
        data: { attemptCount: null, legacySettlement: event },
      })) {
        report.settlementSent = true;
        delete report.legacySettlement;
      }
    },
    outcomeConfirmed(owner, outcome, prepared, legacySettlement) {
      if (!ready() || owner !== current || !current?.data || current.reportId || !prepared) return;
      const captured = prepared as { owner: unknown; holdings: AcceptedOutcomeContext["stock"]; chosenMethod: OutcomeMethod; recommendedUses: number };
      if (captured.owner !== owner || !reservations.delete(captured)) return;
      if (legacySettlement) current.legacySettlement = legacySettlement;
      const reportId = options.randomUUID();
      if (append({
        version: 4, kind: "confirmed_outcome", operation: "commit", reportId,
        data: { ...current.data, holdings: { ...captured.holdings }, chosenMethod: captured.chosenMethod,
          recommendedUses: captured.recommendedUses,
          outcome: outcome === "success" ? "great" : "no_great", attemptCount: null,
          legacySettlement: current.legacySettlement ?? null },
      })) {
        current.reportId = reportId;
        current.settlementSent = current.legacySettlement !== undefined;
        delete current.legacySettlement;
      }
    },
    attemptReported(owner, attempt, legacySettlement) {
      const report = owner as Owner | undefined;
      if (!report || !owners.has(report) || !report.reportId || report.patched ||
          !Number.isSafeInteger(attempt) || attempt < 1) return;
      if (legacySettlement) report.legacySettlement = legacySettlement;
      if (append({ version: 4, kind: "confirmed_outcome", operation: "attempt_patch",
        reportId: report.reportId, data: {
          attemptCount: attempt, legacySettlement: report.settlementSent ? null : report.legacySettlement ?? null,
        } })) {
        report.patched = true;
        if (report.legacySettlement) report.settlementSent = true;
        delete report.legacySettlement;
      }
    },
    retire(owner) { if (owner === current) current = undefined; },
  };
  return {
    enabled: true, lifecycle, providerReady: ready, flush,
    disable() { enabled = false; current = undefined; queue = []; reservations.clear(); active?.abort(); },
  };
}
