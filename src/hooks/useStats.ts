import { useStatsQuery } from "./useStatsQuery";
import { useStatsSubmission } from "./useStatsSubmission";

export function useStats(queryEnabled: boolean) {
  const { markSubmitted, statsView } = useStatsQuery(queryEnabled);
  const queueStatsEvent = useStatsSubmission(markSubmitted);

  return { statsView, queueStatsEvent };
}
