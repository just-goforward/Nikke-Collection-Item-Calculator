export const STATE_FEEDBACK_VISIBLE_MS = 1700;

export const stateFeedbackAnimations = {
  panel: "animate-[state-feedback-panel_1200ms_ease-out_forwards] motion-reduce:animate-none",
  ring: "animate-[state-feedback-ring_1200ms_ease-out_forwards] motion-reduce:animate-none",
  badge: "animate-[state-feedback-badge_1500ms_ease-out_forwards] motion-reduce:animate-none",
  target: "animate-[state-feedback-target_900ms_ease-out] motion-reduce:animate-none",
  text: "animate-[state-feedback-text_900ms_ease-out] motion-reduce:animate-none",
} as const;
