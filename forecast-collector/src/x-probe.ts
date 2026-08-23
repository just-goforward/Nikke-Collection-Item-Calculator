import { launch } from "@cloudflare/playwright";
import { sha256Hex } from "./crypto";
import { parseKoreanDateRange } from "./naver";
import type { CollectorEnv, NormalizedSourceItem, ScheduleEvent, XProbeResult } from "./types";

const X_PROFILE_URL = "https://x.com/NIKKE_kr";
const PROBE_TIMEOUT_MS = 8_000;

export type PublicXPost = { text: string; href: string; publishedAt: string };

export async function probeOfficialX(
  env: CollectorEnv,
  targetEvent: ScheduleEvent,
  nowMs: number,
): Promise<XProbeResult> {
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    browser = await launch(env.BROWSER, {
      keep_alive: 60_000,
      guardrails: { allowedDomains: ["x.com", "*.x.com", "*.twimg.com"] },
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(PROBE_TIMEOUT_MS);
    await page.goto(X_PROFILE_URL, { waitUntil: "domcontentloaded", timeout: PROBE_TIMEOUT_MS });
    const articles = page.locator("article");
    const count = Math.min(await articles.count(), 30);
    const relevant: PublicXPost[] = [];
    for (let index = 0; index < count; index += 1) {
      const article = articles.nth(index);
      const text = (await article.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!/(솔로\s*레이드|솔레|협동\s*작전|협작|콜라보|관리\s*키트\s*상자)/.test(text)) {
        continue;
      }
      const href =
        (await article
          .locator('a[href*="/status/"]')
          .first()
          .getAttribute("href")
          .catch(() => null)) ?? "";
      const dateTime =
        (await article
          .locator("time")
          .first()
          .getAttribute("datetime")
          .catch(() => null)) ?? new Date(nowMs).toISOString();
      if (href)
        relevant.push({
          text,
          href: new URL(href, X_PROFILE_URL).toString(),
          publishedAt: dateTime,
        });
    }
    return classifyOfficialXPosts(relevant, targetEvent);
  } catch (error) {
    return {
      status: "x_unavailable",
      sourceItem: null,
      reason: error instanceof Error ? `browser_probe:${error.name}` : "browser_probe_failed",
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function classifyOfficialXPosts(
  posts: readonly PublicXPost[],
  targetEvent: ScheduleEvent,
): Promise<XProbeResult> {
  if (posts.length === 0) {
    return { status: "x_unavailable", sourceItem: null, reason: "no_readable_public_posts" };
  }
  const targetStart = targetEvent.startsAt;
  const sameKind = posts.filter((post) => sameEventKind(post.text, targetEvent.eventType));
  const matching = sameKind.find((post) => {
    if (!targetStart) return false;
    const range = parseKoreanDateRange(post.text, post.publishedAt);
    return range?.start === targetStart;
  });
  if (matching) {
    return { status: "crosschecked", sourceItem: await toSourceItem(matching), reason: null };
  }
  const conflicting = sameKind.find((post) => parseKoreanDateRange(post.text, post.publishedAt));
  if (conflicting && targetStart) {
    return {
      status: "conflict",
      sourceItem: await toSourceItem(conflicting),
      reason: "official_sources_report_different_start_dates",
    };
  }
  return { status: "x_unavailable", sourceItem: null, reason: "matching_post_not_found" };
}

async function toSourceItem(post: { text: string; href: string; publishedAt: string }) {
  const match = post.href.match(/\/status\/(\d+)/);
  const itemId = match?.[1] ?? (await sha256Hex(post.href)).slice(0, 20);
  return {
    source: "x-nikke-kr",
    itemId,
    url: post.href,
    title: post.text.slice(0, 160),
    excerpt: post.text.slice(0, 600),
    normalizedText: post.text,
    publishedAt: new Date(post.publishedAt).toISOString(),
    contentHash: await sha256Hex(post.text),
    structured: true,
    official: true,
  } satisfies NormalizedSourceItem;
}

function sameEventKind(text: string, eventType: ScheduleEvent["eventType"]) {
  if (eventType === "solo" || eventType === "schedule_change") {
    return /(솔로\s*레이드|솔레)/.test(text);
  }
  if (eventType === "cooperation") return /(협동\s*작전|협작)/.test(text);
  if (eventType === "collaboration") return /콜라보/.test(text);
  return /(관리\s*키트\s*상자|보상)/.test(text);
}
