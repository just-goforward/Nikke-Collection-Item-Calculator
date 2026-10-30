import { BANDS, MAX_PRODUCERS } from "../../shared/decisionAnalyticsV3.ts";
import type { Bands, ProducerContext, StageData } from "../../shared/decisionAnalyticsV3.ts";
import { createDecisionClient, DECISION_COLLECTION_ENABLED } from "./decisionClient.ts";
import { createDecisionRun } from "./decisionRun.ts";
import type { RunProvider, RunRecord } from "./decisionRun.ts";
import { holdingsBands } from "./decisionProvider.ts";

type Options = {
  enabled?: boolean;
  producer?: RunProvider;
  allowedProducers?: readonly ProducerContext[];
  send?: Parameters<typeof createDecisionClient>[0]["send"];
  now: () => number;
  randomUUID: () => string;
  schedule?: Parameters<typeof createDecisionClient>[0]["schedule"];
};
function approved(producer: RunProvider | undefined, allowed: readonly ProducerContext[]) {
  return !!producer && allowed.length > 0 && allowed.length <= MAX_PRODUCERS &&
    new Set(allowed.map(tuple => tuple.producerVersion)).size === allowed.length &&
    allowed.every(tuple => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tuple.producerVersion) &&
      /^[0-9a-f]{64}$/.test(tuple.producerCodeHash)) &&
    allowed.some(tuple => tuple.producerVersion === producer.producerVersion &&
      tuple.producerCodeHash === producer.producerCodeHash);
}
function bands(value: Readonly<{ blue: string; purple: string; yellow: string }>): Bands | undefined {
  const member = (s: string): s is Bands["blue"] => BANDS.some(b => b === s);
  return member(value.blue) && member(value.purple) && member(value.yellow) ?
    { blue: value.blue, purple: value.purple, yellow: value.yellow } : undefined;
}

/** No actual public producer, security provider or expected-supply mapping is registered here. */
export function createDecisionBridge(options: Options) {
  const producer = options.producer;
  const enabled = (options.enabled ?? DECISION_COLLECTION_ENABLED) === true;
  const allowed = enabled ? (options.allowedProducers ?? []).map(tuple => Object.freeze({
    producerVersion: tuple.producerVersion, producerCodeHash: tuple.producerCodeHash,
  })) : [];
  const ready = enabled &&
    typeof options.send === "function" && approved(producer, allowed);
  let activeReady = ready;
  let client: ReturnType<typeof createDecisionClient> | undefined;
  const tokens = new WeakMap<RunRecord, ReturnType<ReturnType<typeof createDecisionClient>["accepted"]>>();
  const eligibility = { committed: true, loaded: true, current: true, visible: true, stale: false, inert: false };
  let drain: Promise<void> | undefined;
  const flush = (): Promise<void> => {
    if (!client) return Promise.resolve();
    drain ??= client.flush().catch(() => undefined).finally(() => { drain = undefined; });
    return drain;
  };
  const lifecycle = createDecisionRun({
    enabled: ready,
    captureProvider: () => activeReady && approved(producer, allowed) ? producer : undefined,
    accepted(record, input) {
      const expectedSupply = bands(record.expectedSupply);
      if (!activeReady || !expectedSupply || !options.send) return false;
      const data: StageData["calculation"] = {
        producerVersion: record.provider.producerVersion, producerCodeHash: record.provider.producerCodeHash,
        publicationContentHash: record.contentHash,
        currentAction: record.current === null ? record.preserve ? "preserve" : "none" :
          record.current === "blue" ? "use_blue" : record.current === "purple" ? "use_purple" : "use_yellow",
        waitRecommended: record.verifiedWait !== null, holdings: holdingsBands(input.stock), expectedSupply,
      };
      client ??= createDecisionClient({
        enabled: ready, providerReady: () => activeReady, now: options.now, randomUUID: options.randomUUID,
        send: options.send, ...(options.schedule ? { schedule: options.schedule } : {}),
      });
      const token = client.accepted(data);
      if (!token) return false;
      tokens.set(record, token);
      flush();
      return true;
    },
    changed(record) {
      const token = tokens.get(record);
      if (!client || !token) return;
      // Preserve capture order: each run callback changes exactly one observation.
      if (record.firstAction) client.firstAction(token, record.firstAction);
      if (record.currentPresented) client.presented(token, eligibility, "current");
      if (record.waitPresented) client.presented(token, eligibility, "wait");
      if (record.outcome) {
        client.firstAction(token, "outcome_confirm");
        client.confirmOutcome(token, record.outcome);
      }
      const attempt = record.acceptedAttempt;
      if (attempt !== undefined && attempt >= 1)
        client.reportAttempt(token, attempt === 1 ? "one" : attempt < 5 ? "two_to_four" : attempt < 10 ? "five_to_nine" : "ten_plus");
      flush();
    },
    retired(record, reason) {
      const token = tokens.get(record);
      const known = ["unknown", "input_edit", "new_solve", "reset", "restore", "forecast_invalid", "unmount", "cancelled", "superseded"] as const;
      const terminal = known.find(value => value === reason);
      if (terminal) client?.retire(token, terminal);
      flush();
    },
  });
  return {
    enabled: ready, providerReady: () => activeReady, lifecycle,
    flush,
    disable: () => { activeReady = false; client?.disable(); },
  };
}
