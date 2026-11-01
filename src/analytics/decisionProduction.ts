import { BANDS, type Bands, type ProducerContext } from "../../shared/decisionAnalyticsV3";
import { createOutcomeBridge } from "./outcomeBridge";
import { createOutcomeTransport } from "./decisionTransport";
import { OUTCOME_TURNSTILE_ACTION } from "../../shared/decisionOutcomeV4";
import { verifiedAcquisitionSupply, type PublicAcquisition } from "./decisionAcquisition";
import type { RunProvider } from "./decisionRun";
import { TurnstileTokenProvider } from "../lib/turnstileTokenProvider";
import { loadTurnstileScriptApi } from "../lib/turnstileScriptLoader";

export type DecisionPublication = PublicAcquisition & { expectedSupply: Bands };
/** Supplied by the single approved deployment catalog, never URL/query input. */
export type DecisionProductionCatalog = {
  enabled: boolean;
  producer: ProducerContext;
  allowedProducers: readonly ProducerContext[];
  turnstileSiteKey: string;
  /** Empty in the public catalog; unsigned mappings never authorize collection. */
  publications: readonly DecisionPublication[];
};
let catalogSource: (() => DecisionProductionCatalog | undefined) | undefined;
/** Bootstrap must install the approved catalog source before mounting App. */
export function installDecisionProductionCatalogSource(source: () => DecisionProductionCatalog | undefined) {
  catalogSource = source;
}

export async function createProductionDecision(
  source = catalogSource,
  environment = {
    origin: window.location.origin,
    fetch: window.fetch.bind(window),
    now: Date.now,
    randomUUID: () => window.crypto.randomUUID(),
    loadTurnstile: loadTurnstileScriptApi,
    createContainer: () => {
      const container = document.createElement("div");
      document.body.append(container);
      return container;
    },
  },
) {
  try {
    const initial = structuredClone(source?.());
    if (environment.origin !== "https://nikkecollection.com" ||
        initial?.enabled !== true || !/^[A-Za-z0-9_-]+$/.test(initial.turnstileSiteKey)) return undefined;
    const producer = (): RunProvider | undefined => {
      const current = source?.();
      if (!current?.enabled || current.turnstileSiteKey !== initial.turnstileSiteKey ||
          current.producer.producerVersion !== initial.producer.producerVersion ||
          current.producer.producerCodeHash !== initial.producer.producerCodeHash ||
          current.allowedProducers.length !== initial.allowedProducers.length ||
          current.allowedProducers.length < 1 || current.allowedProducers.length > 2 ||
          !current.allowedProducers.some(tuple => tuple.producerVersion === current.producer.producerVersion &&
            tuple.producerCodeHash === current.producer.producerCodeHash) ||
          !current.allowedProducers.every((tuple, index) =>
            tuple.producerVersion === initial.allowedProducers[index]?.producerVersion &&
            tuple.producerCodeHash === initial.allowedProducers[index]?.producerCodeHash)) return undefined;
      const forecasts = structuredClone(current.publications);
      if (forecasts.some(entry =>
        !/^[a-f0-9]{64}$/.test(entry.contentHash) ||
        !/^[a-f0-9]{64}$/.test(entry.runtimeSnapshotHash) ||
        typeof entry.asOf !== "string" || !Number.isFinite(Date.parse(entry.asOf)) ||
        !entry.expectedSupply ||
        ![entry.expectedSupply.blue, entry.expectedSupply.purple, entry.expectedSupply.yellow]
          .every(band => BANDS.includes(band)))) return undefined;
      return {
        ...current.producer, forecasts, verifiedSignedMapping: true,
        bindAcquisition: (_pinned, actual) => {
          const expectedSupply = verifiedAcquisitionSupply(actual);
          return expectedSupply ? { ...actual, expectedSupply } : undefined;
        },
      };
    };
    const containers: HTMLElement[] = [];
    // Security execution is lazy: unanswered recommendations make no token request.
    const makeTokens = () => new TurnstileTokenProvider<typeof OUTCOME_TURNSTILE_ACTION>(initial.turnstileSiteKey,
      environment.loadTurnstile, () => {
        const container = environment.createContainer();
        containers.push(container);
        return container;
      });
    let disposed = false;
    let activeTokens: TurnstileTokenProvider<typeof OUTCOME_TURNSTILE_ACTION> | undefined;
    const ready = () => !disposed && !!producer();
    const send = createOutcomeTransport({
      enabled: true, providerReady: ready, origin: environment.origin, fetch: environment.fetch,
      token: async (_action, signal) => {
        if (signal.aborted) throw new Error("decision_aborted");
        const tokens = makeTokens();
        activeTokens = tokens;
        const abort = () => tokens.dispose();
        signal.addEventListener("abort", abort, { once: true });
        try { return await tokens.issueToken(OUTCOME_TURNSTILE_ACTION); }
        finally {
          signal.removeEventListener("abort", abort);
          tokens.dispose();
          activeTokens = undefined;
          for (const container of containers.splice(0)) container.remove();
        }
      },
    });
    const bridge = createOutcomeBridge({
      captureProducer: producer,
      providerReady: ready,
      send, now: environment.now, randomUUID: environment.randomUUID,
    });
    return {
      ...bridge, providerReady: () => bridge.providerReady() && ready(),
      disable: () => {
        disposed = true;
        bridge.disable();
        activeTokens?.dispose();
        for (const container of containers) container.remove();
      },
    };
  } catch {
    return undefined;
  }
}
