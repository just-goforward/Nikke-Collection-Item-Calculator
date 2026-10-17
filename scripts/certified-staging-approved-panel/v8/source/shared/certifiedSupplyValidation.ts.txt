import { add, eq, fromWire, ONE, ZERO } from "./certifiedRational.ts";
import {
  CERTIFIED_SUPPLY_LAWS,
  type CertifiedLawRef,
  type CertifiedSupplyLaw,
  LEGACY_CERTIFIED_SUPPLY_LAWS,
} from "./certifiedSupplyLaws.ts";
import {
  CERTIFIED_SUPPLY_HISTORY_DAYS,
  CERTIFIED_SUPPLY_VERSION,
  CERTIFIED_WEEKLY_FIXED_LAW_ID,
  type CertifiedSoloRound,
  type CertifiedSupplyCoverageWindow,
  type CertifiedSupplyEvent,
  type CertifiedSupplyRule,
  type CertifiedSupplySnapshot,
  DAY_MS,
  dateStart,
  ruleAt,
  timestamp,
} from "./certifiedSupplyModel.ts";
import { gameDayKey, gameDayStartMs } from "./gameDay.ts";
import type { ExactSoloRaidCadence } from "./soloRaidCadence.ts";

function textList(list: unknown) {
  if (!Array.isArray(list)) return false;
  knownArrayFields(list);
  return list.every((entry) => typeof entry === "string");
}

function knownArrayFields(value: readonly unknown[]) {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
      throw new Error(`certified_snapshot_unknown_field:${String(key)}`);
  }
  if (keys.length !== value.length + 1) throw new Error("certified_snapshot_sparse_array_invalid");
}

function knownFields(value: unknown, keys: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("certified_snapshot_object_required");
  const allowed = new Set(keys.split(" "));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key))
      throw new Error(`certified_snapshot_unknown_field:${String(key)}`);
  }
}

/** Cartesian event supports are valid only for this explicitly declared conditional law. */
export function assertFutureLawIndependence(snapshot: CertifiedSupplySnapshot): void {
  if (snapshot.futureLawSemantics !== "independent_given_cohort-v1")
    throw new Error("certified_snapshot_future_law_semantics_unsupported");
}

function validateMetadata(snapshot: CertifiedSupplySnapshot) {
  knownFields(
    snapshot,
    "version futureLawSemantics revision sourceHash asOf sourceStatus rules laws events soloRounds cadence delayState coverage warnings provenance",
  );
  assertFutureLawIndependence(snapshot);
  if (
    typeof snapshot.revision !== "string" ||
    typeof snapshot.sourceHash !== "string" ||
    !["healthy", "uncertain"].includes(snapshot.sourceStatus)
  )
    throw new Error("certified_snapshot_metadata_invalid");
  if (!snapshot.coverage || !snapshot.cadence || !snapshot.delayState)
    throw new Error("certified_snapshot_structure_invalid");
  if (!textList(snapshot.provenance) || !textList(snapshot.warnings))
    throw new Error("certified_snapshot_provenance_list_invalid");
  JSON.stringify(snapshot);
  if (
    ![CERTIFIED_SUPPLY_VERSION, "certified-daily-v2", "certified-daily-v1"].includes(
      snapshot.version,
    ) ||
    !snapshot.revision ||
    !/^[a-f0-9]{64}$/.test(snapshot.sourceHash)
  )
    throw new Error("certified_snapshot_version_or_provenance_invalid");
  timestamp(snapshot.asOf);
}

function validateCollections(snapshot: CertifiedSupplySnapshot) {
  if (
    !Array.isArray(snapshot.events) ||
    !Array.isArray(snapshot.rules) ||
    !Array.isArray(snapshot.laws) ||
    !Array.isArray(snapshot.soloRounds)
  )
    throw new Error("certified_snapshot_collections_invalid");
  for (const collection of [snapshot.events, snapshot.rules, snapshot.laws, snapshot.soloRounds])
    knownArrayFields(collection);
  if (
    snapshot.events.length > 2048 ||
    snapshot.rules.length > 256 ||
    snapshot.laws.length > 256 ||
    snapshot.soloRounds.length > 10000
  )
    throw new Error("certified_snapshot_collections_invalid");
}

function validateQueryWindow(
  window: CertifiedSupplyCoverageWindow,
  expectedFrom: number,
  expectedUntil: number,
  from: number,
  until: number,
) {
  knownFields(window, "from until days complete missing");
  if (
    window?.days !== (expectedUntil - expectedFrom) / DAY_MS ||
    timestamp(window.from) !== expectedFrom ||
    timestamp(window.until) !== expectedUntil ||
    typeof window.complete !== "boolean" ||
    !textList(window.missing) ||
    (window.complete && window.missing.length !== 0)
  )
    throw new Error("certified_snapshot_query_window_invalid");
  if (window.complete && (expectedFrom < from || expectedUntil > until))
    throw new Error("certified_snapshot_complete_outside_authority");
}

function validateCoverage(snapshot: CertifiedSupplySnapshot) {
  knownFields(snapshot.coverage, "from until past future currentDay");
  const from = timestamp(snapshot.coverage.from);
  const until = timestamp(snapshot.coverage.until);
  const today = dateStart(snapshot.coverage.currentDay);
  if (
    until <= from ||
    gameDayStartMs(from) !== from ||
    gameDayStartMs(until) !== until ||
    gameDayKey(timestamp(snapshot.asOf)) !== snapshot.coverage.currentDay
  )
    throw new Error("certified_snapshot_coverage_invalid");
  // Archived query windows remain readable; new history queries cover seven days.
  const pastDays =
    snapshot.coverage.past.days === CERTIFIED_SUPPLY_HISTORY_DAYS
      ? CERTIFIED_SUPPLY_HISTORY_DAYS
      : 56;
  validateQueryWindow(snapshot.coverage.past, today - pastDays * DAY_MS, today, from, until);
  validateQueryWindow(snapshot.coverage.future, today + DAY_MS, today + 57 * DAY_MS, from, until);
}

function validateCadenceMean(cadence: ExactSoloRaidCadence) {
  knownFields(
    cadence,
    "version numerator denominator rounds intervals fromGameDate untilGameDate minimumDays maximumDays sourceStatuses sourceUrls",
  );
  if (
    cadence.numerator <= 0 ||
    cadence.denominator <= 0 ||
    !Number.isSafeInteger(cadence.numerator) ||
    !Number.isSafeInteger(cadence.denominator)
  )
    throw new Error("certified_snapshot_cadence_invalid");
  if (
    cadence.version !== "observed-mean-thursday-v1" ||
    cadence.rounds !== cadence.denominator + 1 ||
    cadence.intervals !== cadence.denominator ||
    !textList(cadence.sourceUrls)
  )
    throw new Error("certified_snapshot_cadence_provenance_invalid");
  if (
    (dateStart(cadence.untilGameDate) - dateStart(cadence.fromGameDate)) / DAY_MS !==
    cadence.numerator
  )
    throw new Error("certified_snapshot_cadence_period_invalid");
}

function validateCadenceSummary(cadence: ExactSoloRaidCadence) {
  knownFields(cadence.sourceStatuses, "as_announced rescheduled schedule_changed reconstructed");
  if (
    !Number.isSafeInteger(cadence.minimumDays) ||
    !Number.isSafeInteger(cadence.maximumDays) ||
    cadence.minimumDays <= 0 ||
    cadence.maximumDays < cadence.minimumDays ||
    !cadence.sourceStatuses
  )
    throw new Error("certified_snapshot_cadence_summary_invalid");
  const statuses = ["as_announced", "rescheduled", "schedule_changed", "reconstructed"] as const;
  const counts = statuses.map((status) => cadence.sourceStatuses[status]);
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    counts.reduce((a, b) => a + b, 0) !== cadence.rounds
  )
    throw new Error("certified_snapshot_cadence_source_status_invalid");
}

function validateDelay(snapshot: CertifiedSupplySnapshot) {
  const delay = snapshot.delayState;
  knownFields(delay, "anchorRound anchorGameDate offsetDays");
  if (
    !Number.isSafeInteger(delay.anchorRound) ||
    delay.anchorRound < 1 ||
    !Number.isSafeInteger(delay.offsetDays) ||
    delay.offsetDays < 0 ||
    delay.offsetDays % 7 !== 0
  )
    throw new Error("certified_snapshot_delay_state_invalid");
  dateStart(delay.anchorGameDate);
  if (
    snapshot.soloRounds.length > 0 &&
    !snapshot.soloRounds.some(
      (round) =>
        round.round === delay.anchorRound &&
        round.startGameDate === delay.anchorGameDate &&
        round.status === "confirmed",
    )
  )
    throw new Error("certified_snapshot_delay_anchor_invalid");
}

function validateRef(ref: CertifiedLawRef, lawIds: Set<string>) {
  knownFields(ref, "lawId count");
  if (
    !ref ||
    typeof ref.lawId !== "string" ||
    (!lawIds.has(ref.lawId) && !/^deterministic:\d+,\d+,\d+$/.test(ref.lawId))
  )
    throw new Error("certified_snapshot_law_reference_invalid");
  if (
    !Number.isSafeInteger(ref.count) ||
    ref.count < 0 ||
    ref.count > 64 ||
    (ref.lawId === "dispatch-board-v1" && ref.count > 1)
  )
    throw new Error("certified_snapshot_law_reference_invalid");
}

function validateRefs(refs: readonly CertifiedLawRef[], lawIds: Set<string>) {
  if (!Array.isArray(refs) || refs.length > 256)
    throw new Error("certified_snapshot_law_references_invalid");
  knownArrayFields(refs);
  for (const ref of refs) validateRef(ref, lawIds);
}

type WireOutcome = NonNullable<CertifiedSupplyLaw["outcomes"]>[number];
function validateOutcome(outcome: WireOutcome) {
  knownFields(outcome, "pieces mass");
  knownFields(outcome.mass, "numerator denominator");
  if (
    !Array.isArray(outcome.pieces) ||
    outcome.pieces.length !== 3 ||
    outcome.pieces.some((pieces: number) => !Number.isSafeInteger(pieces) || pieces < 0)
  )
    throw new Error("certified_snapshot_law_pieces_invalid");
  knownArrayFields(outcome.pieces);
  const probability = fromWire(outcome.mass);
  if (probability.n < 0n) throw new Error("certified_snapshot_law_probability_invalid");
  return probability;
}

function validateFiniteOutcomes(
  outcomes: readonly WireOutcome[] | undefined,
  checkBudget?: () => void,
) {
  if (!Array.isArray(outcomes) || outcomes.length === 0 || outcomes.length > 25000)
    throw new Error("certified_snapshot_finite_law_invalid");
  knownArrayFields(outcomes);
  let mass = ZERO;
  for (const [index, outcome] of outcomes.entries()) {
    if ((index & 127) === 0) checkBudget?.();
    mass = add(mass, validateOutcome(outcome));
  }
  if (!eq(mass, ONE)) throw new Error("certified_snapshot_law_mass_not_one");
}

function validateFiniteLaw(law: CertifiedSupplyLaw, cohortCount: 3 | 4, checkBudget?: () => void) {
  if (
    law.outcomesByCohort !== undefined &&
    (!Array.isArray(law.outcomesByCohort) || law.outcomesByCohort.length !== cohortCount)
  )
    throw new Error("certified_snapshot_cohort_law_invalid");
  if (law.outcomesByCohort !== undefined) knownArrayFields(law.outcomesByCohort);
  let groups: (readonly WireOutcome[] | undefined)[];
  if (law.outcomesByCohort) {
    const cohorts = [...law.outcomesByCohort];
    groups = law.outcomes ? [...cohorts, law.outcomes] : cohorts;
  } else {
    groups = [law.outcomes];
  }
  for (const outcomes of groups) validateFiniteOutcomes(outcomes, checkBudget);
}

function validateLaw(law: CertifiedSupplyLaw, cohortCount: 3 | 4, checkBudget?: () => void) {
  knownFields(law, "id kind modelVersion outcomes outcomesByCohort");
  if (
    typeof law.id !== "string" ||
    !law.id ||
    typeof law.modelVersion !== "string" ||
    !law.modelVersion ||
    !["dispatch", "box", "finite"].includes(law.kind)
  )
    throw new Error("certified_snapshot_law_invalid");
  if (law.kind === "finite") {
    validateFiniteLaw(law, cohortCount, checkBudget);
    return;
  }
  const known = (cohortCount === 3 ? LEGACY_CERTIFIED_SUPPLY_LAWS : CERTIFIED_SUPPLY_LAWS).some(
    (model) =>
      model.id === law.id && model.kind === law.kind && law.modelVersion === model.modelVersion,
  );
  if (!known || law.outcomes !== undefined || law.outcomesByCohort !== undefined)
    throw new Error("certified_snapshot_builtin_law_version_invalid");
}

function validateRuleHeader(
  rule: CertifiedSupplyRule,
  version: CertifiedSupplySnapshot["version"],
) {
  knownFields(
    rule,
    `id effectiveFrom effectiveUntil dispatch normalShop collaborationShop soloDays provenance${version === "certified-daily-v3" ? " weeklyFixed" : ""}`,
  );
  if (
    typeof rule.id !== "string" ||
    !rule.id ||
    !textList(rule.provenance) ||
    !Array.isArray(rule.soloDays) ||
    rule.soloDays.length > 64
  )
    throw new Error("certified_snapshot_rule_invalid");
  knownArrayFields(rule.soloDays);
  if (
    rule.effectiveUntil !== null &&
    timestamp(rule.effectiveUntil) <= timestamp(rule.effectiveFrom)
  )
    throw new Error("certified_snapshot_rule_period_invalid");
}

function validateRules(
  snapshot: CertifiedSupplySnapshot,
  lawIds: Set<string>,
  checkBudget?: () => void,
) {
  const rules = [...snapshot.rules].sort(
    (a, b) => timestamp(a.effectiveFrom) - timestamp(b.effectiveFrom),
  );
  for (const [index, rule] of rules.entries()) {
    checkBudget?.();
    validateRuleHeader(rule, snapshot.version);
    const at = timestamp(rule.effectiveFrom);
    const previous = rules[index - 1];
    if (previous && (previous.effectiveUntil === null || timestamp(previous.effectiveUntil) > at))
      throw new Error("certified_snapshot_rules_overlap");
    for (const refs of [rule.dispatch, rule.normalShop, rule.collaborationShop, ...rule.soloDays]) {
      checkBudget?.();
      validateRefs(refs, lawIds);
    }
    if (snapshot.version === "certified-daily-v3") validateRefs(rule.weeklyFixed ?? [], lawIds);
  }
}

function validateRound(round: CertifiedSoloRound, roundIds: Set<number>) {
  knownFields(round, "round startGameDate endGameDate status sourceIds");
  if (
    !Number.isSafeInteger(round.round) ||
    round.round < 1 ||
    roundIds.has(round.round) ||
    !["confirmed", "estimated", "unverified"].includes(round.status) ||
    !textList(round.sourceIds)
  )
    throw new Error("certified_snapshot_solo_round_invalid");
  roundIds.add(round.round);
  const start = dateStart(round.startGameDate);
  if (round.endGameDate !== null && dateStart(round.endGameDate) <= start)
    throw new Error("certified_snapshot_solo_duration_invalid");
  if (round.status === "unverified" && round.endGameDate !== null)
    throw new Error("certified_snapshot_unverified_duration_fabricated");
}

function validateEventIdentity(
  event: CertifiedSupplyEvent,
  ids: Set<string>,
  ruleIds: Set<string>,
  version: CertifiedSupplySnapshot["version"],
) {
  knownFields(
    event,
    "id gameDate at kind status refs ruleId round dayNumber expiresAt cancelled sourceIds",
  );
  if (
    !event ||
    ids.has(event.id) ||
    typeof event.id !== "string" ||
    !event.id ||
    !ruleIds.has(event.ruleId) ||
    ![
      "dispatch",
      "shop",
      "solo",
      ...(version === "certified-daily-v3" ? ["weekly-kits"] : []),
    ].includes(event.kind) ||
    !["confirmed", "estimated"].includes(event.status)
  )
    throw new Error("certified_snapshot_event_identity_invalid");
  ids.add(event.id);
}

function validateStableEventId(event: CertifiedSupplyEvent) {
  if (event.kind !== "solo") {
    if (event.id !== `${event.kind}:${event.gameDate}`)
      throw new Error("certified_snapshot_recurring_identity_invalid");
    return;
  }
  if (event.id !== `solo:r${event.round}:day${event.dayNumber}`)
    throw new Error("certified_snapshot_solo_identity_invalid");
  if (
    !Number.isSafeInteger(event.round) ||
    !Number.isSafeInteger(event.dayNumber) ||
    (event.round ?? 0) < 1 ||
    (event.dayNumber ?? 0) < 1
  )
    throw new Error("certified_snapshot_solo_number_invalid");
}

function validateEventDates(event: CertifiedSupplyEvent, snapshot: CertifiedSupplySnapshot) {
  const at = timestamp(event.at);
  if (
    at < timestamp(snapshot.coverage.from) ||
    at >= timestamp(snapshot.coverage.until) ||
    gameDayKey(at) !== event.gameDate
  )
    throw new Error("certified_snapshot_event_date_invalid");
  const activeRule = ruleAt(snapshot.rules, gameDayStartMs(at));
  if (!activeRule || activeRule.id !== event.ruleId)
    throw new Error("certified_snapshot_event_effective_rule_invalid");
}

function validateEventMetadata(event: CertifiedSupplyEvent) {
  if (event.cancelled !== undefined && typeof event.cancelled !== "boolean")
    throw new Error("certified_snapshot_event_cancelled_invalid");
  if (event.sourceIds !== undefined && !textList(event.sourceIds))
    throw new Error("certified_snapshot_event_sources_invalid");
  if (
    event.expiresAt !== undefined &&
    event.expiresAt !== null &&
    timestamp(event.expiresAt) <= timestamp(event.at)
  )
    throw new Error("certified_snapshot_event_expiry_invalid");
}

function validateEvents(
  snapshot: CertifiedSupplySnapshot,
  lawIds: Set<string>,
  ruleIds: Set<string>,
  checkBudget?: () => void,
) {
  const ids = new Set<string>();
  for (const event of snapshot.events) {
    checkBudget?.();
    validateEventIdentity(event, ids, ruleIds, snapshot.version);
    validateEventDates(event, snapshot);
    validateStableEventId(event);
    validateRefs(event.refs, lawIds);
    validateEventMetadata(event);
  }
}

export function validateSnapshot(
  value: unknown,
  checkBudget?: () => void,
): CertifiedSupplySnapshot {
  checkBudget?.();
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("certified_snapshot_object_required");
  const snapshot = value as CertifiedSupplySnapshot;
  validateCollections(snapshot);
  validateMetadata(snapshot);
  validateCoverage(snapshot);
  validateCadenceMean(snapshot.cadence);
  validateCadenceSummary(snapshot.cadence);
  validateDelay(snapshot);
  const lawIds = new Set(snapshot.laws.map((law) => law.id));
  const ruleIds = new Set(snapshot.rules.map((rule) => rule.id));
  if (lawIds.size !== snapshot.laws.length || ruleIds.size !== snapshot.rules.length)
    throw new Error("certified_snapshot_authority_identity_duplicate");
  for (const law of snapshot.laws) {
    checkBudget?.();
    validateLaw(law, snapshot.version === "certified-daily-v1" ? 3 : 4, checkBudget);
  }
  validateRules(snapshot, lawIds, checkBudget);
  const rounds = new Set<number>();
  for (const round of snapshot.soloRounds) {
    checkBudget?.();
    validateRound(round, rounds);
  }
  validateEvents(snapshot, lawIds, ruleIds, checkBudget);
  return snapshot;
}

function isV3WeeklyFixedRefs(refs: readonly CertifiedLawRef[] | undefined) {
  return (
    refs?.length === 1 && refs[0]?.lawId === CERTIFIED_WEEKLY_FIXED_LAW_ID && refs[0].count === 1
  );
}

function assertV3WeeklyEvent(event: CertifiedSupplyEvent): void {
  if (event.kind !== "weekly-kits") return;
  const at = timestamp(event.at);
  if (
    new Date(at + 9 * 3_600_000).getUTCDay() !== 3 ||
    at !== gameDayStartMs(at) ||
    event.status !== "confirmed" ||
    event.cancelled ||
    !isV3WeeklyFixedRefs(event.refs) ||
    !event.expiresAt ||
    timestamp(event.expiresAt) !== at + 6 * DAY_MS
  )
    throw new Error("certified_v3_weekly_event_invalid");
}

/** FRP-v3.1 runtime authority: fixture finite laws remain historical/testing contracts. */
export function assertV3RuntimeLaws(snapshot: CertifiedSupplySnapshot): void {
  if (
    snapshot.laws.length !== CERTIFIED_SUPPLY_LAWS.length ||
    !CERTIFIED_SUPPLY_LAWS.every((builtin) =>
      snapshot.laws.some(
        (law) =>
          law.id === builtin.id &&
          law.kind === builtin.kind &&
          law.modelVersion === builtin.modelVersion &&
          law.outcomes === undefined &&
          law.outcomesByCohort === undefined,
      ),
    )
  )
    throw new Error("certified_v3_builtin_laws_required");
  const allowed = new Set([
    ...CERTIFIED_SUPPLY_LAWS.map((law) => law.id),
    CERTIFIED_WEEKLY_FIXED_LAW_ID,
  ]);
  for (const rule of snapshot.rules) {
    if (!isV3WeeklyFixedRefs(rule.weeklyFixed)) throw new Error("certified_v3_weekly_rule_invalid");
    for (const ref of [
      rule.dispatch,
      rule.normalShop,
      rule.collaborationShop,
      rule.weeklyFixed ?? [],
      ...rule.soloDays,
    ].flat())
      if (!allowed.has(ref.lawId)) throw new Error("certified_v3_law_reference_invalid");
  }
  for (const event of snapshot.events) {
    if (event.refs.some((ref) => !allowed.has(ref.lawId)))
      throw new Error("certified_v3_law_reference_invalid");
    assertV3WeeklyEvent(event);
  }
  const weekly = new Set(
    snapshot.events.filter((event) => event.kind === "weekly-kits").map((event) => event.gameDate),
  );
  for (
    let at = timestamp(snapshot.coverage.from);
    at < timestamp(snapshot.coverage.until);
    at += DAY_MS
  ) {
    if (
      new Date(at + 9 * 3_600_000).getUTCDay() === 3 &&
      ruleAt(snapshot.rules, at) &&
      !weekly.has(gameDayKey(at))
    )
      throw new Error("certified_v3_weekly_event_missing");
  }
}
