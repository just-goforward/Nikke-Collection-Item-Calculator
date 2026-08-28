import type { SupplyForecastCandidate } from "../shared/supplyForecastCandidate.ts";

export type XAdvisorySource =
  | "x-api"
  | "profile-html"
  | "syndication"
  | "jina"
  | "embed"
  | "direct"
  | null;

export type XAdvisoryReason =
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
const X_API_RECENT_SEARCH_URL = "https://api.x.com/2/tweets/search/recent";
const X_API_QUERY =
  '("솔로 레이드" OR 솔로레이드 OR 솔레 OR 콜라보 OR "협동 작전" OR 협동작전 OR 협작 OR "관리 키트 상자") from:NIKKE_kr -is:retweet';
const X_PROFILE_URL = "https://x.com/NIKKE_kr";
const X_TWEET_RESULT_URL = "https://cdn.syndication.twimg.com/tweet-result";
const SYNDICATION_URL = "https://syndication.twitter.com/srv/timeline-profile/screen-name/NIKKE_kr";
const JINA_READER_URL = "https://r.jina.ai/https://x.com/NIKKE_kr";
const X_RESPONSE_MAX_BYTES = 1024 * 1024;
const JINA_MAX_BYTES = 128 * 1024;
const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;

export async function probeXAdvisory(candidate: SupplyForecastCandidate): Promise<XAdvisoryResult> {
  const bearerToken = process.env["X_API_BEARER_TOKEN"]?.trim();
  let apiFailure: XAdvisoryResult | null = null;
  if (bearerToken) {
    const apiDecision = classifyXAdvisory(await fetchXApiPayload(bearerToken), candidate, "x-api");
    if (apiDecision.status !== "unavailable" || apiDecision.statusUrl) return apiDecision;
    apiFailure = apiDecision;
  }

  const profileDecision = classifyXAdvisory(await fetchProfilePayload(), candidate, "profile-html");
  if (profileDecision.status !== "unavailable" || profileDecision.statusUrl) {
    return profileDecision;
  }

  const syndicationDecision = classifyXAdvisory(
    await fetchSyndicationPayload(),
    candidate,
    "syndication",
  );
  if (syndicationDecision.status !== "unavailable" || syndicationDecision.statusUrl) {
    return syndicationDecision;
  }

  const jinaDecision = classifyXAdvisory(await fetchJinaPayload(), candidate, "jina");
  if (jinaDecision.status !== "unavailable" || jinaDecision.statusUrl) return jinaDecision;
  if (apiFailure) return apiFailure;
  if (profileDecision.reason !== "empty_timeline") return profileDecision;
  return syndicationDecision.reason !== "empty_timeline" ? syndicationDecision : jinaDecision;
}

export async function fetchXApiPayload(
  bearerToken: string,
  fetcher: typeof fetch = fetch,
): Promise<ProbePayload> {
  const url = new URL(X_API_RECENT_SEARCH_URL);
  url.searchParams.set("query", X_API_QUERY);
  url.searchParams.set("max_results", "10");
  url.searchParams.set("tweet.fields", "author_id,created_at");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username");

  try {
    const response = await fetcher(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${bearerToken}`,
      },
      signal: AbortSignal.timeout(12_000),
    });
    const body = await readLimitedText(response, X_RESPONSE_MAX_BYTES);
    if (response.status === 401 || response.status === 403) {
      return { posts: [], reason: "authentication_failed" };
    }
    if (response.status === 429) return { posts: [], reason: "rate_limited" };
    if (!response.ok) return { posts: [], reason: "navigation_error" };
    return parseXApiPayload(JSON.parse(body) as unknown);
  } catch (error) {
    return { posts: [], reason: classifyFetchError(error) };
  }
}

export function parseXApiPayload(value: unknown): ProbePayload {
  if (!isRecord(value)) return { posts: [], reason: "invalid_response" };
  const data = value["data"];
  if (data === undefined) return { posts: [], reason: "empty_timeline" };
  if (!Array.isArray(data) || data.length > 100) {
    return { posts: [], reason: "invalid_response" };
  }

  const officialAuthorIds = readOfficialAuthorIds(value["includes"]);
  if (!officialAuthorIds) return { posts: [], reason: "invalid_response" };

  const posts: ProbePost[] = [];
  for (const item of data) {
    const post = parseOfficialXApiPost(item, officialAuthorIds);
    if (!post) return { posts: [], reason: "invalid_response" };
    posts.push(post);
  }
  return { posts: sortPosts(posts), reason: posts.length === 0 ? "empty_timeline" : null };
}

export async function fetchProfilePayload(fetcher: typeof fetch = fetch): Promise<ProbePayload> {
  try {
    const response = await fetcher(X_PROFILE_URL, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36",
      },
      signal: AbortSignal.timeout(12_000),
    });
    const body = await readLimitedText(response, X_RESPONSE_MAX_BYTES);
    if (response.status === 429) return { posts: [], reason: "rate_limited" };
    if (!response.ok) return { posts: [], reason: "navigation_error" };
    const ids = extractProfileStatusIds(body).slice(0, 10);
    if (ids.length === 0) return { posts: [], reason: "empty_timeline" };

    const results = await Promise.all(ids.map((id) => fetchTweetResultPayload(id, fetcher)));
    const posts = sortPosts(results.flatMap((result) => result.posts));
    const failure = results.find((result) => result.reason && result.reason !== "empty_timeline");
    return { posts, reason: posts.length === 0 ? (failure?.reason ?? "empty_timeline") : null };
  } catch (error) {
    return { posts: [], reason: classifyFetchError(error) };
  }
}

export function extractProfileStatusIds(body: string) {
  const ids = new Set<string>();
  for (const match of body.matchAll(/TimelineTimelineEntry:tweet-(\d{10,30})/g)) {
    const id = match[1];
    if (id && snowflakeTimestamp(id)) ids.add(id);
  }
  return [...ids].sort((left, right) => (BigInt(left) > BigInt(right) ? -1 : 1));
}

export async function fetchTweetResultPayload(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<ProbePayload> {
  if (!readDigits(id)) return { posts: [], reason: "invalid_response" };
  const url = new URL(X_TWEET_RESULT_URL);
  url.searchParams.set("id", id);
  url.searchParams.set("token", "0");
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    const body = await readLimitedText(response, JINA_MAX_BYTES);
    if (response.status === 429) return { posts: [], reason: "rate_limited" };
    if (!response.ok) return { posts: [], reason: "navigation_error" };
    const post = parseTweetResult(JSON.parse(body) as unknown, id);
    return post ? { posts: [post], reason: null } : { posts: [], reason: "invalid_response" };
  } catch (error) {
    return { posts: [], reason: classifyFetchError(error) };
  }
}

export function parseTweetResult(value: unknown, expectedId: string): ProbePost | null {
  if (!isRecord(value)) return null;
  const id = readDigits(value["id_str"]);
  const text = readString(value["text"], 4_000);
  const user = value["user"];
  const username = isRecord(user) ? readString(user["screen_name"], 15) : null;
  if (id !== expectedId || !text || username?.toLowerCase() !== "nikke_kr") return null;
  const publishedAt = readTimestamp(value["created_at"]) ?? snowflakeTimestamp(id);
  return publishedAt
    ? {
        text: normalize(text).slice(0, 600),
        url: `https://x.com/NIKKE_kr/status/${id}`,
        publishedAt,
      }
    : null;
}

export async function fetchSyndicationPayload(
  fetcher: typeof fetch = fetch,
): Promise<ProbePayload> {
  try {
    const response = await fetcher(SYNDICATION_URL, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147 Safari/537.36",
      },
      signal: AbortSignal.timeout(12_000),
    });
    const body = await readLimitedText(response, X_RESPONSE_MAX_BYTES);
    if (response.status === 429) return { posts: [], reason: "rate_limited" };
    if (!response.ok) return { posts: [], reason: "navigation_error" };
    return parseSyndicationPayload(body);
  } catch (error) {
    return { posts: [], reason: classifyFetchError(error) };
  }
}

export function parseSyndicationPayload(body: string): ProbePayload {
  const entries = readSyndicationEntries(body);
  if (!entries) return { posts: [], reason: "invalid_response" };

  const posts: ProbePost[] = [];
  for (const entry of entries) {
    const post = parseSyndicationEntry(entry);
    if (post) posts.push(post);
  }
  return {
    posts: sortPosts(posts).slice(0, 100),
    reason: posts.length === 0 ? "empty_timeline" : null,
  };
}

function readOfficialAuthorIds(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value["users"])) return null;
  const officialAuthorIds = new Set<string>();
  for (const user of value["users"]) {
    if (!isRecord(user)) continue;
    const id = readDigits(user["id"]);
    const username = readString(user["username"], 15);
    if (id && username?.toLowerCase() === "nikke_kr") officialAuthorIds.add(id);
  }
  return officialAuthorIds.size > 0 ? officialAuthorIds : null;
}

function parseOfficialXApiPost(value: unknown, officialAuthorIds: ReadonlySet<string>) {
  if (!isRecord(value)) return null;
  const id = readDigits(value["id"]);
  const authorId = readDigits(value["author_id"]);
  const text = readString(value["text"], 4_000);
  if (!id || !authorId || !officialAuthorIds.has(authorId) || !text) return null;
  const publishedAt = readTimestamp(value["created_at"]) ?? snowflakeTimestamp(id);
  return publishedAt
    ? {
        text: normalize(text).slice(0, 600),
        url: `https://x.com/NIKKE_kr/status/${id}`,
        publishedAt,
      }
    : null;
}

function readSyndicationEntries(body: string) {
  const match = body.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const props = parsed["props"];
  const pageProps = isRecord(props) ? props["pageProps"] : undefined;
  const timeline = isRecord(pageProps) ? pageProps["timeline"] : undefined;
  const entries = isRecord(timeline) ? timeline["entries"] : undefined;
  return Array.isArray(entries) && entries.length <= 500 ? entries : null;
}

function parseSyndicationEntry(value: unknown) {
  if (!isRecord(value) || value["type"] !== "tweet") return null;
  const content = value["content"];
  const tweet = isRecord(content) ? content["tweet"] : undefined;
  if (!isRecord(tweet)) return null;
  const user = tweet["user"];
  const username = isRecord(user) ? readString(user["screen_name"], 15) : null;
  if (username?.toLowerCase() !== "nikke_kr") return null;
  const id = readDigits(tweet["id_str"]);
  const text = readString(tweet["full_text"], 4_000) ?? readString(tweet["text"], 4_000);
  if (!id || !text) return null;
  const publishedAt = readTimestamp(tweet["created_at"]) ?? snowflakeTimestamp(id);
  return publishedAt
    ? {
        text: normalize(text).slice(0, 600),
        url: `https://x.com/NIKKE_kr/status/${id}`,
        publishedAt,
      }
    : null;
}

export async function fetchJinaPayload(fetcher: typeof fetch = fetch): Promise<ProbePayload> {
  try {
    const response = await fetcher(JINA_READER_URL, {
      headers: { accept: "text/plain", "x-cache-tolerance": "300" },
      signal: AbortSignal.timeout(12_000),
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > JINA_MAX_BYTES) {
      return { posts: [], reason: "navigation_error" };
    }
    const body = await readLimitedText(response, JINA_MAX_BYTES);
    if (response.status === 429 || /abusealleviation|rate limit|too many requests/i.test(body)) {
      return { posts: [], reason: "rate_limited" };
    }
    if (!response.ok) return { posts: [], reason: "navigation_error" };
    return parseJinaPayload(body);
  } catch (error) {
    return { posts: [], reason: classifyFetchError(error) };
  }
}

export function parseJinaPayload(body: string): ProbePayload {
  const matches = [...body.matchAll(/https:\/\/(?:x\.com|twitter\.com)\/NIKKE_kr\/status\/(\d+)/g)];
  const posts = matches.slice(0, 30).map((match, index) => {
    const id = match[1] ?? "";
    const url = `https://x.com/NIKKE_kr/status/${id}`;
    const at = match.index ?? 0;
    const previousEnd = index === 0 ? 0 : (matches[index - 1]?.index ?? 0) + 1;
    const nextStart = matches[index + 1]?.index ?? body.length;
    return {
      text: normalize(
        body.slice(Math.max(previousEnd, at - 600), Math.min(nextStart, at + 1_200)),
      ).slice(0, 600),
      url,
      publishedAt: snowflakeTimestamp(id),
    };
  });
  return { posts, reason: posts.length === 0 ? "empty_timeline" : null };
}

async function readLimitedText(response: Response, maxBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("x_response_too_large");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
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
  const conflict =
    source === "jina"
      ? undefined
      : contemporaneous.find((post) => postConflictsWithCandidate(post, candidate));
  if (conflict) {
    return {
      status: "conflict",
      source,
      reason: "schedule_conflict",
      statusUrl: normalizeNikStatusUrl(conflict.url),
      excerpt: conflict.text.slice(0, 600),
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
