import { type AppLocale, formatIntegerForLocale, translate } from "../i18n/locale";
import type { CollectionState } from "../types";
import type { OutcomePreview } from "../ui-types";

export function makeOutcomePreview(start: CollectionState, next: CollectionState): OutcomePreview {
  return {
    state: next,
    movement: next.grade !== start.grade || next.level !== start.level ? "reach" : "stay",
    expDelta: next.level === start.level ? Math.max(0, next.exp - start.exp) : 0,
  };
}

export function presentOutcomePreview(preview: OutcomePreview, locale: AppLocale) {
  const stateLabel = `${preview.state.grade} ${preview.state.level}`;
  return {
    emphasis: `${stateLabel} ${translate(
      locale,
      preview.movement === "reach" ? "common.reach" : "common.stay",
    )}`,
    suffix:
      preview.expDelta > 0 ? ` · EXP +${formatIntegerForLocale(locale, preview.expDelta)}` : "",
  };
}
