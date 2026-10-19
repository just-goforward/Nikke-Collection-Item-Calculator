import { assertForecastCandidateInvariants } from "../../shared/supplyForecastCandidate";
import { board11InvocationGate } from "./board11-policy";
import { isConstructedNoticeCandidate } from "./constructed-candidate";
import { sha256Hex, stableJson } from "./crypto";
import {
  candidateStatements,
  nextForecastRevision,
  sourceItemAndEventStatements,
  unapprovedCandidateCondition,
} from "./db";
import {
  parseSourceQueueProcess,
  type SourceQueueProcessResult,
  validateSourceQueueResult,
} from "./source-queue-validation";
import type { CandidateBuildResult, NormalizedSourceItem, ScheduleEvent } from "./types";

type QueueHooks = {
  validate(result: SourceQueueProcessResult): Promise<void>;
  statements(result: SourceQueueProcessResult, nowIso: string): Promise<D1PreparedStatement[]>;
};

export async function processSourceQueue(
  db: D1Database,
  raw: unknown,
  transaction: { before?: D1PreparedStatement[]; after?: D1PreparedStatement[] } = {},
  board11Allowed = board11InvocationGate(db),
  queue?: QueueHooks,
) {
  const request = parseSourceQueueProcess(raw);
  if (request.mode === "queue" && !queue) throw new Error("legacy_queue_disabled");
  if (
    request.results.some((result) => result.source === "naver-board-11") &&
    !(await board11Allowed())
  )
    throw new Error("board11_schema_required");
  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const result of request.results) {
    await validateSourceQueueResult(result);
    if (request.mode === "queue") await queue?.validate(result);
    if (result.item)
      statements.push(
        ...sourceItemAndEventStatements(
          db,
          [result.item as NormalizedSourceItem],
          result.events ?? (result.event ? [result.event as ScheduleEvent] : []),
          nowIso,
        ),
      );
    if (request.mode === "queue")
      statements.push(...((await queue?.statements(result, nowIso)) ?? []));
  }
  await appendCandidate(db, request, statements, nowIso);
  statements.unshift(...(transaction.before ?? []));
  statements.push(...(transaction.after ?? []));
  if (statements.length > 0) await db.batch(statements);
  return { processed: request.results.length, candidateCreated: Boolean(request.candidate) };
}

async function appendCandidate(
  db: D1Database,
  request: ReturnType<typeof parseSourceQueueProcess>,
  statements: D1PreparedStatement[],
  nowIso: string,
) {
  if (request.candidate) {
    const expectedRevision = await nextForecastRevision(db, request.candidate.gameDay);
    if (expectedRevision !== request.candidate.revision)
      throw new Error("candidate_revision_conflict");
    const { envelope, eventId, gameDay, revision } = request.candidate;
    const constructed = isConstructedNoticeCandidate(request.candidate);
    if (!constructed) assertForecastCandidateInvariants(envelope.candidate);
    if (!envelope.candidate.forecastId.startsWith(`supply-${gameDay}-v`))
      throw new Error("candidate_game_day_mismatch");
    for (const evidence of envelope.candidate.sourceEvidence) {
      const url = new URL(evidence.url);
      const allowedHosts =
        evidence.source === "x-nikke-kr" ? ["x.com", "twitter.com"] : ["game.naver.com"];
      if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname))
        throw new Error("candidate_source_url_allowlist");
    }
    if (!constructed && (await sha256Hex(stableJson(envelope.candidate))) !== envelope.payloadHash)
      throw new Error("candidate_payload_hash");
    const eventKnown =
      request.results.some(
        (entry) =>
          entry.event?.eventId === eventId ||
          entry.events?.some((event) => event.eventId === eventId),
      ) ||
      (await db
        .prepare("SELECT event_id FROM schedule_events WHERE event_id = ?")
        .bind(eventId)
        .first());
    if (!eventKnown) throw new Error("candidate_schedule_event_missing");
    statements.push(
      ...candidateStatements(
        db,
        envelope as CandidateBuildResult,
        eventId,
        gameDay,
        revision,
        nowIso,
      ),
    );
    const unapproved = await unapprovedCandidateCondition(db);
    statements.push(
      db
        .prepare(
          `UPDATE forecast_candidates SET state = 'superseded', updated_at = ?
           WHERE schedule_event_id = ? AND game_day = ? AND candidate_id <> ?
             AND state IN ('crosschecked', 'x_unavailable', 'conflict', 'proposed')
             AND (${unapproved})`,
        )
        .bind(nowIso, eventId, gameDay, envelope.candidate.candidateId),
    );
  }
}
