import { buildForecastCandidate, resolveSoloSchedule } from "./candidate";
import {
  candidateExists,
  candidateIdExists,
  emptyCollectionSummary,
  loadScheduleEvents,
  naverCircuitState,
  nextForecastRevision,
  nextNaverRetryAt,
  persistCandidate,
  persistSourceItemsAndEvents,
  recordCollectorRun,
  shouldProbeX,
  supersedeEarlierCandidates,
} from "./db";
import { fetchNaverBoard, parseScheduleEvents } from "./naver";
import type {
  CollectionSummary,
  CollectorEnv,
  NormalizedSourceItem,
  ScheduleEvent,
  XProbeResult,
} from "./types";
import { probeOfficialX } from "./x-probe";

export async function runCollection(
  env: CollectorEnv,
  options: { nowMs?: number; forceX?: boolean } = {},
): Promise<CollectionSummary> {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const circuit = await naverCircuitState(env.FORECAST_DB, nowMs);
  if (circuit.open) {
    await recordCollectorRun(
      env.FORECAST_DB,
      "collector",
      "circuit_open",
      nowIso,
      "naver_circuit_open",
      circuit.nextRetryAt,
      0,
    );
    return emptyCollectionSummary("circuit_open");
  }

  let items: NormalizedSourceItem[] = [];
  let events: ScheduleEvent[] = [];
  try {
    const boards = await Promise.all([fetchNaverBoard(56), fetchNaverBoard(48)]);
    items = boards.flat();
    if (items.length === 0) throw new Error("naver_empty_relevant_feed");
    events = await parseScheduleEvents(items);
    await persistSourceItemsAndEvents(env.FORECAST_DB, items, events, nowIso);
    await recordCollectorRun(
      env.FORECAST_DB,
      "naver",
      "completed",
      nowIso,
      null,
      null,
      items.length,
    );
  } catch (error) {
    const errorCode = sanitizeErrorCode(error);
    const nextRetryAt = nextNaverRetryAt(nowMs, circuit.failures + 1);
    await recordCollectorRun(
      env.FORECAST_DB,
      "naver",
      "failure",
      nowIso,
      errorCode,
      nextRetryAt,
      0,
    );
    await recordCollectorRun(
      env.FORECAST_DB,
      "collector",
      "failure",
      nowIso,
      "naver_unavailable",
      nextRetryAt,
      0,
    );
    return emptyCollectionSummary("failure");
  }

  const ledger = await loadScheduleEvents(env.FORECAST_DB);
  if (hasUnresolvedScheduleChange(ledger)) {
    await recordCollectorRun(
      env.FORECAST_DB,
      "collector",
      "completed",
      nowIso,
      "manual_review_required",
      null,
      items.length,
    );
    return {
      outcome: "completed",
      naverItems: items.length,
      parsedEvents: events.length,
      candidates: 0,
      xStatus: "not_run",
    };
  }
  const resolved = resolveSoloSchedule(ledger, nowMs);
  if (!resolved) {
    await recordCollectorRun(
      env.FORECAST_DB,
      "collector",
      "completed",
      nowIso,
      "insufficient_schedule_history",
      null,
      items.length,
    );
    return {
      outcome: "completed",
      naverItems: items.length,
      parsedEvents: events.length,
      candidates: 0,
      xStatus: "not_run",
    };
  }
  if (resolved.scheduleStatus === "estimated") {
    await persistSourceItemsAndEvents(
      env.FORECAST_DB,
      [resolved.event.sourceItem],
      [resolved.event],
      nowIso,
    );
  }

  const gameDay = gameDayKey(nowMs);
  const knownCandidate = await Promise.all(
    (["crosschecked", "x_unavailable", "conflict"] as const).map((status) =>
      candidateExists(env.FORECAST_DB, resolved.event.eventId, gameDay, status),
    ),
  );
  const xDue =
    env.X_AUTOMATION_ENABLED === "true" &&
    (await shouldProbeX(
      env.FORECAST_DB,
      nowMs,
      options.forceX === true ||
        knownCandidate.every((value) => value === null) ||
        events.some((event) => nowMs - Date.parse(event.sourceItem.publishedAt) <= 6 * 60 * 1000),
    ));
  let xProbe: XProbeResult = {
    status: "x_unavailable",
    sourceItem: null,
    reason: "probe_not_due",
  };
  if (xDue) {
    const xStarted = new Date().toISOString();
    xProbe = await probeOfficialX(env, resolved.event, nowMs);
    if (xProbe.sourceItem) {
      await persistSourceItemsAndEvents(env.FORECAST_DB, [xProbe.sourceItem], [], nowIso);
    }
    await recordCollectorRun(
      env.FORECAST_DB,
      "x",
      xProbe.status === "x_unavailable" ? "failure" : "completed",
      xStarted,
      xProbe.reason,
      null,
      xProbe.sourceItem ? 1 : 0,
    );
  } else {
    const existingStatus = knownCandidate.findIndex((value) => value !== null);
    if (existingStatus >= 0) {
      await recordCollectorRun(
        env.FORECAST_DB,
        "collector",
        "completed",
        nowIso,
        null,
        null,
        items.length,
      );
      return {
        outcome: "completed",
        naverItems: items.length,
        parsedEvents: events.length,
        candidates: 0,
        xStatus: "not_run",
      };
    }
  }

  const revision = await nextForecastRevision(env.FORECAST_DB, gameDay);
  const collaborationEvents = ledger.filter((event) => event.eventType === "collaboration");
  const candidate = await buildForecastCandidate(
    resolved,
    collaborationEvents,
    xProbe,
    nowMs,
    revision,
  );
  if (await candidateIdExists(env.FORECAST_DB, candidate.candidate.candidateId)) {
    await recordCollectorRun(
      env.FORECAST_DB,
      "collector",
      "completed",
      nowIso,
      null,
      null,
      items.length,
    );
    return {
      outcome: "completed",
      naverItems: items.length,
      parsedEvents: events.length,
      candidates: 0,
      xStatus: xProbe.status,
    };
  }
  await persistCandidate(env.FORECAST_DB, candidate, resolved.event.eventId, gameDay, revision);
  await supersedeEarlierCandidates(
    env.FORECAST_DB,
    resolved.event.eventId,
    gameDay,
    candidate.candidate.candidateId,
  );
  await recordCollectorRun(
    env.FORECAST_DB,
    "collector",
    "completed",
    nowIso,
    null,
    null,
    items.length,
  );
  return {
    outcome: "completed",
    naverItems: items.length,
    parsedEvents: events.length,
    candidates: 1,
    xStatus: xProbe.status,
  };
}

function hasUnresolvedScheduleChange(events: readonly ScheduleEvent[]) {
  const changes = events.filter((event) => event.eventType === "schedule_change");
  const latestSolo = events
    .filter((event) => event.eventType === "solo")
    .toSorted(
      (left, right) =>
        Date.parse(right.sourceItem.publishedAt) - Date.parse(left.sourceItem.publishedAt),
    )[0];
  return changes.some(
    (event) =>
      event.manualReview &&
      (!latestSolo ||
        Date.parse(event.sourceItem.publishedAt) >= Date.parse(latestSolo.sourceItem.publishedAt)),
  );
}

function gameDayKey(nowMs: number) {
  return new Date(nowMs + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function sanitizeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown";
  return message.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}
