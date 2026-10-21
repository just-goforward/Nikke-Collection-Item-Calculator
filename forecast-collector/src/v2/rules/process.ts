import {
  type ForecastV2DecisionEvidence,
  kstLabel,
} from "../../../../shared/forecastV2Notifications";
import type { RulesPort } from "../ingest/rules-port";
import { judgeCollaboration } from "./collaboration";
import {
  type DecisionInput,
  decisionIdentity,
  hash,
  maintainDecisions,
  notification,
  refreshRevisionDecision,
  requestDecision,
} from "./decisions";
import { gameDay } from "./game-day";
import { previousGrantOccurrences, unlinkPreviousGrant } from "./grant-correction";
import { judgeGrant } from "./grant-judgment";
import type { ExistingWindow } from "./identity";
import { maintenanceDependents } from "./maintenance-dependents";
import { postDependencies } from "./post-dependencies";
import { collaborationOptions, maintenanceConflictOptions } from "./schedule-options";
import type { Notice } from "./schedules";
import { interruptionEvidence, judgeMaintenance, judgeSolo } from "./schedules";
import { soloIdentity, soloRound } from "./solo-identity";

export type RulesConfiguration = { environment: "staging" | "production" };
let configuration: RulesConfiguration | undefined;
/** Explicit binding configuration; never infer an environment from source content. */
export function configureRules(value: RulesConfiguration): void {
  configuration = value;
}
type Window = ExistingWindow & { kind: string; revision: number; provenance: string | null };
type Decision = (
  type: DecisionInput["type"],
  options: DecisionInput["options"],
  eventId?: string | null,
  extracted?: DecisionInput["extracted"],
  evidence?: ForecastV2DecisionEvidence,
) => Promise<string>;
type PostWork = {
  db: D1Database;
  input: Parameters<RulesPort["processPostVersion"]>[1];
  now: string;
  key: string;
  post: Notice;
  url: string;
  windows: { results: Window[] };
  maintenance: Window[];
  writes: D1PreparedStatement[];
  result: { calendarDirty: boolean; decisionRequests: number; grants: number };
  reportedKits: { gameDay: string; ii: number; box: number }[];
  decision: Decision;
};

export const processPostVersion: RulesPort["processPostVersion"] = async (db, input, clock) => {
  if (!configuration) throw new Error("rules_environment_not_configured");
  const now = new Date(clock).toISOString();
  await maintainDecisions(db, now);
  const key = `post_${await hash(`${input.monitorId}:${input.feedId}:${input.versionId}`)}`;
  const empty = { calendarDirty: false, decisionRequests: 0, grants: 0 };
  if (
    await db
      .prepare("SELECT 1 FROM forecast_v2_admin_commands WHERE idempotency_key=?")
      .bind(key)
      .first()
  )
    return empty;
  const row = await db
    .prepare(`SELECT v.*,(
    SELECT h.metadata_json FROM forecast_v2_search_hits h WHERE h.feed_id=v.feed_id
    AND h.updated_date=v.updated_date ORDER BY h.run_id LIMIT 1) metadata_json
    FROM forecast_v2_post_versions v WHERE version_id=? AND feed_id=?`)
    .bind(input.versionId, input.feedId)
    .first<{
      body_text: string;
      created_at: string;
      content_hash: string;
      metadata_json: string | null;
    }>();
  if (!row?.metadata_json) throw new Error("post_version_metadata_missing");
  const currentVersion = await db
    .prepare(`SELECT version_id FROM forecast_v2_post_versions
    WHERE feed_id=? ORDER BY julianday(updated_date) DESC,julianday(fetched_at) DESC,version_id DESC LIMIT 1`)
    .bind(input.feedId)
    .first<{ version_id: string }>();
  if (currentVersion?.version_id !== input.versionId) return empty;
  await db
    .prepare(`UPDATE forecast_v2_decision_requests SET status='stale'
    WHERE status='pending' AND (
      json_extract(payload_json,'$.sourceVersion')<>? OR
      (json_extract(payload_json,'$.sourceVersion') IS NULL AND json_extract(payload_json,'$.sourceHash')<>?))
    AND EXISTS(SELECT 1 FROM json_each(payload_json,'$.feedIds') WHERE CAST(value AS TEXT)=?)`)
    .bind(input.versionId, row.content_hash, input.feedId)
    .run();
  const metadata = JSON.parse(row.metadata_json) as { title: string };
  const post = { title: metadata.title, body: row.body_text, postedAt: row.created_at };
  const url = `https://game.naver.com/lounge/nikke/board/detail/${input.feedId}`;
  const windows = await postDependencies(db, input.feedId, post);
  const maintenance = windows.results.filter((event) => event.kind === "maintenance");
  const writes: D1PreparedStatement[] = [];
  const result = { ...empty };
  const reportedKits: { gameDay: string; ii: number; box: number }[] = [];
  const decision = async (
    type: DecisionInput["type"],
    options: DecisionInput["options"],
    eventId: string | null = null,
    extracted?: DecisionInput["extracted"],
    evidence?: ForecastV2DecisionEvidence,
  ) => {
    const id = await decisionIdentity(input.feedId, input.versionId, type);
    await requestDecision(
      db,
      {
        id,
        type,
        environment: configuration!.environment,
        eventId,
        sourceHash: row.content_hash,
        sourceVersion: input.versionId,
        feedIds: [Number(input.feedId)],
        title: post.title,
        url,
        options,
        suppressNotification: input.monitorId === "B" && type === "solo_review",
        ...(extracted ? { extracted } : {}),
        ...(evidence ? { evidence } : {}),
      },
      now,
    );
    result.decisionRequests++;
    return id;
  };
  const work: PostWork = {
    db,
    input,
    now,
    key,
    post,
    url,
    windows,
    maintenance,
    writes,
    result,
    reportedKits,
    decision,
  };
  if (["A", "B", "F"].includes(input.monitorId)) await processGrants(work);
  if (input.monitorId === "B") await reportInterruption(work);
  else if (["G", "C-open", "C-reopen", "E", "D"].includes(input.monitorId))
    await processSchedule(work);
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_admin_commands
    (command_id,idempotency_key,payload_hash,event_id,expected_revision,created_at)
    VALUES(?,?,?,NULL,0,?)`)
      .bind(key, key, row.content_hash, now),
  );
  await db.batch(writes);
  await refreshRevisionDecision(db, now);
  return result;
};

async function processGrants(work: PostWork) {
  const { db, input, now, post, maintenance, writes, result, reportedKits, decision } = work;
  const grant = judgeGrant(post, maintenance);
  if (grant.action !== "ignore") {
    const observation = `observation_${await hash(input.versionId)}`;
    writes.push(
      db
        .prepare(`INSERT INTO forecast_v2_grant_observations
        (observation_id,version_id,feed_id,ii_qty,box_qty,candidate_dates_json,date_basis,created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(
          observation,
          input.versionId,
          input.feedId,
          grant.ii,
          grant.box,
          JSON.stringify(
            grant.action === "decision"
              ? grant.candidates
              : grant.instant
                ? [grant.instant]
                : [{ date: grant.gameDay, instant: null }],
          ),
          grant.action === "grant" ? grant.basis : "in_post_datetime",
          now,
        ),
    );
    if (grant.action === "decision") {
      await decision(
        "grant_date",
        grant.candidates.map((candidate, i) => ({
          id: `date_${i}`,
          label: candidate.instant ?? candidate.date,
        })),
        null,
        undefined,
        {
          goal: "보상 지급일 확정",
          reason: grant.reason,
          postedAt: post.postedAt,
          confirmed: grantConfirmation(grant.ii, grant.box),
          noGuess: "공지에 지급 시각이 적혀 있지 않아 지급일만 후보로 모았습니다.",
          guessed: grant.candidates.map((candidate) =>
            describeCandidate(candidate.instant, candidate.date, candidate.basis),
          ),
          todo:
            grant.reason === "maintenance_missing" || grant.reason === "maintenance_multiple"
              ? // apply-grants applies whichever date is chosen: there is no automatic re-ask.
                "점검 일정이 확정되면 공지의 지급일을 다시 확인하고, 맞는 지급일이 아래 버튼에 있으면 골라 주세요. 없으면 운영자에게 알려 주세요."
              : grant.reason === "grant_date_precision"
                ? "공지에 적힌 지급 시각을 확인하고, 시각이 없으면 아래 버튼에서 맞는 지급일을 골라 주세요."
                : "아래 버튼에서 맞는 지급일을 골라 주세요. 후보에 없으면 공지의 지급일을 다시 확인해 주세요.",
        },
      );
    } else {
      reportedKits.push({ gameDay: grant.gameDay, ii: grant.ii, box: grant.box });
      const previous = await previousGrantOccurrences(db, input.feedId);
      const conflict = await db
        .prepare(`SELECT occurrence_id FROM forecast_v2_grant_heads
          WHERE grant_game_day=? AND (ii_qty<>? OR box_qty<>?) LIMIT 1`)
        .bind(grant.gameDay, grant.ii, grant.box)
        .first();
      if (conflict || previous.length > 1) {
        // apply-grants rejects every option when this feed has several prior
        // occurrences (grant_correction_target_ambiguous), so neither button applies.
        const ambiguous = previous.length > 1;
        await decision(
          "grant_quantity",
          [
            { id: "separate", label: "별도 지급" },
            { id: "correction", label: "정정" },
          ],
          null,
          undefined,
          {
            goal: "지급 수량 확인",
            postedAt: post.postedAt,
            confirmed: [
              `지급일 ${kstLabel(grant.instant ?? `${grant.gameDay}T00:00:00+09:00`)}`,
              `이번 공지 수량: 관리 키트 II ${grant.ii} · 상자 ${grant.box}`,
              ...(ambiguous ? [`이 공지의 이전 지급 기록: ${previous.length}건`] : []),
            ],
            noGuess: "수량 판단만 남아 있어 일정 추측은 없습니다.",
            ...(ambiguous
              ? { reason: "grant_quantity_ambiguous" }
              : {
                  reason: "grant_quantity",
                  blocked:
                    "달력에 같은 날 이미 다른 수량의 지급이 있어 별도 지급인지 정정인지 확인이 필요합니다.",
                  todo: "새로 더 지급된 것이면 [별도 지급], 기존 수량을 고치는 것이면 [정정]을 눌러 주세요.",
                }),
          },
        );
      } else {
        const occurrence = `grant_${grant.gameDay}_${grant.ii}_${grant.box}`;
        writes.push(
          db
            .prepare(`INSERT INTO forecast_v2_grant_revisions
            (occurrence_id,revision,grant_game_day,ii_qty,box_qty,created_at)
            VALUES(?,1,?,?,?,?) ON CONFLICT DO NOTHING`)
            .bind(occurrence, grant.gameDay, grant.ii, grant.box, now),
        );
        writes.push(
          db
            .prepare(`INSERT INTO forecast_v2_grant_heads VALUES(?,1,?,?,?)
            ON CONFLICT DO NOTHING`)
            .bind(occurrence, grant.gameDay, grant.ii, grant.box),
        );
        writes.push(
          db
            .prepare(`INSERT INTO forecast_v2_grant_links(link_id,occurrence_id,observation_id)
            VALUES(?,?,?) ON CONFLICT DO NOTHING`)
            .bind(`${observation}_${occurrence}`, occurrence, observation),
        );
        writes.push(...unlinkPreviousGrant(db, input.feedId, occurrence, previous));
        result.grants++;
        result.calendarDirty = true;
      }
    }
  }
}

async function reportInterruption(work: PostWork) {
  const { db, input, now, key, post, url, windows, maintenance, writes, reportedKits, decision } =
    work;
  const segments = interruptionEvidence(post, maintenance);
  const segment = segments.find((value) => value.startAt);
  const target = segment?.startAt
    ? windows.results.find(
        (event) =>
          event.kind === "solo" &&
          Date.parse(event.startAt) <= Date.parse(segment.startAt!) &&
          Date.parse(event.endAt) >= Date.parse(segment.startAt!),
      )
    : undefined;
  const startAt = segment?.kind === "suspend" ? target?.startAt : segment?.startAt;
  const endAt = segment?.kind === "suspend" ? segment.startAt : segment?.endAt;
  const complete = startAt && endAt ? Date.parse(endAt) > Date.parse(startAt) : false;
  const kinds = [...new Set(segments.map((value) => value.kind))];
  const evidence: ForecastV2DecisionEvidence = {
    goal: "중단·재개 공지를 반영해 솔로 레이드 일정 확정",
    reason: complete ? "b_evidence_only" : "solo_period_unresolved",
    postedAt: post.postedAt,
    confirmed: [
      ...(kinds.length ? [`감지한 구간: ${kinds.map((kind) => SEGMENT_KO[kind]).join(", ")}`] : []),
      ...(target ? [`기존 솔로 레이드 일정과 겹치는 구간 확인`] : []),
      ...reportedKits.map(
        (kit) =>
          `${kstLabel(`${kit.gameDay}T00:00:00+09:00`).slice(0, 8)} 관리 키트 II ${kit.ii} · 상자 ${kit.box}`,
      ),
    ],
    guessed: segments
      .filter((value) => !(value.kind === "suspend" && !value.endAt))
      .map((value) => `${SEGMENT_KO[value.kind]} ${segmentRange(value.startAt, value.endAt)}`),
    ...(startAt && endAt ? { guess: { startAt, endAt } } : {}),
    todo: complete
      ? "추출한 구간이 맞으면 [이 일정으로 확정], 다르면 [일정 수정]으로 직접 입력, 근거가 무관하면 [관련 없음]."
      : "공지의 중단·재개 시각을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 무관하면 [관련 없음].",
    ...(complete
      ? {}
      : { blocked: "중단·재개 문구는 근거일 뿐이라 시작·종료를 확정하지 못했습니다." }),
  };
  const id = await decision(
    "solo_review",
    [],
    target?.id ?? null,
    {
      segments,
      ...(startAt ? { startAt } : {}),
      ...(endAt ? { endAt } : {}),
      kits: reportedKits,
    },
    evidence,
  );
  writes.push(
    await notification(
      db,
      `${key}_report`,
      "b_report",
      {
        feedId: Number(input.feedId),
        title: post.title,
        url,
        postedAt: post.postedAt,
        extracted: { segments, kits: reportedKits },
        // Exactly the span apply uses and the stored decision's todo, so the B report
        // and the decision request can never disagree about what is confirmable.
        decision: {
          complete,
          ...(startAt ? { startAt } : {}),
          ...(endAt ? { endAt } : {}),
          ...(evidence.todo ? { todo: evidence.todo } : {}),
        },
        decisionRequestId: id,
      },
      now,
      { decisionId: id },
    ),
  );
}

async function processSchedule(work: PostWork) {
  const { input, post, windows, maintenance, decision } = work;
  const kind =
    input.monitorId === "G" ? "maintenance" : input.monitorId === "D" ? "collaboration" : "solo";
  let judged =
    kind === "maintenance"
      ? judgeMaintenance(post)
      : kind === "solo"
        ? judgeSolo(post, maintenance)
        : judgeCollaboration(
            post,
            maintenance,
            windows.results.filter((event) => event.kind === "collaboration"),
          );
  const identity =
    kind === "solo" && judged.action === "confirmed"
      ? soloIdentity(
          soloRound(post.title, post.body, input.feedId),
          input.feedId,
          judged.startAt,
          windows.results.filter((event) => event.kind === "solo"),
        )
      : null;
  const eventId = identity?.eventId ?? `${kind}_${input.feedId}`;
  if (kind === "maintenance" && judged.action === "confirmed") {
    const source = judged;
    const calendarDate = (instant: string) =>
      new Date(Date.parse(instant) + 9 * 3_600_000).toISOString().slice(0, 10);
    const conflicts = maintenance.filter(
      (event) =>
        event.id !== eventId && calendarDate(event.startAt) === calendarDate(source.startAt),
    );
    if (conflicts.length) {
      await decision(
        "maintenance",
        [
          ...maintenanceConflictOptions(source, conflicts),
          { id: "ignore", label: "기존 점검 유지" },
        ],
        conflicts.length === 1 ? conflicts[0]!.id : null,
        { startAt: source.startAt, endAt: source.endAt },
        {
          goal: "점검 일정 확정",
          reason: "maintenance_conflict",
          postedAt: post.postedAt,
          confirmed: [
            `이 공지의 점검: ${kstLabel(source.startAt)} ~ ${kstLabel(source.endAt)}`,
            ...conflicts.map(
              (event) => `달력의 기존 점검: ${kstLabel(event.startAt)} ~ ${kstLabel(event.endAt)}`,
            ),
          ],
          noGuess: "이 공지의 점검 시간은 읽었지만 달력에 어느 점검을 남길지는 결정이 필요합니다.",
          blocked:
            "같은 날짜에 이미 달력에 점검 일정이 있어 이 공지의 시간으로 바꿀지 기존 점검을 유지할지 확인이 필요합니다.",
          todo: "이 공지의 시간을 적용하려면 해당 항목을, 기존 일정을 유지하려면 [기존 점검 유지]를 눌러 주세요.",
        },
      );
      judged = { action: "ignore" };
    }
  }
  if (judged.action === "decision") {
    // Overlapping collaboration candidates are existing windows: show them, don't list ids.
    const overlaps =
      kind === "collaboration" && judged.reason === "collaboration_overlap"
        ? (judged as { candidates?: string[] }).candidates
            ?.map((candidate) => windows.results.find((event) => event.id === candidate))
            .filter((event): event is Window => event !== undefined)
        : undefined;
    await requestScheduleDecision(work, kind, eventId, judged, overlaps);
  }
  if (judged.action === "confirmed" || judged.action === "create") {
    await storeSchedule(work, kind, judged, eventId, identity);
  }
}

async function requestScheduleDecision(
  work: PostWork,
  kind: "solo" | "maintenance" | "collaboration",
  eventId: string,
  judged?: { action: "decision"; reason: string; startAt?: string; endAt?: string },
  overlaps?: readonly { startAt: string; endAt: string }[],
) {
  const { post, maintenance, decision } = work;
  const source = kind === "collaboration" ? judgeCollaboration(post, maintenance, []) : null;
  const partial: { reason: string; startAt?: string; endAt?: string } | null =
    judged ?? (source?.action === "decision" ? source : null);
  const reason =
    judged?.reason ??
    (kind === "maintenance"
      ? "maintenance_period_missing"
      : kind === "solo"
        ? "solo_period_unresolved"
        : (partial?.reason ?? "collaboration_start_unresolved"));
  const extracted =
    source?.action === "create" ? { startAt: source.startAt, endAt: source.endAt } : undefined;
  // A partial judge result (e.g. start parsed, maintenance end unknown) stays evidence only
  // and is never marked complete, so no confirmation button appears.
  const partialSpan =
    kind !== "collaboration" && (partial?.startAt || partial?.endAt)
      ? {
          ...(partial.startAt ? { startAt: partial.startAt } : {}),
          ...(partial.endAt ? { endAt: partial.endAt } : {}),
        }
      : undefined;
  const ordered =
    partialSpan?.startAt && partialSpan.endAt
      ? Date.parse(partialSpan.endAt) > Date.parse(partialSpan.startAt)
      : false;
  const guess =
    ordered && partialSpan?.startAt && partialSpan.endAt
      ? { startAt: partialSpan.startAt, endAt: partialSpan.endAt }
      : undefined;
  const optionLabels =
    kind === "collaboration" && !extracted
      ? // Only candidate starts read from this notice are guesses; calendar windows are not.
        collaborationOptions(post, maintenance).map((option) =>
          [option.startAt, option.endAt]
            .filter((value): value is string => value !== undefined)
            .map(kstLabel)
            .join(" ~ "),
        )
      : undefined;
  await decision(
    kind === "solo" ? "solo_review" : kind,
    kind === "solo"
      ? []
      : extracted
        ? [
            { id: "new", label: "새 콜라보" },
            { id: "same", label: "기존 콜라보" },
            { id: "ignore", label: "관련 없음" },
          ]
        : [
            ...(kind === "collaboration" ? collaborationOptions(post, maintenance) : []),
            { id: "ignore", label: "관련 없음" },
          ],
    eventId,
    // Extracted schedules keep their existing meaning (complete schedule only);
    // partial judge output is carried as evidence, never as a confirmable span.
    extracted,
    {
      ...scheduleEvidence(kind, post, partial, reason, guess, partialSpan, optionLabels, {
        ...(extracted ? { noticeWindow: extracted } : {}),
        overlapWindows: overlaps ?? [],
      }),
      ...(extracted
        ? {
            todo: "새 콜라보 일정이면 [새 콜라보], 기존 콜라보와 같은 일정이면 [기존 콜라보], 기간이 다르면 [일정 수정]으로 직접 입력, 반영할 필요가 없으면 [관련 없음]을 눌러 주세요.",
          }
        : {}),
    },
  );
}

function scheduleEvidence(
  kind: "solo" | "maintenance" | "collaboration",
  post: Notice,
  judged: { reason: string; startAt?: string; endAt?: string } | null,
  reason: string,
  guess: { startAt: string; endAt: string } | undefined,
  partialSpan: { startAt?: string; endAt?: string } | undefined,
  optionLabels?: readonly string[],
  collaboration?: {
    noticeWindow?: { startAt: string; endAt: string };
    overlapWindows: readonly { startAt: string; endAt: string }[];
  },
): ForecastV2DecisionEvidence {
  const text = `${post.title}\n${post.body}`;
  const keywords = KEYWORDS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  const round = /솔로\s*레이드(?:\s*재오픈)?\s*시즌\s*(\d+)/.exec(text)?.[1];
  const goal =
    kind === "solo"
      ? "솔로 레이드 일정 확정"
      : kind === "maintenance"
        ? "점검 일정 확정"
        : "콜라보 일정 확정";
  // maintenance_missing/_multiple keep the table's blocked line, so the endpoint the
  // notice did give us belongs in 확인한 것 instead of overriding the reason.
  const endsOnly = reason.startsWith("maintenance_") && !guess;
  const endOnly = endsOnly && partialSpan?.endAt ? partialSpan.endAt : undefined;
  const window = (value: { startAt: string; endAt: string }) =>
    `${kstLabel(value.startAt)} ~ ${kstLabel(value.endAt)}`;
  const confirmed = [
    `감지한 키워드: ${keywords.length ? keywords.join(", ") : "없음"}`,
    ...(round ? [`공지에 적힌 시즌: ${round}시즌`] : []),
    ...(judged?.startAt ? [`공지에서 읽은 시작: ${kstLabel(judged.startAt)}`] : []),
    ...(judged?.endAt ? [`공지에서 읽은 종료: ${kstLabel(judged.endAt)}`] : []),
    ...(endOnly ? [`종료(${kstLabel(endOnly)})는 읽음`] : []),
    // Labelled facts, never presented as guesses: this notice's own period, and the
    // existing calendar windows it collides with.
    ...(collaboration?.noticeWindow
      ? [`이번 공지의 콜라보 기간: ${window(collaboration.noticeWindow)}`]
      : []),
    ...(collaboration?.overlapWindows ?? []).map(
      (overlap) => `달력의 기존 콜라보: ${window(overlap)}`,
    ),
  ];
  const partialText =
    !guess && !endOnly && partialSpan?.startAt && partialSpan.endAt
      ? `${kstLabel(partialSpan.startAt)} ~ ${kstLabel(partialSpan.endAt)}`
      : undefined;
  return {
    goal,
    reason,
    postedAt: post.postedAt,
    confirmed,
    guessed: guess
      ? [`${kstLabel(guess.startAt)} ~ ${kstLabel(guess.endAt)}`]
      : partialText
        ? [partialText]
        : // Candidate windows the approver can pick are listed, never denied. Only
          // windows read from this notice are candidates; existing calendar windows
          // are confirmed facts above, not guesses.
          (optionLabels?.length ?? 0) > 0
          ? [...(optionLabels ?? [])]
          : collaboration?.noticeWindow
            ? [window(collaboration.noticeWindow)]
            : [],
    ...(guess ? { guess } : {}),
    // A partial span is the important nuance: the reason line alone would hide it.
    ...(endsOnly
      ? {}
      : partialSpan?.startAt && !partialSpan.endAt
        ? {
            blocked: `시작(${kstLabel(partialSpan.startAt)})은 읽었지만 종료 시각을 확인하지 못했습니다.`,
          }
        : partialSpan?.endAt && !partialSpan.startAt
          ? {
              blocked: `종료(${kstLabel(partialSpan.endAt)})는 읽었지만 시작 시각을 확인하지 못했습니다.`,
            }
          : {}),
  };
}

const KEYWORDS: [RegExp, string][] = [
  [/솔로\s*레이드/, "솔로 레이드"],
  [/콜라보/, "콜라보"],
  [/점검/, "점검"],
  [/아카이브/, "아카이브"],
  [/진행\s*기간/, "진행 기간"],
  [/점검\s*완료\s*후/, "점검 완료 후"],
  [/재오픈/, "재오픈"],
  [/중단/, "중단"],
  [/관리\s*키트/, "관리 키트"],
];

const SEGMENT_KO = {
  suspend: "중단",
  resume: "재개",
  extend: "연장",
  reopen: "재오픈",
  close: "종료",
} as const;

function segmentRange(startAt: string | undefined, endAt: string | undefined) {
  return startAt && endAt
    ? `${kstLabel(startAt)} ~ ${kstLabel(endAt)}`
    : startAt
      ? `${kstLabel(startAt)} ~ 미확정`
      : endAt
        ? `미확정 ~ ${kstLabel(endAt)}`
        : "시각 미확정";
}

function grantConfirmation(ii: number, box: number) {
  return [`공지에서 읽은 수량: 관리 키트 II ${ii} · 상자 ${box}`];
}

/** Grant date-basis codes are internal; approvers only see their meaning. */
const GRANT_BASIS: Record<string, string> = {
  explicit_payment: "공지에 지급일 명시",
  in_post_datetime: "공지 본문의 일시",
  maintenance_end: "점검 종료 시각",
  post_created: "게시 시각",
};

function describeCandidate(instant: string | null, date: string, basis: string) {
  const basisText = GRANT_BASIS[basis];
  const label = instant ? kstLabel(instant) : kstLabel(`${date}T00:00:00+09:00`);
  const detail = instant ? basisText : ["시각 미확인", basisText].filter(Boolean).join(", ");
  return detail ? `${label} (${detail})` : label;
}

async function storeSchedule(
  work: PostWork,
  kind: "maintenance" | "collaboration" | "solo",
  judged: { startAt: string; endAt: string; maintenanceEventId?: string },
  eventId: string,
  identity: ReturnType<typeof soloIdentity> | null,
) {
  const { db, input, now, windows, maintenance, writes, result } = work;
  const previous = windows.results.find((event) => event.id === eventId);
  const revision = (previous?.revision ?? 0) + 1;
  const start = new Date(judged.startAt).toISOString(),
    end = new Date(judged.endAt).toISOString();
  const dependencyId = judged.maintenanceEventId ?? null;
  const dependencyRevision = dependencyId
    ? maintenance.find((event) => event.id === dependencyId)?.revision
    : null;
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions
        (event_id,revision,kind,status,starts_at,ends_at,start_game_day,end_game_day,source_feed_ids_json,created_at,prediction_provenance_json,maintenance_event_id,maintenance_revision)
        VALUES(?,?,?,'confirmed',?,?,?,?,?,?,?,?,?)`)
      .bind(
        eventId,
        revision,
        kind,
        start,
        end,
        gameDay(start),
        gameDay(end),
        JSON.stringify([Number(input.feedId)]),
        now,
        JSON.stringify(identity ? { round: identity.round, segment: identity.segment } : {}),
        dependencyId,
        dependencyRevision ?? null,
      ),
  );
  writes.push(
    db
      .prepare(`INSERT INTO forecast_v2_calendar_heads VALUES(?,?)
        ON CONFLICT(event_id) DO UPDATE SET revision=excluded.revision`)
      .bind(eventId, revision),
  );
  if (kind === "maintenance" && previous && previous.endAt !== end)
    writes.push(
      ...(await maintenanceDependents(
        db,
        eventId,
        revision,
        previous.endAt,
        end,
        now,
        configuration!.environment,
      )),
    );
  result.calendarDirty = true;
}
