import { freezeJson } from "../../shared/certifiedSupplyModel";
import { buildForecastCandidate } from "./candidate";

const constructedCandidates = new WeakSet<object>();
type ConstructedCandidate = Awaited<ReturnType<typeof buildConstructedForecastCandidate>>;

// Only the validating constructor can issue this in-isolate proof.
export function isConstructedNoticeCandidate(value: unknown): value is ConstructedCandidate {
  return typeof value === "object" && value !== null && constructedCandidates.has(value);
}

export async function buildConstructedForecastCandidate(
  eventId: string,
  ...args: Parameters<typeof buildForecastCandidate>
) {
  const envelope = await buildForecastCandidate(...args);
  const candidate = freezeJson({
    eventId,
    gameDay: envelope.candidate.forecastId.slice(7, 17),
    revision: args[4],
    envelope,
  });
  constructedCandidates.add(candidate);
  return candidate;
}
