import type { Browser, Page } from "@playwright/test";
import type { SupplyForecastCandidate } from "../shared/supplyForecastCandidate.ts";

export type XAdvisoryResult = {
  status: "matching" | "conflict" | "unavailable";
  source: "embed" | "direct" | "jina" | null;
  reason:
    | "matched_schedule"
    | "schedule_conflict"
    | "timeout"
    | "rate_limited"
    | "login_wall"
    | "empty_timeline"
    | "navigation_error";
  statusUrl: string | null;
  excerpt: string | null;
};

const SOLO_KEYWORDS = ["솔로 레이드", "솔로레이드", "솔레"];
const JINA_READER_URL = "https://r.jina.ai/https://x.com/NIKKE_kr";
const JINA_MAX_BYTES = 128 * 1024;

export async function probeXAdvisory(candidate: SupplyForecastCandidate): Promise<XAdvisoryResult> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const embedded = await probeEmbedded(browser);
    const embeddedDecision = classifyXAdvisory(embedded, candidate, "embed");
    if (embeddedDecision.status !== "unavailable") return embeddedDecision;
    const direct = await probeDirect(browser);
    const directDecision = classifyXAdvisory(direct, candidate, "direct");
    if (directDecision.status !== "unavailable") return directDecision;
  } finally {
    await browser.close();
  }
  return classifyXAdvisory(await fetchJinaPayload(), candidate, "jina");
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
    const message = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : "";
    return {
      posts: [],
      reason: /timeout|abort/.test(message) ? "timeout" : "navigation_error",
    };
  }
}

export function parseJinaPayload(body: string): ProbePayload {
  const matches = [...body.matchAll(/https:\/\/(?:x\.com|twitter\.com)\/NIKKE_kr\/status\/\d+/g)];
  const posts = matches.slice(0, 30).map((match, index) => {
    const url = match[0];
    const at = match.index ?? 0;
    const previousEnd = index === 0 ? 0 : (matches[index - 1]?.index ?? 0) + 1;
    const nextStart = matches[index + 1]?.index ?? body.length;
    return {
      text: normalize(
        body.slice(Math.max(previousEnd, at - 600), Math.min(nextStart, at + 1_200)),
      ).slice(0, 600),
      url,
      // A transformed/cached response cannot establish when X published the post.
      publishedAt: null,
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
      throw new Error("jina_response_too_large");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

async function probeEmbedded(browser: Browser) {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<a class="twitter-timeline" href="https://twitter.com/NIKKE_kr">NIKKE</a>` +
        `<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`,
      { waitUntil: "domcontentloaded", timeout: 8_000 },
    );
    await page.waitForTimeout(8_000);
    return collectPosts(page);
  } catch (error) {
    return { posts: [], reason: classifyBrowserError(error) };
  } finally {
    await page.close();
  }
}

async function probeDirect(browser: Browser) {
  const page = await browser.newPage();
  try {
    await page.goto("https://x.com/NIKKE_kr", {
      waitUntil: "domcontentloaded",
      timeout: 8_000,
    });
    await page.waitForTimeout(2_000);
    return collectPosts(page);
  } catch (error) {
    return { posts: [], reason: classifyBrowserError(error) };
  } finally {
    await page.close();
  }
}

async function collectPosts(page: Page): Promise<ProbePayload> {
  const frames = page.frames();
  const posts: ProbePost[] = [];
  let combined = "";
  for (const frame of frames) {
    const text = await frame
      .locator("body")
      .innerText({ timeout: 1_000 })
      .catch(() => "");
    combined += `\n${text}`;
    const rows = await frame
      .locator("article")
      .evaluateAll((nodes) =>
        nodes.slice(0, 30).map((node) => {
          const anchor = [...node.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')][0];
          return {
            text: node.textContent ?? "",
            href: anchor?.href ?? null,
            publishedAt: node.querySelector("time")?.getAttribute("datetime") ?? null,
          };
        }),
      )
      .catch(() => [] as Array<{ text: string; href: string | null; publishedAt: string | null }>);
    for (const row of rows) {
      posts.push({
        text: normalize(row.text).slice(0, 600),
        url: row.href,
        publishedAt: row.publishedAt,
      });
    }
  }
  const normalized = normalize(combined).toLowerCase();
  if (normalized.includes("rate limit exceeded")) return { posts: [], reason: "rate_limited" };
  if (normalized.includes("log in") || normalized.includes("로그인")) {
    return { posts: [], reason: "login_wall" };
  }
  return { posts: posts.slice(0, 30), reason: posts.length === 0 ? "empty_timeline" : null };
}

export function classifyXAdvisory(
  payload: ProbePayload,
  candidate: SupplyForecastCandidate,
  source: XAdvisoryResult["source"] = null,
): XAdvisoryResult {
  const relevant = payload.posts.filter((post) =>
    SOLO_KEYWORDS.some((keyword) => post.text.includes(keyword)),
  );
  if (relevant.length === 0) {
    return {
      status: "unavailable",
      source,
      reason: payload.reason ?? "empty_timeline",
      statusUrl: null,
      excerpt: null,
    };
  }
  const start = new Date(candidate.schedule.soloStart);
  const kst = new Date(start.getTime() + 9 * 60 * 60 * 1000);
  const month = kst.getUTCMonth() + 1;
  const day = kst.getUTCDate();
  const match = relevant.find((post) => {
    const statedStart = extractFirstMonthDay(post.text);
    return statedStart?.month === month && statedStart.day === day;
  });
  if (match) {
    return {
      status: "matching",
      source,
      reason: "matched_schedule",
      statusUrl: allowStatusUrl(match.url),
      excerpt: match.text.slice(0, 600),
    };
  }
  const conflict = relevant.find(
    (post) => extractFirstMonthDay(post.text) !== null && isContemporaneous(post, candidate),
  );
  return conflict
    ? {
        status: "conflict",
        source,
        reason: "schedule_conflict",
        statusUrl: allowStatusUrl(conflict.url),
        excerpt: conflict.text.slice(0, 600),
      }
    : {
        status: "unavailable",
        source,
        reason: "empty_timeline",
        statusUrl: null,
        excerpt: null,
      };
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

function allowStatusUrl(value: string | null) {
  if (!value) return null;
  const url = URL.parse(value);
  return url && url.protocol === "https:" && ["x.com", "twitter.com"].includes(url.hostname)
    ? url.toString()
    : null;
}

function classifyBrowserError(
  error: unknown,
): Exclude<XAdvisoryResult["reason"], "matched_schedule" | "schedule_conflict"> {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("timeout") ? "timeout" : "navigation_error";
}

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export type ProbePost = { text: string; url: string | null; publishedAt: string | null };
export type ProbePayload = {
  posts: ProbePost[];
  reason: Exclude<XAdvisoryResult["reason"], "matched_schedule" | "schedule_conflict"> | null;
};
