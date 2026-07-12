import { formatInteger } from "../format";
import type { CollectionState } from "../types";
import type { OutcomePreview } from "../ui-types";

export function makeOutcomePreview(start: CollectionState, next: CollectionState): OutcomePreview {
  return {
    state: next,
    movement: next.grade !== start.grade || next.level !== start.level ? "reach" : "stay",
    expDelta: next.level === start.level ? Math.max(0, next.exp - start.exp) : 0,
  };
}

export function presentOutcomePreview(preview: OutcomePreview) {
  const stateLabel = `${preview.state.grade} ${preview.state.level}`;
  return {
    emphasis: `${stateLabel} ${preview.movement === "reach" ? "도달" : "유지"}`,
    suffix: preview.expDelta > 0 ? ` · EXP +${formatInteger(preview.expDelta)}` : "",
  };
}
