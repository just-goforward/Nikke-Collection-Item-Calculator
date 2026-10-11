import type { SupplyForecastCandidate } from "../shared/supplyForecastCandidate.ts";

export type XAdvisorySource =
  | "fxtwitter"
  | "x-api"
  | "profile-html"
  | "syndication"
  | "jina"
  | "embed"
  | "direct"
  | null;

export type XAdvisoryReason =
  | "author_identity_unverified"
  | "matched_schedule"
  | "schedule_conflict"
  | "schedule_not_verified"
  | "authentication_failed"
  | "invalid_response"
  | "timeout"
  | "rate_limited"
  | "login_wall"
  | "empty_timeline"
  | "navigation_error";

export type XAdvisoryResult = {
  status: "matching" | "conflict" | "unavailable";
  source: XAdvisorySource;
  reason: XAdvisoryReason;
  statusUrl: string | null;
  excerpt: string | null;
};

const EVENT_KEYWORDS = {
  solo: ["솔로 레이드", "솔로레이드", "솔레"],
  collaboration: ["콜라보레이션", "콜라보"],
  coop: ["협동 작전", "협동작전", "협작"],
  kit: ["관리 키트 상자", "키트 상자"],
} as const;
// Activation requires an authoritative public handle-to-numeric-ID source.
// Test fixtures and provider responses cannot establish this trust anchor.
const VERIFIED_NIKKE_AUTHOR_ID: string | null = null;
const FX_TIMELINE_URL = "https://api.fxtwitter.com/2/profile/NIKKE_kr/statuses?count=10";
const FX_STATUS_URL = "https://api.fxtwitter.com/2/status/";
const X_PROFILE_URL = "https://x.com/NIKKE_kr";
const X_RESPONSE_MAX_BYTES = 1024 * 1024;
const DETAIL_MAX_BYTES = 128 * 1024;
const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;

export async function probeXAdvisory(
  candidate: SupplyForecastCandidate,
  fetcher: typeof fetch = fetch,
): Promise<XAdvisoryResult> {
  return classifyXAdvisory(await fetchXAdvisoryPayload(fetcher), candidate, "fxtwitter");
}

export async function fetchXAdvisoryPayload(fetcher: typeof fetch = fetch): Promise<ProbePayload> {
  if (VERIFIED_NIKKE_AUTHOR_ID === null) {
    return { posts: [], reason: "author_identity_unverified" };
  }
  return fetchVerifiedFxPayload(VERIFIED_NIKKE_AUTHOR_ID, fetcher);
}

// Explicit injection keeps offline fixtures separate from the production trust gate.
export async function fetchVerifiedFxPayload(
  expectedAuthorId: string,
  fetcher: typeof fetch,
): Promise<ProbePayload> {
  if (!readDigits(expectedAuthorId)) return { posts: [], reason: "invalid_response" };
  const attempted = new Set<string>();
  const posts: ProbePost[] = [];
  let failure: ProbeFailureReason | null = null;
  let ids: string[] = [];
  try {
    const body = await fetchLimitedText(
      FX_TIMELINE_URL,
      fetcher,
      X_RESPONSE_MAX_BYTES,
      12_000,
      "application/json",
    );
    const timeline = parseFxTimeline(JSON.parse(body) as unknown, expectedAuthorId);
    ids = timeline.ids;
    failure = timeline.reason;
  } catch (error) {
    failure = classifyFetchError(error);
  }

  async function fetchDetails(discovered: string[]) {
    const selected = [...new Set(discovered)]
      .filter((id) => !attempted.has(id))
      .slice(0, 10 - attempted.size);
    for (const id of selected) attempted.add(id); // Reserve before dispatch; failures consume budget.
    const results = await Promise.all(
      selected.map((id) => fetchFxStatusPayload(id, expectedAuthorId, fetcher)),
    );
    for (const result of results) {
      posts.push(...result.posts);
      failure ??= result.reason;
    }
  }
  await fetchDetails(ids);
  if ((posts.length === 0 || failure !== null) && attempted.size < 10) {
    try {
      const body = await fetchLimitedText(
        X_PROFILE_URL,
        fetcher,
        X_RESPONSE_MAX_BYTES,
        12_000,
        "text/html,application/xhtml+xml",
      );
      // HTML supplies IDs only. Its body can never become schedule evidence.
      ids = extractProfileStatusIds(body);
      await fetchDetails(ids);
    } catch (error) {
      failure ??= classifyFetchError(error);
    }
  }
  return { posts: sortPosts(posts), reason: failure ?? (posts.length ? null : "empty_timeline") };
}

function parseFxTimeline(
  value: unknown,
  expectedAuthorId: string,
): { ids: string[]; reason: ProbeFailureReason | null } {
  if (
    !isRecord(value) ||
    value["code"] !== 200 ||
    !Array.isArray(value["results"]) ||
    value["results"].length > 10
  ) {
    return { ids: [], reason: "invalid_response" };
  }
  const ids: string[] = [];
  let reason: ProbeFailureReason | null = null;
  for (const item of value["results"]) {
    const id = isRecord(item) ? readDigits(item["id"]) : null;
    if (!id || !parseFxStatus(item, id, expectedAuthorId)) {
      reason = "invalid_response";
      continue;
    }
    ids.push(id);
  }
  return { ids, reason };
}

export function extractProfileStatusIds(body: string) {
  const ids = new Set<string>();
  for (const match of body.matchAll(/TimelineTimelineEntry:tweet-(\d{10,30})/g)) {
    const id = match[1];
    if (id && snowflakeTimestamp(id)) ids.add(id);
  }
  return [...ids].sort((left, right) => (BigInt(left) > BigInt(right) ? -1 : 1));
}

export async function fetchFxStatusPayload(
  id: string,
  expectedAuthorId: string,
  fetcher: typeof fetch,
): Promise<ProbePayload> {
  if (!/^\d{2,20}$/.test(id) || !readDigits(expectedAuthorId)) {
    return { posts: [], reason: "invalid_response" };
  }
  try {
    const body = await fetchLimitedText(
      `${FX_STATUS_URL}${id}`,
      fetcher,
      DETAIL_MAX_BYTES,
      8_000,
      "application/json",
    );
    const value: unknown = JSON.parse(body);
    const post =
      isRecord(value) && value["code"] === 200
        ? parseFxStatus(value["status"], id, expectedAuthorId)
        : null;
    return post ? { posts: [post], reason: null } : { posts: [], reason: "invalid_response" };
  } catch (error) {
    return { posts: [], reason: classifyFetchError(error) };
  }
}

export function parseFxStatus(
  value: unknown,
  expectedId: string,
  expectedAuthorId: string,
): ProbePost | null {
  if (!isRecord(value) || value["type"] !== "status") return null;
  const id = readDigits(value["id"]);
  const author = value["author"];
  const rawText = value["raw_text"];
  const text = isRecord(rawText) ? readString(rawText["text"], X_RESPONSE_MAX_BYTES) : null;
  const url = readString(value["url"], 512);
  const publishedAt = readFxCreationTime(value, id);
  if (
    !id ||
    !/^\d{2,20}$/.test(id) ||
    id !== expectedId ||
    !hasExpectedFxAuthor(author, expectedAuthorId) ||
    !text ||
    !normalize(text) ||
    !url ||
    normalizeNikStatusUrl(url) !== `https://x.com/NIKKE_kr/status/${id}` ||
    !publishedAt
  )
    return null;
  return { text: normalize(text), url: `https://x.com/NIKKE_kr/status/${id}`, publishedAt };
}

function hasExpectedFxAuthor(author: unknown, expectedAuthorId: string) {
  if (!readDigits(expectedAuthorId) || !isRecord(author)) return false;
  return (
    readDigits(author["id"]) === expectedAuthorId &&
    readString(author["screen_name"], 15)?.toLowerCase() === "nikke_kr"
  );
}

function readFxCreationTime(value: Record<string, unknown>, id: string | null) {
  const publishedAt = readTimestamp(value["created_at"]);
  const timestamp = value["created_timestamp"];
  if (
    !id ||
    !publishedAt ||
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    Math.floor(Date.parse(publishedAt) / 1_000) !== timestamp
  )
    return null;
  const snowflakeAt = snowflakeTimestamp(id);
  if (!snowflakeAt || Math.floor(Date.parse(snowflakeAt) / 1_000) !== timestamp) return null;
  return publishedAt;
}

class ProbeRequestError extends Error {
  constructor(readonly reason: ProbeFailureReason) {
    super(reason);
  }
}

async function fetchLimitedText(
  url: string,
  fetcher: typeof fetch,
  maxBytes: number,
  timeoutMs: number,
  accept: string,
) {
  const controller = new AbortController();
  let rejectTimeout: (reason: unknown) => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    const error = new DOMException("Whole response timed out", "TimeoutError");
    controller.abort(error);
    rejectTimeout(error);
  }, timeoutMs);
  const operation = async () => {
    const response = await fetcher(url, {
      headers: { accept, "user-agent": "Nikke-Collection-Item-Calculator/X-advisory" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ProbeRequestError(response.status === 429 ? "rate_limited" : "navigation_error");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new ProbeRequestError("invalid_response");
    }
    return readLimitedText(response, maxBytes, timeout);
  };
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedText(response: Response, maxBytes: number, timeout: Promise<never>) {
  if (!response.body) throw new ProbeRequestError("invalid_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new ProbeRequestError("invalid_response");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export function classifyXAdvisory(
  payload: ProbePayload,
  candidate: SupplyForecastCandidate,
  source: XAdvisorySource = null,
): XAdvisoryResult {
  const relevant = sortPosts(
    payload.posts.filter(
      (post) => eventKind(post.text) !== null && normalizeNikStatusUrl(post.url) !== null,
    ),
  );
  if (relevant.length === 0) {
    return unavailable(source, payload.reason ?? "empty_timeline");
  }
  const contemporaneous = relevant.filter((post) => isContemporaneous(post, candidate));
  const conflict = contemporaneous.find((post) => postConflictsWithCandidate(post, candidate));
  if (conflict) {
    return {
      status: "conflict",
      source,
      reason: "schedule_conflict",
      statusUrl: normalizeNikStatusUrl(conflict.url),
      excerpt: conflict.text.slice(0, 600),
    };
  }
  // Partial success cannot hide a failed request, even when another post matches.
  if (payload.reason !== null) {
    const manual = contemporaneous[0];
    return {
      ...unavailable(source, payload.reason),
      statusUrl: manual ? normalizeNikStatusUrl(manual.url) : null,
      excerpt: manual?.text.slice(0, 600) ?? null,
    };
  }
  const exact = contemporaneous.find((post) => postMatchesCandidate(post, candidate));
  if (exact) {
    return {
      status: "matching",
      source,
      reason: "matched_schedule",
      statusUrl: normalizeNikStatusUrl(exact.url),
      excerpt: exact.text.slice(0, 600),
    };
  }
  const manual = contemporaneous[0];
  return manual
    ? {
        status: "unavailable",
        source,
        reason: "schedule_not_verified",
        statusUrl: normalizeNikStatusUrl(manual.url),
        excerpt: manual.text.slice(0, 600),
      }
    : unavailable(source, "empty_timeline");
}

function eventKind(text: string): keyof typeof EVENT_KEYWORDS | null {
  for (const [kind, keywords] of Object.entries(EVENT_KEYWORDS)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      return kind as keyof typeof EVENT_KEYWORDS;
    }
  }
  return null;
}

function postMatchesCandidate(post: ProbePost, candidate: SupplyForecastCandidate) {
  const kind = eventKind(post.text);
  const stated = extractFirstMonthDay(post.text);
  return (
    kind !== null &&
    stated !== null &&
    expectedMonthDays(candidate, kind).some(
      (expected) => expected.month === stated.month && expected.day === stated.day,
    )
  );
}

function postConflictsWithCandidate(post: ProbePost, candidate: SupplyForecastCandidate) {
  const kind = eventKind(post.text);
  const stated = extractFirstMonthDay(post.text);
  if (kind === null || stated === null) return false;
  const expected = expectedMonthDays(candidate, kind);
  return (
    expected.length > 0 &&
    !expected.some((value) => value.month === stated.month && value.day === stated.day)
  );
}

function expectedMonthDays(candidate: SupplyForecastCandidate, kind: keyof typeof EVENT_KEYWORDS) {
  if (kind === "solo") return [kstMonthDay(candidate.schedule.soloStart)];
  if (kind === "collaboration") {
    return (candidate.schedule.collaborationPeriods ?? []).map((period) =>
      kstMonthDay(period.effectiveFrom),
    );
  }
  return [];
}

function kstMonthDay(value: string) {
  const kst = new Date(Date.parse(value) + 9 * 60 * 60 * 1000);
  return { month: kst.getUTCMonth() + 1, day: kst.getUTCDate() };
}

function unavailable(source: XAdvisorySource, reason: ProbeFailureReason): XAdvisoryResult {
  return { status: "unavailable", source, reason, statusUrl: null, excerpt: null };
}

function extractFirstMonthDay(text: string) {
  const match = text.match(/(?:^|\s)(\d{1,2})\s*(?:\/|\.|월\s*)(\d{1,2})(?:일)?/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { month, day } : null;
}

function isContemporaneous(post: ProbePost, candidate: SupplyForecastCandidate) {
  if (!post.publishedAt) return false;
  const publishedAt = Date.parse(post.publishedAt);
  const references = [
    candidate.generatedAt,
    ...candidate.sourceEvidence
      .filter((evidence) => evidence.source !== "x-nikke-kr")
      .map((evidence) => evidence.publishedAt),
  ]
    .map(Date.parse)
    .filter(Number.isFinite);
  if (!Number.isFinite(publishedAt) || references.length === 0) return false;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;
  return references.some((reference) => Math.abs(publishedAt - reference) <= sevenDaysMs);
}

export function normalizeNikStatusUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/NIKKE_kr\/status\/(\d+)\/?$/i);
    return url.protocol === "https:" &&
      (url.hostname === "x.com" || url.hostname === "twitter.com") &&
      match?.[1]
      ? `https://x.com/NIKKE_kr/status/${match[1]}`
      : null;
  } catch {
    return null;
  }
}

function snowflakeTimestamp(id: string) {
  if (!/^\d+$/.test(id)) return null;
  try {
    const timestamp = Number((BigInt(id) >> 22n) + X_SNOWFLAKE_EPOCH_MS);
    const earliest = Number(X_SNOWFLAKE_EPOCH_MS);
    const latest = Date.now() + 24 * 60 * 60 * 1_000;
    return timestamp >= earliest && timestamp <= latest ? new Date(timestamp).toISOString() : null;
  } catch {
    return null;
  }
}

function sortPosts(posts: ProbePost[]) {
  return [...posts].sort((left, right) => {
    const leftAt = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const rightAt = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    return rightAt - leftAt;
  });
}

function classifyFetchError(error: unknown): ProbeFailureReason {
  if (error instanceof ProbeRequestError) return error.reason;
  if (error instanceof SyntaxError) return "invalid_response";
  const message = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : "";
  return /timeout|abort/.test(message) ? "timeout" : "navigation_error";
}

function readDigits(value: unknown) {
  return typeof value === "string" && /^\d{1,30}$/.test(value) ? value : null;
}

function readString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function readTimestamp(value: unknown) {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export type ProbePost = { text: string; url: string | null; publishedAt: string | null };
export type ProbeFailureReason = Exclude<
  XAdvisoryReason,
  "matched_schedule" | "schedule_conflict" | "schedule_not_verified"
>;
export type ProbePayload = {
  posts: ProbePost[];
  reason: ProbeFailureReason | null;
};
