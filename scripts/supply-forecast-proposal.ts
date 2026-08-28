import type {
  SupplyForecastCandidate,
  SupplyForecastCandidateEnvelope,
} from "../shared/supplyForecastCandidate.ts";
import type { XAdvisoryResult } from "./forecast-x-advisory.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const GAME_DAY_SHIFT_MS = 4 * 60 * 60 * 1000;
const X_PROFILE_URL = "https://x.com/NIKKE_kr";
const REVIEW_METADATA_PREFIX = "forecast-review-v1:";

export type ForecastReviewMetadata = {
  version: 1;
  candidateId: string;
  forecastId: string;
  x: {
    status: XAdvisoryResult["status"];
    source: XAdvisoryResult["source"];
    reason: XAdvisoryResult["reason"];
    statusUrl: string | null;
  };
  schedule: {
    status: SupplyForecastCandidate["schedule"]["status"];
    soloStart: string;
    soloEnd: string;
    collaborationPeriods: Array<{ effectiveFrom: string; effectiveUntil: string }>;
  };
};

type ProposalRegistry = {
  activeForecastId: string;
  forecasts: Array<{
    id: string;
    profiles: Array<{
      expectedGain: { blue: number; purple: number; yellow: number };
    }>;
  }>;
};

export function renderSupplyForecastProposal(
  envelope: SupplyForecastCandidateEnvelope,
  xAdvisory: XAdvisoryResult,
  registry: ProposalRegistry,
) {
  const candidate = envelope.candidate;
  const active = registry.forecasts.find((forecast) => forecast.id === registry.activeForecastId);
  const activeGain = active?.profiles[0]?.expectedGain;
  const candidateGain = candidate.profiles[0]?.expectedGain;
  const xChecklist = renderXChecklist(xAdvisory);
  const evidence = candidate.sourceEvidence
    .map((source) => `- [${source.source}](${source.url}): ${source.excerpt}`)
    .join("\n");
  const profileRows = candidate.profiles
    .map((profile) => renderProfileRow(profile, candidate.schedule))
    .join("\n");
  const collaborationSummary =
    candidate.schedule.collaborationPeriods.length === 0
      ? "없음"
      : candidate.schedule.collaborationPeriods
          .map(
            (period) => `${formatKst(period.effectiveFrom)} - ${formatKst(period.effectiveUntil)}`,
          )
          .join("<br>");
  const reviewMetadata = encodeForecastReviewMetadata(
    createForecastReviewMetadata(candidate, xAdvisory),
  );

  return (
    `## Forecast approval\n\n` +
    `이 PR은 후보를 **approved지만 inactive** 상태로 등록합니다. 제품의 \`activeForecastId\`는 H/p 연구와 별도 adoption PR이 통과할 때까지 변경하지 않습니다.\n\n` +
    `### 일정 한눈에 보기\n\n` +
    `| 표시 | 확인 대상 | 일정·보상 |\n|---|---|---|\n` +
    `| 🟥 | 솔로 레이드 (${statusLabel(candidate.schedule.status)}) | ${formatKst(candidate.schedule.soloStart)} - ${formatKst(candidate.schedule.soloEnd)} |\n` +
    `| 🟪 | 콜라보 기간 | ${collaborationSummary} |\n` +
    `| 🟨 | 협동작전 주간 보상 | 매주 화요일 05:00 KST · 상자 II ×5, 콜라보 기간에는 ×10 |\n\n` +
    `- Candidate: \`${candidate.candidateId}\`\n` +
    `- Payload SHA-256: \`${envelope.payloadHash}\`\n` +
    `- Naver source status: \`${candidate.sourceStatus}\`\n` +
    `- X advisory: \`${xAdvisory.status}\` (\`${xAdvisory.reason}\`)\n` +
    `- X advisory source: \`${xAdvisory.source ?? "none"}\`\n` +
    `- Solo periods: \`${candidate.schedule.soloPeriods.length}\` (confirmed/estimated ledger)\n` +
    `- Confirmed collaboration periods: \`${candidate.schedule.collaborationPeriods.length}\`\n` +
    `- New-round cadence: \`${candidate.schedule.cadenceDays ?? "not derivable"}\` day(s)\n` +
    `- Rules: \`${candidate.rulesVersion}\`, \`${candidate.dispatchPolicyId}\`\n` +
    `- Active first-profile gain: \`${formatGain(activeGain)}\`\n` +
    `- Candidate first-profile gain: \`${formatGain(candidateGain)}\`\n\n` +
    `### 수동 확인\n\n` +
    `${xChecklist}\n- [ ] 일정, 05:00 KST 경계, 솔로 레이드 3일차 기준 구간 전환을 확인했습니다.\n- [ ] 1·2일차 누적 구간과 3일차 이후 전방 구간의 gain을 확인했습니다.\n- [ ] 매주 화요일 05:00의 기본 상자 II 5개와, 공개된 콜라보 기간 안 화요일의 10개 배율을 확인했습니다.\n\n` +
    `### Sources\n\n${evidence}\n\n` +
    `### Profiles\n\n` +
    `표시는 해당 KST 게임 일자(05:00부터 다음날 04:59까지)에 적용되는 일정과 보상을 뜻합니다.\n\n` +
    `| 게임 일자 (05:00 KST) | 이벤트 / 보상 | 일정 | Blue | Purple | Yellow |\n` +
    `|---|---|---|---:|---:|---:|\n${profileRows}\n\n` +
    `### Warnings\n\n${candidate.warnings.map((warning) => `- ${warning}`).join("\n") || "- None"}\n\n` +
    `<!-- ${REVIEW_METADATA_PREFIX}${reviewMetadata} -->\n`
  );
}

export function parseForecastReviewMetadata(body: string): ForecastReviewMetadata {
  const match = body.match(/<!-- forecast-review-v1:([A-Za-z0-9_-]+) -->/);
  if (!match?.[1]) throw new Error("Forecast review metadata is missing from the PR body.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Forecast review metadata is invalid.");
  }
  if (!isRecord(parsed) || parsed["version"] !== 1) {
    throw new Error("Forecast review metadata version is invalid.");
  }
  const candidateId = stringMatching(parsed["candidateId"], /^forecast-[a-z0-9-]{8,120}$/);
  const forecastId = stringMatching(parsed["forecastId"], /^supply-\d{4}-\d{2}-\d{2}-v\d+$/);
  if (!candidateId || !forecastId) {
    throw new Error("Forecast review metadata fields are invalid.");
  }
  return {
    version: 1,
    candidateId,
    forecastId,
    x: parseXReviewMetadata(parsed["x"]),
    schedule: parseScheduleReviewMetadata(parsed["schedule"]),
  };
}

function parseXReviewMetadata(value: unknown): ForecastReviewMetadata["x"] {
  if (!isRecord(value)) throw new Error("Forecast X review metadata is invalid.");
  const status = oneOf(value["status"], ["matching", "conflict", "unavailable"] as const);
  const source =
    value["source"] === null ? null : oneOf(value["source"], ["embed", "direct", "jina"] as const);
  const reason = oneOf(value["reason"], [
    "matched_schedule",
    "schedule_conflict",
    "timeout",
    "rate_limited",
    "login_wall",
    "empty_timeline",
    "navigation_error",
  ] as const);
  const statusUrl = value["statusUrl"] === null ? null : readXStatusUrl(value["statusUrl"]);
  if (!status || source === undefined || !reason || statusUrl === undefined) {
    throw new Error("Forecast X review metadata is invalid.");
  }
  return { status, source, reason, statusUrl };
}

function parseScheduleReviewMetadata(value: unknown): ForecastReviewMetadata["schedule"] {
  if (!isRecord(value)) throw new Error("Forecast schedule review metadata is invalid.");
  const status = oneOf(value["status"], ["confirmed", "estimated"] as const);
  const soloStart = readTimestamp(value["soloStart"]);
  const soloEnd = readTimestamp(value["soloEnd"]);
  if (!status || !soloStart || !soloEnd || Date.parse(soloEnd) <= Date.parse(soloStart)) {
    throw new Error("Forecast Solo Raid period is invalid.");
  }
  return {
    status,
    soloStart,
    soloEnd,
    collaborationPeriods: parseCollaborationPeriods(value["collaborationPeriods"]),
  };
}

function parseCollaborationPeriods(value: unknown) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("Forecast collaboration periods are invalid.");
  }
  return value.map((period) => {
    if (!isRecord(period)) throw new Error("Forecast collaboration period is invalid.");
    const effectiveFrom = readTimestamp(period["effectiveFrom"]);
    const effectiveUntil = readTimestamp(period["effectiveUntil"]);
    if (
      !effectiveFrom ||
      !effectiveUntil ||
      Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)
    ) {
      throw new Error("Forecast collaboration period is invalid.");
    }
    return { effectiveFrom, effectiveUntil };
  });
}

export function formatForecastReviewForDiscord(metadata: ForecastReviewMetadata) {
  const xLink = metadata.x.statusUrl ?? X_PROFILE_URL;
  const xLabel = metadata.x.statusUrl ? "X 게시물" : "X @NIKKE_kr 공개 프로필";
  const collaboration =
    metadata.schedule.collaborationPeriods.length === 0
      ? "없음"
      : metadata.schedule.collaborationPeriods
          .map(
            (period) => `${formatKst(period.effectiveFrom)} - ${formatKst(period.effectiveUntil)}`,
          )
          .join(" / ");
  return {
    xLink,
    content:
      `🔎 **X 일정 확인**\n` +
      `- [${xLabel}](${xLink})\n` +
      `- 솔로 레이드: ${formatKst(metadata.schedule.soloStart)} - ${formatKst(metadata.schedule.soloEnd)} (${statusLabel(metadata.schedule.status)})\n` +
      `- 콜라보: ${collaboration}\n` +
      `- 확인할 내용: X 공지의 일정이 위 기간과 일치하는지 확인`,
  };
}

function renderProfileRow(
  profile: SupplyForecastCandidate["profiles"][number],
  schedule: SupplyForecastCandidate["schedule"],
) {
  const markers = profileMarkers(profile.effectiveFrom, profile.effectiveUntil, schedule);
  return `| ${formatGameDate(profile.effectiveFrom)} | ${markers.join("<br>")} | ${statusLabel(profile.scheduleStatus)} | ${profile.expectedGain.blue.toFixed(6)} | ${profile.expectedGain.purple.toFixed(6)} | ${profile.expectedGain.yellow.toFixed(6)} |`;
}

function profileMarkers(
  effectiveFrom: string,
  effectiveUntil: string | null,
  schedule: SupplyForecastCandidate["schedule"],
) {
  const start = Date.parse(effectiveFrom);
  const end = effectiveUntil ? Date.parse(effectiveUntil) : start + DAY_MS;
  const markers: string[] = [];
  const soloPeriod = schedule.soloPeriods.find(
    (period) => start < Date.parse(period.effectiveUntil) && end > Date.parse(period.effectiveFrom),
  );
  if (soloPeriod) {
    const firstGameDay = gameDayBoundary(Date.parse(soloPeriod.effectiveFrom));
    const day = Math.floor((start - firstGameDay) / DAY_MS) + 1;
    markers.push(`🟥 솔로 ${day}일차${day === 3 ? " · 전방 구간 전환" : ""}`);
  }
  const collaborationActive = schedule.collaborationPeriods.some(
    (period) => start < Date.parse(period.effectiveUntil) && end > Date.parse(period.effectiveFrom),
  );
  if (collaborationActive) markers.push("🟪 콜라보");
  if (isTuesdayGameBoundary(start)) {
    const doubled = schedule.collaborationPeriods.some(
      (period) =>
        start >= Date.parse(period.effectiveFrom) && start < Date.parse(period.effectiveUntil),
    );
    markers.push(`🟨 화 05:00 · 상자 II ×${doubled ? 10 : 5}`);
  }
  return markers.length > 0 ? markers : ["⬜ 일반"];
}

function createForecastReviewMetadata(
  candidate: SupplyForecastCandidate,
  xAdvisory: XAdvisoryResult,
): ForecastReviewMetadata {
  return {
    version: 1,
    candidateId: candidate.candidateId,
    forecastId: candidate.forecastId,
    x: {
      status: xAdvisory.status,
      source: xAdvisory.source,
      reason: xAdvisory.reason,
      statusUrl: xAdvisory.statusUrl,
    },
    schedule: {
      status: candidate.schedule.status,
      soloStart: candidate.schedule.soloStart,
      soloEnd: candidate.schedule.soloEnd,
      collaborationPeriods: candidate.schedule.collaborationPeriods,
    },
  };
}

function encodeForecastReviewMetadata(metadata: ForecastReviewMetadata) {
  return Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
}

function renderXChecklist(result: XAdvisoryResult) {
  if (result.status === "matching") {
    const link = result.statusUrl ? ` ([status](${result.statusUrl}))` : "";
    if (result.source === "jina") {
      return `- [ ] Jina Reader가 일정과 일치하는 X status를 찾았습니다. 관리자가 X 원문을 확인해야 합니다.${link}`;
    }
    return `- [x] X \`@NIKKE_kr\` 공개 게시물과 일정이 일치했습니다.${link}`;
  }
  if (result.status === "conflict") {
    const link = result.statusUrl ? ` ([status](${result.statusUrl}))` : "";
    return `- [ ] X 공개 게시물과 Naver 일정이 충돌합니다. 관리자 검토가 필요합니다.${link}`;
  }
  return `- [ ] X \`@NIKKE_kr\` 공개 게시물을 관리자가 수동 확인했습니다. 자동 확인 사유: \`${result.reason}\``;
}

function formatGain(gain: { blue: number; purple: number; yellow: number } | undefined) {
  return gain
    ? `${gain.blue.toFixed(6)} / ${gain.purple.toFixed(6)} / ${gain.yellow.toFixed(6)}`
    : "n/a";
}

function formatKst(value: string) {
  const shifted = new Date(Date.parse(value) + KST_OFFSET_MS);
  return `${shifted.toISOString().slice(0, 10)} ${shifted.toISOString().slice(11, 16)} KST`;
}

function formatGameDate(value: string) {
  const shifted = new Date(Date.parse(value) + KST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

function gameDayBoundary(timestamp: number) {
  return Math.floor((timestamp + GAME_DAY_SHIFT_MS) / DAY_MS) * DAY_MS - GAME_DAY_SHIFT_MS;
}

function isTuesdayGameBoundary(timestamp: number) {
  const shifted = new Date(timestamp + KST_OFFSET_MS);
  return shifted.getUTCDay() === 2 && shifted.getUTCHours() === 5;
}

function statusLabel(status: "confirmed" | "estimated") {
  return status === "confirmed" ? "확정" : "예상";
}

function readTimestamp(value: unknown) {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return value;
}

function readXStatusUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 200) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "x.com" || url.hostname === "twitter.com") &&
      /^\/NIKKE_kr\/status\/\d+$/.test(url.pathname) &&
      url.search === "" &&
      url.hash === ""
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function stringMatching(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | undefined {
  return typeof value === "string" && values.includes(value) ? (value as T[number]) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
