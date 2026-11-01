import {
  installDecisionProductionCatalogSource,
  type DecisionProductionCatalog,
} from "./decisionProduction";
import { installVerifiedDecisionMapping, type VerifiedDecisionMapping } from "./decisionAcquisition";

/** Single generated public projection of scripts/production-operating-catalog.mjs.
 * Publication mappings are NOT trusted here; they arrive in verified signed bytes.
 */
export const DECISION_PUBLIC_CATALOG_PATH = "/decision-production-catalog.json";

export async function initializeDecisionProduction(mapping?: VerifiedDecisionMapping) {
  installDecisionProductionCatalogSource(() => undefined);
  installVerifiedDecisionMapping(mapping);
  if (location.origin !== "https://nikkecollection.com") return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(DECISION_PUBLIC_CATALOG_PATH, {
      credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return;
    const reader = response.body?.getReader();
    if (!reader) return;
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 16_384) return;
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const catalog: DecisionProductionCatalog = JSON.parse(text);
    // Mutable publication whitelists from unsigned JSON cannot authorize events.
    if (!Array.isArray(catalog.publications) || catalog.publications.length !== 0) return;
    installDecisionProductionCatalogSource(() => catalog);
  } catch {
    // Collection configuration cannot prevent the calculator from booting.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
