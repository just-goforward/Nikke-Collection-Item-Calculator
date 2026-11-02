import type { Band, Bands, ProducerContext, StageData } from "../../shared/decisionAnalyticsV3.ts";

export type PublicDecisionBinding = StageData["calculation"];
export type DecisionProvider = Readonly<{
  producer: ProducerContext;
  allowedProducers: readonly ProducerContext[];
  publicForecast: Pick<StageData["calculation"], "publicationContentHash" | "expectedSupply">;
}>;
// No actual public release tuple is configured or approved.
export const decisionProvider: DecisionProvider | undefined = undefined;
export function providerConfigured(provider: DecisionProvider | undefined): provider is DecisionProvider {
  if (!provider || provider.allowedProducers.length < 1 || provider.allowedProducers.length > 2) return false;
  const versions = new Set<string>();
  for (const tuple of provider.allowedProducers) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tuple.producerVersion) ||
        !/^[0-9a-f]{64}$/.test(tuple.producerCodeHash) || versions.has(tuple.producerVersion)) return false;
    versions.add(tuple.producerVersion);
  }
  return provider.allowedProducers.some(tuple =>
    tuple.producerVersion === provider.producer.producerVersion &&
    tuple.producerCodeHash === provider.producer.producerCodeHash) &&
    /^[0-9a-f]{64}$/.test(provider.publicForecast.publicationContentHash);
}
export function pieceBand(value: number): Band {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_piece_count");
  return value === 0 ? "zero" : value < 10 ? "one_to_nine" : value < 50 ? "ten_to_forty_nine" :
    value < 200 ? "fifty_to_one_ninety_nine" : "two_hundred_plus";
}
export function holdingsBands(stock: { blue: number; purple: number; yellow: number }): Bands {
  return { blue: pieceBand(stock.blue), purple: pieceBand(stock.purple), yellow: pieceBand(stock.yellow) };
}
