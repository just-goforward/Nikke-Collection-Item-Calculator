import { freezeCoherentSnapshot } from "./certifiedSupplyCoherence.ts";
import {
  CERTIFIED_SUPPLY_LAWS,
  type CertifiedLawRef,
  type CertifiedSupplyLaw,
} from "./certifiedSupplyLaws.ts";
import {
  CERTIFIED_SUPPLY_HISTORY_DAYS,
  CERTIFIED_SUPPLY_VERSION,
  type CertifiedSoloRound,
  type CertifiedSourceStatus,
  type CertifiedSupplyBuildInput,
  type CertifiedSupplyEvent,
  type CertifiedSupplyRule,
  type CertifiedSupplySnapshot,
  createCertifiedSupplyRule,
  DAY_MS,
  dateStart,
  iso,
  linkCertifiedSoloAnnouncement,
  ruleAt,
  timestamp,
  transitionCertifiedSoloDelay,
} from "./certifiedSupplyModel.ts";
import { forecastVersionsForSnapshot } from "./certifiedVersionPolicy.ts";
import { gameDayKey, gameDayStartCeilMs, gameDayStartMs } from "./gameDay.ts";
import {
  deriveExactSoloRaidCadence,
  type ExactSoloRaidCadence,
  estimateCertifiedSoloRounds,
  SOLO_RAID_ROUND_HISTORY,
  type SoloRaidRound,
  soloRaidSourceUrl,
} from "./soloRaidCadence.ts";

type Period = CertifiedSupplyBuildInput["soloPeriods"][number];
type BuildWindow = {
  now: number;
  today: number;
  from: number;
  until: number;
  sourceStatus: CertifiedSourceStatus;
  warnings: string[];
};
type RoundState = {
  confirmed: Map<number, SoloRaidRound>;
  known: SoloRaidRound[];
  cadence: ExactSoloRaidCadence;
  anchor: SoloRaidRound;
  associations: Map<number, Period>;
  historyGaps: string[];
};
type Collaboration = { start: number; end: number };

function buildWindow(input: CertifiedSupplyBuildInput): BuildWindow {
  const now = timestamp(input.asOf);
  const today = gameDayStartMs(now);
  const horizon = input.horizonDays ?? 56;
  if (!Number.isSafeInteger(horizon) || horizon < 56 || horizon > 366)
    throw new Error("certified_coverage_horizon_invalid");
  if (!input.revision || !/^[a-f0-9]{64}$/.test(input.sourceHash))
    throw new Error("certified_supply_provenance_invalid");
  return {
    now,
    today,
    from: today - CERTIFIED_SUPPLY_HISTORY_DAYS * DAY_MS,
    until: today + (horizon + 1) * DAY_MS,
    sourceStatus: input.sourceStatus ?? "uncertain",
    warnings: [],
  };
}

function refreshRoundState(state: RoundState) {
  state.known = [...state.confirmed.values()].sort((a, b) => a.round - b.round);
  let prefixLength = state.known.length;
  state.historyGaps = [];
  // The confirmed map retains the seeded history; reduction always has an anchor.
  state.anchor = state.known.reduce((previous, current, index) => {
    if (current.round !== previous.round + 1) {
      prefixLength = Math.min(prefixLength, index);
      const missing =
        current.round === previous.round + 2
          ? `r${previous.round + 1}`
          : `r${previous.round + 1}-r${current.round - 1}`;
      state.historyGaps.push(`confirmed_solo_history_gap:${missing}`);
    }
    return current;
  });
  state.cadence = deriveExactSoloRaidCadence(state.known.slice(0, prefixLength));
}

function announcementRound(
  state: RoundState,
  input: CertifiedSupplyBuildInput,
  period: Period,
  date: string,
) {
  const exact = state.known.find((round) => round.startGameDate === date);
  if (period.round !== undefined) return period.round;
  if (exact) return exact.round;
  const offsetDays =
    input.delayState?.anchorRound === state.anchor.round ? input.delayState.offsetDays : 0;
  const candidates = [
    ...state.known,
    ...estimateCertifiedSoloRounds({
      anchor: state.anchor,
      cadence: state.cadence,
      count: 12,
      offsetDays,
    }),
  ];
  return linkCertifiedSoloAnnouncement(candidates, date);
}

function confirmedStatus(
  previous: SoloRaidRound | undefined,
  date: string,
): SoloRaidRound["status"] {
  if (!previous) return "as_announced";
  return previous.startGameDate === date ? previous.status : "schedule_changed";
}

function applyConfirmedPeriod(state: RoundState, input: CertifiedSupplyBuildInput, period: Period) {
  const start = timestamp(period.effectiveFrom);
  const end = timestamp(period.effectiveUntil);
  if (end <= start) throw new Error("certified_solo_period_inverted");
  if (period.scheduleStatus !== "confirmed") return;
  const startGameDate = gameDayKey(start);
  const roundNumber = announcementRound(state, input, period, startGameDate);
  if (state.associations.has(roundNumber)) throw new Error("certified_solo_round_duplicate");
  state.associations.set(roundNumber, period);
  const previous = state.confirmed.get(roundNumber);
  state.confirmed.set(roundNumber, {
    round: roundNumber,
    startGameDate,
    status: confirmedStatus(previous, startGameDate),
    sourceFeedId: previous?.sourceFeedId ?? 0,
  });
  refreshRoundState(state);
}

function confirmedRoundState(input: CertifiedSupplyBuildInput): RoundState {
  const confirmed = new Map(SOLO_RAID_ROUND_HISTORY.map((round) => [round.round, { ...round }]));
  for (const round of input.confirmedRounds ?? []) confirmed.set(round.round, { ...round });
  const known = [...confirmed.values()].sort((a, b) => a.round - b.round);
  const state: RoundState = {
    confirmed,
    known,
    cadence: deriveExactSoloRaidCadence(),
    anchor: known.reduce((_, current) => current),
    associations: new Map(),
    historyGaps: [],
  };
  refreshRoundState(state);
  for (const period of input.soloPeriods) applyConfirmedPeriod(state, input, period);
  for (const round of input.soloRounds ?? []) {
    const first = round.segments[0];
    if (!first) throw new Error("certified_solo_segments_required");
    applyConfirmedPeriod(state, input, {
      round: round.round,
      effectiveFrom: first.effectiveFrom,
      effectiveUntil: first.effectiveUntil,
      scheduleStatus: "confirmed",
      segments: round.segments,
    });
  }
  return state;
}

function confirmedLedgerRound(
  entry: SoloRaidRound,
  associations: Map<number, Period>,
): CertifiedSoloRound {
  const period = associations.get(entry.round);
  return {
    round: entry.round,
    startGameDate: entry.startGameDate,
    endGameDate:
      period?.segments?.at(-1)?.rewardUntilGameDate ??
      (period ? gameDayKey(gameDayStartCeilMs(timestamp(period.effectiveUntil))) : null),
    status: "confirmed",
    sourceIds: entry.sourceFeedId > 0 ? [soloRaidSourceUrl(entry)] : ["accepted-period"],
    ...(period?.segments ? { segments: period.segments } : {}),
  };
}

function soloLedger(input: CertifiedSupplyBuildInput, window: BuildWindow, state: RoundState) {
  const { anchor, cadence } = state;
  const delayState = transitionCertifiedSoloDelay({
    anchor,
    cadence,
    asOf: input.asOf,
    sourceStatus: window.sourceStatus,
    ...(input.delayState ? { delayState: input.delayState } : {}),
  });
  const previousOffset =
    input.delayState?.anchorRound === anchor.round ? input.delayState.offsetDays : 0;
  if (delayState.offsetDays > previousOffset)
    window.warnings.push("healthy_no_announcement_delayed");
  if (window.sourceStatus === "uncertain")
    window.warnings.push("source_uncertain_no_automatic_delay");
  const count = Math.max(
    0,
    Math.ceil(
      (window.until - dateStart(anchor.startGameDate)) /
        DAY_MS /
        (cadence.numerator / cadence.denominator),
    ) + 2,
  );
  const estimates = estimateCertifiedSoloRounds({
    anchor,
    cadence,
    count,
    offsetDays: delayState.offsetDays,
  });
  const soloRounds = state.known.map((entry) => confirmedLedgerRound(entry, state.associations));
  for (const estimate of estimates) {
    const unverified = dateStart(estimate.startGameDate) <= window.now;
    soloRounds.push({
      ...estimate,
      endGameDate: unverified ? null : gameDayKey(dateStart(estimate.startGameDate) + 7 * DAY_MS),
      status: unverified ? "unverified" : "estimated",
      sourceIds: ["observed-mean-thursday-v1"],
    });
    if (unverified && dateStart(estimate.startGameDate) >= window.from - 7 * DAY_MS)
      window.warnings.push(`unverified_solo_round:r${estimate.round}`);
  }
  return { soloRounds, delayState };
}

function buildRules(input: CertifiedSupplyBuildInput, today: number): CertifiedSupplyRule[] {
  const start = iso(today - CERTIFIED_SUPPLY_HISTORY_DAYS * DAY_MS);
  const rules = JSON.parse(
    JSON.stringify(input.rules ?? [createCertifiedSupplyRule(start)]),
  ) as CertifiedSupplyRule[];
  rules.sort((a, b) => timestamp(a.effectiveFrom) - timestamp(b.effectiveFrom));
  if (rules.length > 1) {
    rules.reduce((previous, current) => {
      if (
        previous.effectiveUntil === null ||
        timestamp(previous.effectiveUntil) > timestamp(current.effectiveFrom)
      )
        throw new Error("certified_supply_rules_overlap");
      return current;
    });
  }
  return rules;
}

function collaborationWindows(input: CertifiedSupplyBuildInput): Collaboration[] {
  const collaborations = input.collaborationPeriods.map((period) => ({
    start: timestamp(period.effectiveFrom),
    end: timestamp(period.effectiveUntil),
  }));
  for (const period of collaborations)
    if (period.end <= period.start) throw new Error("certified_collaboration_period_inverted");
  return collaborations;
}

function recurringEvent(
  kind: "dispatch" | "shop" | "weekly-kits",
  at: number,
  refs: readonly CertifiedLawRef[],
  rule: CertifiedSupplyRule,
): CertifiedSupplyEvent {
  const gameDate = gameDayKey(at);
  return {
    id: `${kind}:${gameDate}`,
    gameDate,
    at: iso(at),
    kind,
    status: "confirmed",
    refs,
    ruleId: rule.id,
    expiresAt: kind === "weekly-kits" ? iso(at + 6 * DAY_MS) : null,
    sourceIds: rule.provenance,
  };
}

function recurringEvents(
  window: BuildWindow,
  rules: readonly CertifiedSupplyRule[],
  collaborations: Collaboration[],
) {
  const events: CertifiedSupplyEvent[] = [];
  let missingPastRules = false;
  let missingFutureRules = false;
  for (let at = window.from; at < window.until; at += DAY_MS) {
    const rule = ruleAt(rules, at);
    if (!rule) {
      if (at < window.today) missingPastRules = true;
      else if (at > window.today) missingFutureRules = true;
      continue;
    }
    events.push(recurringEvent("dispatch", at, rule.dispatch, rule));
    const weekday = new Date(at + 9 * 3_600_000).getUTCDay();
    if (weekday === 2) {
      const collaboration = collaborations.some((period) => at >= period.start && at < period.end);
      events.push(
        recurringEvent("shop", at, collaboration ? rule.collaborationShop : rule.normalShop, rule),
      );
    }
    if (weekday === 3 && rule.weeklyFixed)
      events.push(recurringEvent("weekly-kits", at, rule.weeklyFixed, rule));
  }
  return { events, missingPastRules, missingFutureRules };
}

function soloDayEvent(
  round: CertifiedSoloRound,
  period: Period | undefined,
  at: number,
  dayNumber: number,
  rule: CertifiedSupplyRule,
  dayRefs: readonly CertifiedLawRef[],
): CertifiedSupplyEvent {
  const availableAt =
    dayNumber === 1 && period ? Math.max(at, timestamp(period.effectiveFrom)) : at;
  return {
    id: `solo:r${round.round}:day${dayNumber}`,
    gameDate: gameDayKey(at),
    at: iso(availableAt),
    kind: "solo",
    status: round.status === "confirmed" ? "confirmed" : "estimated",
    refs: dayRefs,
    ruleId: rule.id,
    round: round.round,
    dayNumber,
    expiresAt: period?.effectiveUntil ?? null,
    sourceIds: round.sourceIds,
  };
}

function soloRoundEvents(
  round: CertifiedSoloRound,
  period: Period | undefined,
  rules: readonly CertifiedSupplyRule[],
  window: BuildWindow,
): CertifiedSupplyEvent[] {
  if (round.status === "unverified" || round.endGameDate === null) return [];
  if (round.segments) {
    return round.segments.flatMap((segment) => {
      const events: CertifiedSupplyEvent[] = [];
      for (
        let at = dateStart(segment.rewardFromGameDate), dayNumber = 1;
        at < dateStart(segment.rewardUntilGameDate);
        at += DAY_MS, dayNumber += 1
      ) {
        const available = Math.max(at, timestamp(segment.effectiveFrom));
        if (available < window.from || available >= window.until) continue;
        const rule = ruleAt(rules, at);
        const refs = rule?.soloDays[dayNumber - 1];
        if (!rule || !refs) throw new Error("certified_solo_segment_reward_rule_missing");
        events.push({
          ...soloDayEvent(round, period, at, dayNumber, rule, refs),
          id:
            segment.segment === 1
              ? `solo:r${round.round}:day${dayNumber}`
              : `solo:r${round.round}:segment${segment.segment}:day${dayNumber}`,
          segment: segment.segment,
          at: iso(available),
          expiresAt: segment.effectiveUntil,
          sourceIds: segment.sourceIds,
        });
      }
      return events;
    });
  }
  const events: CertifiedSupplyEvent[] = [];
  const end = dateStart(round.endGameDate);
  for (
    let at = dateStart(round.startGameDate), dayNumber = 1;
    at < end;
    at += DAY_MS, dayNumber += 1
  ) {
    const rule = ruleAt(rules, at);
    if (!rule) continue;
    const dayRefs = rule.soloDays[dayNumber - 1];
    if (!dayRefs) {
      window.warnings.push(`solo_reward_rule_missing:r${round.round}:day${dayNumber}`);
      continue;
    }
    const event = soloDayEvent(round, period, at, dayNumber, rule, dayRefs);
    const available = timestamp(event.at);
    if (available >= window.from && available < window.until) events.push(event);
  }
  return events;
}

function roundInWindow(round: CertifiedSoloRound, from: number, until: number) {
  const at = dateStart(round.startGameDate);
  return at >= from && at < until;
}
function missingConfirmedDuration(round: CertifiedSoloRound, window: BuildWindow) {
  return (
    round.status === "confirmed" &&
    round.endGameDate === null &&
    roundInWindow(round, window.from, window.today)
  );
}
function ongoingUnverified(round: CertifiedSoloRound, today: number) {
  const at = dateStart(round.startGameDate);
  return round.status === "unverified" && at <= today && at + 7 * DAY_MS > today + DAY_MS;
}

function historyMissing(
  input: CertifiedSupplyBuildInput,
  window: BuildWindow,
  rounds: CertifiedSoloRound[],
  missingRules: boolean,
) {
  const history = input.historyCoverage;
  const covered = Boolean(
    history && timestamp(history.from) <= window.from && timestamp(history.until) >= window.today,
  );
  const missing: string[] = [];
  if (!covered) missing.push("history_coverage");
  if (!history?.raidDurations || rounds.some((round) => missingConfirmedDuration(round, window)))
    missing.push("raid_durations");
  if (!history?.collaborationPeriods) missing.push("collaboration_periods");
  if (!history?.rewardRules || missingRules) missing.push("reward_rules");
  if (window.warnings.some((warning) => warning.startsWith("confirmed_solo_history_gap:")))
    missing.push("solo_round_identities");
  if (
    rounds.some(
      (round) => round.status === "unverified" && roundInWindow(round, window.from, window.today),
    )
  )
    missing.push("unverified_solo_rounds");
  window.warnings.push(...missing.map((item) => `missing_history:${item}`));
  if (rounds.some((round) => ongoingUnverified(round, window.today)))
    window.warnings.push("ongoing_unverified_round_excluded");
  return missing;
}

export function buildSnapshot(
  input: CertifiedSupplyBuildInput,
  referenceHorizon?: (rounds: readonly CertifiedSoloRound[]) => number,
): CertifiedSupplySnapshot {
  let window = buildWindow(input);
  const state = confirmedRoundState(input);
  window.warnings.push(...state.historyGaps);
  let ledger = soloLedger(input, window, state);
  if (referenceHorizon) {
    const horizonDays = referenceHorizon(ledger.soloRounds);
    window = buildWindow({ ...input, horizonDays });
    window.warnings.push(...state.historyGaps);
    ledger = soloLedger(input, window, state);
  }
  const { soloRounds, delayState } = ledger;
  const rules = buildRules(input, window.today);
  const recurring = recurringEvents(window, rules, collaborationWindows(input));
  const events = [
    ...recurring.events,
    ...(input.grants ?? []).flatMap((grant): CertifiedSupplyEvent[] => {
      const at = dateStart(grant.grantGameDate);
      if (at < window.from || at >= window.until) return [];
      const rule = ruleAt(rules, at);
      if (!rule) throw new Error("certified_grant_rule_missing");
      return [
        {
          id: grant.id,
          gameDate: grant.grantGameDate,
          at: iso(at),
          kind: "grant",
          status: "confirmed",
          refs: grant.refs,
          ruleId: rule.id,
          claimWindowAssumed: grant.claimWindowAssumed,
          sourceIds: grant.sourceIds,
          restatementOf: grant.restatementOf,
          ...(grant.claimUntil === undefined ? {} : { expiresAt: grant.claimUntil }),
        },
      ];
    }),
    ...soloRounds.flatMap((round) =>
      soloRoundEvents(round, state.associations.get(round.round), rules, window),
    ),
  ];
  events.sort((a, b) => timestamp(a.at) - timestamp(b.at) || a.id.localeCompare(b.id));
  const missing = historyMissing(input, window, soloRounds, recurring.missingPastRules);
  const futureMissing = recurring.missingFutureRules ? ["reward_rules"] : [];
  const snapshot: CertifiedSupplySnapshot = {
    version: CERTIFIED_SUPPLY_VERSION,
    futureLawSemantics: "independent_given_cohort-v1",
    revision: input.revision,
    sourceHash: input.sourceHash,
    asOf: iso(window.now),
    sourceStatus: window.sourceStatus,
    rules,
    laws: JSON.parse(JSON.stringify(input.laws ?? CERTIFIED_SUPPLY_LAWS)) as CertifiedSupplyLaw[],
    events,
    soloRounds,
    cadence: state.cadence,
    delayState,
    coverage: {
      from: iso(window.from),
      until: iso(window.until),
      currentDay: gameDayKey(window.today),
      past: {
        from: iso(window.from),
        until: iso(window.today),
        days: CERTIFIED_SUPPLY_HISTORY_DAYS,
        complete: missing.length === 0,
        missing,
      },
      future: {
        from: iso(window.today + DAY_MS),
        until: iso(window.today + 57 * DAY_MS),
        days: 56,
        complete: futureMissing.length === 0,
        missing: futureMissing,
      },
    },
    warnings: [...new Set(window.warnings)],
    provenance: [
      ...(input.provenance ?? []),
      forecastVersionsForSnapshot(CERTIFIED_SUPPLY_VERSION).rulesVersion,
      "documented-physical-supply-v2",
      ...state.cadence.sourceUrls,
    ],
  };
  return freezeCoherentSnapshot(snapshot);
}
