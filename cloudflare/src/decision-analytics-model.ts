import {
  AGGREGATE_DAYS, canonicalDecisionEvent, DecisionAnalyticsError, EPISODE_TTL_MS,
  ATTEMPTS, CURRENT_ACTIONS, OUTCOMES, MAX_CONTRIBUTIONS, MAX_STATE_BYTES, type DecisionEvent, type Stage, type ProducerContext,
} from "../../shared/decisionAnalyticsV3.ts";

export type Episode = {
  decisionId: string; createdAt: number; expiresAt: number; revision: number;
  producer: ProducerContext;
  slots: Partial<Record<Stage, DecisionEvent>>;
};
export type Contribution = { metric: string; bucket: string };
export type CommitPlan = {
  previousRevision: number; episode: Episode; event: DecisionEvent;
  increments: Contribution[]; day: string; aggregateExpiry: number; now: number;
};
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
export function dayExpiry(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) + AGGREGATE_DAYS * 86_400_000;
}
function executable(current: string): boolean {
  return current === "use_blue" || current === "use_purple" || current === "use_yellow";
}
function subsets(current: boolean, wait: boolean): string[] {
  return ["all", ...(current ? ["current"] : []), ...(wait ? ["wait"] : []), ...(current && wait ? ["both"] : [])];
}
/** Closed joint vocabulary, also independently constrained by proposed SQL. */
export function jointVocabulary(): Contribution[] {
  const values: Contribution[] = [];
  for (const current of CURRENT_ACTIONS) for (const wait of [false, true]) {
    const prefix = `${current}|${Number(wait)}`;
    for (const subset of subsets(current !== "none", wait)) {
      values.push({ metric: "joint_basis", bucket: `${prefix}|${subset}` });
      if (executable(current)) for (const outcome of OUTCOMES)
        values.push({ metric: "joint_outcome", bucket: `${prefix}|${subset}|${outcome}` });
    }
    if (executable(current)) for (const attempt of ATTEMPTS)
      values.push({ metric: "joint_attempt", bucket: `${prefix}|${attempt}` });
  }
  return values;
}
export function contributions(episode: Episode, now: number): Contribution[] {
  if (episode.expiresAt <= now || dayExpiry(utcDay(episode.createdAt)) <= now) return [];
  const calculation = episode.slots.calculation;
  if (!calculation || calculation.stage !== "calculation") return [];
  const c = calculation.data;
  const prefix = `${c.currentAction}|${Number(c.waitRecommended)}`;
  const values: Contribution[] = [{ metric: "stage", bucket: "calculation" }];
  for (const color of ["blue", "purple", "yellow"] as const) {
    values.push({ metric: `holdings_${color}`, bucket: c.holdings[color] });
    values.push({ metric: `expected_supply_${color}`, bucket: c.expectedSupply[color] });
  }
  const current = c.currentAction !== "none" ? episode.slots.current_presented : undefined;
  const wait = c.waitRecommended ? episode.slots.wait_presented : undefined;
  const first = episode.slots.first_action;
  const outcome = executable(c.currentAction) ? episode.slots.outcome_confirmation : undefined;
  const attempt = episode.slots.attempt_self_report;
  const terminal = episode.slots.terminal;
  for (const event of [current, wait, first, outcome, terminal])
    if (event) values.push({ metric: "stage", bucket: event.stage });
  for (const subset of subsets(Boolean(current), Boolean(wait)))
    values.push({ metric: "joint_basis", bucket: `${prefix}|${subset}` });
  if (first?.stage === "first_action") values.push({ metric: "first_action", bucket: first.data.action });
  if (outcome?.stage === "outcome_confirmation") {
    for (const subset of subsets(Boolean(current && current.ordinal < outcome.ordinal), Boolean(wait && wait.ordinal < outcome.ordinal)))
      values.push({ metric: "joint_outcome", bucket: `${prefix}|${subset}|${outcome.data.outcome}` });
    if (outcome.data.outcome === "success" && attempt?.stage === "attempt_self_report" &&
        attempt.data.outcomeEventId === outcome.eventId && outcome.ordinal < attempt.ordinal) {
      values.push({ metric: "stage", bucket: "attempt_self_report" });
      values.push({ metric: "joint_attempt", bucket: `${prefix}|${attempt.data.attempts}` });
    }
  }
  if (terminal?.stage === "terminal") values.push({ metric: "terminal", bucket: terminal.data.reason });
  if (values.length > MAX_CONTRIBUTIONS) throw new DecisionAnalyticsError(503, "analytics_unavailable");
  return values;
}

export function sameEvent(a: DecisionEvent, b: DecisionEvent): boolean {
  return canonicalDecisionEvent(a) === canonicalDecisionEvent(b);
}
function producerOf(event: DecisionEvent): ProducerContext {
  if (event.stage !== "calculation") throw new DecisionAnalyticsError(409, "decision_parent_missing", true);
  return Object.freeze({ producerVersion: event.data.producerVersion, producerCodeHash: event.data.producerCodeHash });
}

/** Server-admitted parent only. No follow-up creates a parent, sliding TTL or cross-episode link. */
export function planEvent(previous: Episode | null, event: DecisionEvent, now: number): CommitPlan {
  if (!previous && event.stage !== "calculation")
    throw new DecisionAnalyticsError(409, "decision_parent_missing", true);
  if (previous && previous.expiresAt <= now) throw new DecisionAnalyticsError(410, "decision_expired");
  if (previous && previous.decisionId !== event.decisionId)
    throw new DecisionAnalyticsError(409, "decision_event_conflict");
  const calculation = previous?.slots.calculation;
  if (calculation?.stage === "calculation") {
    if (event.stage === "wait_presented" && !calculation.data.waitRecommended)
      throw new DecisionAnalyticsError(400, "wait_not_recommended");
    if (event.stage === "current_presented" && calculation.data.currentAction === "none")
      throw new DecisionAnalyticsError(400, "current_not_recommended");
    if ((event.stage === "outcome_confirmation" || event.stage === "attempt_self_report") && !executable(calculation.data.currentAction))
      throw new DecisionAnalyticsError(400, "outcome_without_current_action");
    const outcome = previous?.slots.outcome_confirmation;
    if (event.stage === "attempt_self_report" && outcome?.stage === "outcome_confirmation" &&
        (outcome.data.outcome !== "success" || outcome.eventId !== event.data.outcomeEventId || outcome.ordinal >= event.ordinal))
      throw new DecisionAnalyticsError(409, "attempt_outcome_mismatch");
  }
  const occupied = previous?.slots[event.stage];
  if (occupied) throw new DecisionAnalyticsError(409, "decision_stage_conflict");
  if (previous && Object.values(previous.slots).some((slot) => slot.ordinal === event.ordinal))
    throw new DecisionAnalyticsError(409, "decision_order_conflict");
  const terminal = previous?.slots.terminal;
  if (terminal && event.ordinal > terminal.ordinal)
    throw new DecisionAnalyticsError(409, "decision_closed");
  if (event.stage === "terminal" && previous &&
      Object.values(previous.slots).some((slot) => slot.ordinal > event.ordinal))
    throw new DecisionAnalyticsError(409, "decision_order_conflict");
  const episode: Episode = previous
    ? { ...previous, revision: previous.revision + 1, slots: { ...previous.slots, [event.stage]: event } }
    : { decisionId: event.decisionId, createdAt: now, expiresAt: now + EPISODE_TTL_MS,
      revision: 1, producer: producerOf(event), slots: { calculation: event } };
  const bytes = new TextEncoder().encode(JSON.stringify(episode)).byteLength;
  if (bytes > MAX_STATE_BYTES) throw new DecisionAnalyticsError(400, "decision_state_too_large");
  const key = (entry: Contribution) => `${entry.metric}/${entry.bucket}`;
  const before = new Set(previous ? contributions(previous, now).map(key) : []);
  const increments = contributions(episode, now).filter((entry) => !before.has(key(entry)));
  const day = utcDay(episode.createdAt);
  return { previousRevision: previous?.revision ?? 0, episode, event, increments, day, aggregateExpiry: dayExpiry(day), now };
}
