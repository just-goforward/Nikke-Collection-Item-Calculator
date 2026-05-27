/// <reference types="@cloudflare/workers-types" />

import { EventSubmissionSchema } from "./schemas";

interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS?: string;
  TURNSTILE_SECRET_KEY?: string;
  RATE_LIMIT_SECRET?: string;
}

type Grade = "R" | "SR";
const KIT_ORDER = ["blue", "purple", "yellow"] as const;
type Kit = (typeof KIT_ORDER)[number];
type StatsEventKind = "kit_result" | "solver_diagnostic";
const STRATEGY_ORDER = ["single", "supply"] as const;
type Strategy = (typeof STRATEGY_ORDER)[number] | "unknown";
// biome-ignore lint/suspicious/noExplicitAny: D1 rows and validated JSON payloads are heterogeneous at runtime; domain checks below narrow them before use.
type AnyValue = any;
type KitRecord<T> = Record<Kit, T>;
type CollectionState = { grade: Grade; level: number; exp: number };

const KIT_EXP: KitRecord<number> = { blue: 200, purple: 500, yellow: 1000 };
const REQUIRED_EXP: Record<Grade, number> = { R: 1000, SR: 3000 };
const MAX_BODY_BYTES = 4096;
const MAX_STOCK = 100000;
const MAX_RECOMMENDED_USES = 100;
const MAX_SOURCE_HOST_LENGTH = 80;
const PRE_MINUTE_LIMIT = 120;
const PRE_DAY_LIMIT = 1000;
const POST_MINUTE_LIMIT = 30;
const POST_DAY_LIMIT = 200;
const KST_OFFSET_SECONDS = 9 * 60 * 60;
const TURNSTILE_VERIFY_TIMEOUT_MS = 5_000;
const TURNSTILE_CLIENT_RETRY_CODES = new Set(["timeout-or-duplicate", "invalid-input-response"]);
const GREAT_SUCCESS: Record<Grade, Record<Kit, Array<number | null>>> = {
  R: {
    blue: [
      17.6, 20.8, 24.0, 27.2, 40.0, 16.0, 19.2, 22.4, 27.2, 40.0, 14.4, 17.6, 22.4, 27.2, 40.0,
    ],
    purple: [
      55.0, 65.0, 75.0, 85.0, 100.0, 50.0, 60.0, 70.0, 85.0, 100.0, 45.0, 55.0, 70.0, 85.0, 100.0,
    ],
    yellow: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
  },
  SR: {
    blue: [3.6, 5.9, 7.8, 11.3, 15.0, 2.2, 3.3, 4.9, 7.6, 12.5, 1.2, 2.2, 3.1, 4.7, 10.0],
    purple: [11.0, 19.8, 28.7, 41.3, 55.0, 8.0, 12.0, 18.0, 28.0, 50.0, 5.4, 9.9, 14.4, 21.6, 45.0],
    yellow: [
      25.0, 40.0, 55.0, 75.0, 100.0, 20.0, 30.0, 45.0, 70.0, 100.0, 15.0, 27.5, 40.0, 60.0, 100.0,
    ],
  },
};

class HttpError extends Error {
  status: number;
  retryable?: boolean;

  constructor(status: number, message: string, retryable?: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return handleOptions(request, env);
      if (url.pathname === "/api/stats" && request.method === "GET")
        return await handleStats(request, env);
      if (url.pathname === "/api/events" && request.method === "POST")
        return await handleEvent(request, env, ctx);
      return jsonResponse(request, env, { error: "not_found" }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "internal_error";
      const body: { error: string; retryable?: boolean } = {
        error: message || "internal_error",
      };
      if (error instanceof HttpError && typeof error.retryable === "boolean") {
        body.retryable = error.retryable;
      }
      return jsonResponse(request, env, body, status);
    }
  },
};

export default worker;

function normalizeOrigin(origin: unknown) {
  return String(origin || "")
    .trim()
    .replace(/\/+$/, "");
}

function normalizeSourceHost(value: unknown) {
  const raw =
    typeof value === "string"
      ? value
          .trim()
          .toLowerCase()
          .replace(/^www\./, "")
      : "";
  if (!raw) return "unknown";
  if (raw === "direct" || raw === "same-site" || raw === "unknown") return raw;
  if (raw.length > MAX_SOURCE_HOST_LENGTH) return "unknown";
  if (!/^[a-z0-9.-]+$/.test(raw)) return "unknown";
  if (
    raw.includes("..") ||
    raw.startsWith(".") ||
    raw.endsWith(".") ||
    raw.startsWith("-") ||
    raw.endsWith("-")
  )
    return "unknown";
  return raw;
}

function normalizeStrategy(value: unknown): Strategy {
  return STRATEGY_ORDER.includes(value as (typeof STRATEGY_ORDER)[number])
    ? (value as (typeof STRATEGY_ORDER)[number])
    : "unknown";
}

function normalizeDiagnosticToken(value: unknown) {
  const token = String(value || "").trim();
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(token) ? token : "unknown";
}

function normalizeMajor(value: unknown) {
  const match = String(value || "").match(/\d+/);
  if (!match) return "unknown";
  return match[0].slice(0, 3);
}

function stripHeaderQuotes(value: string) {
  return value.trim().replace(/^"|"$/g, "");
}

function browserFromUserAgent(userAgent: string) {
  const samsung = userAgent.match(/SamsungBrowser\/(\d+)/i);
  if (samsung) return { browser: "Samsung Internet", browserMajor: normalizeMajor(samsung[1]) };
  const edge = userAgent.match(/Edg(?:e|A|iOS)?\/(\d+)/i);
  if (edge) return { browser: "Edge", browserMajor: normalizeMajor(edge[1]) };
  const firefox = userAgent.match(/(?:Firefox|FxiOS)\/(\d+)/i);
  if (firefox) return { browser: "Firefox", browserMajor: normalizeMajor(firefox[1]) };
  const chrome = userAgent.match(/(?:Chrome|CriOS|Chromium)\/(\d+)/i);
  if (chrome) return { browser: "Chrome", browserMajor: normalizeMajor(chrome[1]) };
  const safari = userAgent.match(/Version\/(\d+).+Safari\//i);
  if (safari) return { browser: "Safari", browserMajor: normalizeMajor(safari[1]) };
  return null;
}

function browserFromClientHints(header: string) {
  const brands: Array<{ brand: string; major: string }> = [];
  const pattern = /"([^"]+)";v="(\d+)/g;
  let match = pattern.exec(header);
  while (match) {
    const brand = match[1].toLowerCase();
    if (!(brand.includes("not") && brand.includes("brand"))) {
      brands.push({ brand, major: normalizeMajor(match[2]) });
    }
    match = pattern.exec(header);
  }
  const prioritized = [
    { needle: "samsung", browser: "Samsung Internet" },
    { needle: "microsoft edge", browser: "Edge" },
    { needle: "google chrome", browser: "Chrome" },
    { needle: "chromium", browser: "Chrome" },
  ];
  for (const candidate of prioritized) {
    const brand = brands.find((item) => item.brand.includes(candidate.needle));
    if (brand) return { browser: candidate.browser, browserMajor: brand.major };
  }
  return null;
}

function osFromUserAgent(userAgent: string) {
  const android = userAgent.match(/Android\s+(\d+)/i);
  if (android) return { os: "Android", osMajor: normalizeMajor(android[1]) };
  const ios = userAgent.match(/(?:iPhone OS|CPU OS)\s+(\d+)/i);
  if (ios) return { os: "iOS", osMajor: normalizeMajor(ios[1]) };
  const windows = userAgent.match(/Windows NT\s+(\d+)/i);
  if (windows) return { os: "Windows", osMajor: normalizeMajor(windows[1]) };
  const macos = userAgent.match(/Mac OS X\s+(\d+)/i);
  if (macos) return { os: "macOS", osMajor: normalizeMajor(macos[1]) };
  const chromeos = userAgent.match(/CrOS/i);
  if (chromeos) return { os: "ChromeOS", osMajor: "unknown" };
  if (/Linux/i.test(userAgent)) return { os: "Linux", osMajor: "unknown" };
  return null;
}

function osFromClientHints(platformHeader: string, userAgent: string) {
  const platform = stripHeaderQuotes(platformHeader).toLowerCase();
  if (!platform) return null;
  const fallback = osFromUserAgent(userAgent);
  if (platform.includes("android"))
    return { os: "Android", osMajor: fallback?.osMajor || "unknown" };
  if (platform.includes("ios")) return { os: "iOS", osMajor: fallback?.osMajor || "unknown" };
  if (platform.includes("windows"))
    return { os: "Windows", osMajor: fallback?.osMajor || "unknown" };
  if (platform.includes("mac")) return { os: "macOS", osMajor: fallback?.osMajor || "unknown" };
  if (platform.includes("chrome"))
    return { os: "ChromeOS", osMajor: fallback?.osMajor || "unknown" };
  if (platform.includes("linux")) return { os: "Linux", osMajor: fallback?.osMajor || "unknown" };
  return null;
}

function deviceTypeFromHeaders(request: Request, userAgent: string) {
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(userAgent)) return "tablet";
  const mobileHint = request.headers.get("Sec-CH-UA-Mobile");
  if (mobileHint === "?1") return "mobile";
  if (/Mobi|Android|iPhone|iPod|Mobile/i.test(userAgent)) return "mobile";
  if (userAgent) return "desktop";
  return "unknown";
}

function clientEnvironment(request: Request) {
  const userAgent = request.headers.get("User-Agent") || "";
  const browser = browserFromUserAgent(userAgent) ||
    browserFromClientHints(request.headers.get("Sec-CH-UA") || "") || {
      browser: "Unknown",
      browserMajor: "unknown",
    };
  const os = osFromClientHints(request.headers.get("Sec-CH-UA-Platform") || "", userAgent) ||
    osFromUserAgent(userAgent) || {
      os: "Unknown",
      osMajor: "unknown",
    };
  return {
    browser: browser.browser,
    browserMajor: browser.browserMajor,
    os: os.os,
    osMajor: os.osMajor,
    deviceType: deviceTypeFromHeaders(request, userAgent),
  };
}

function allowedOrigins(env: Env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
}

function isAllowedOrigin(request: Request, env: Env) {
  const origin = normalizeOrigin(request.headers.get("Origin"));
  const allowed = allowedOrigins(env);
  if (!origin) return true;
  return allowed.includes(origin);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const normalizedOrigin = normalizeOrigin(origin);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (normalizedOrigin && isAllowedOrigin(request, env))
    headers["Access-Control-Allow-Origin"] = normalizedOrigin;
  return headers;
}

function securityHeaders(cacheControl = "no-store"): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": cacheControl,
  };
}

function handleOptions(request: Request, env: Env) {
  if (!isAllowedOrigin(request, env)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function jsonResponse(
  request: Request,
  env: Env,
  body: AnyValue,
  status = 200,
  cacheControl = "no-store",
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders(cacheControl), ...corsHeaders(request, env) },
  });
}

function kstDateKeyFromUnixSeconds(seconds: number) {
  return new Date((seconds + KST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

async function handleEvent(request: Request, env: Env, ctx: ExecutionContext) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) throw new HttpError(415, "json_required");
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
  const now = Math.floor(Date.now() / 1000);

  if (!env.RATE_LIMIT_SECRET) throw new HttpError(500, "rate_limit_not_configured");
  await rateLimit(request, env, "pre", PRE_MINUTE_LIMIT, PRE_DAY_LIMIT, now);

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES)
    throw new HttpError(413, "payload_too_large");

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json");
  }

  const parsedPayload = EventSubmissionSchema.safeParse(payload);
  if (!parsedPayload.success) throw new HttpError(400, "invalid_payload");

  await verifyTurnstile(
    request,
    env,
    parsedPayload.data.turnstileToken,
    parsedPayload.data.event.kind,
  );
  await rateLimit(request, env, "post", POST_MINUTE_LIMIT, POST_DAY_LIMIT, now);
  const normalized = validatePayload(parsedPayload.data);

  const dateKey = kstDateKeyFromUnixSeconds(now);
  if (normalized.event.kind === "solver_diagnostic") {
    const duplicate = await commitEvent(env, normalized.eventId, now, normalized.event.kind, [
      buildSolverDiagnosticAggregateStatement(env, dateKey, normalized.event, now),
    ]);
    scheduleCleanup(env, ctx, now);
    return jsonResponse(request, env, duplicate ? { ok: true, duplicate: true } : { ok: true });
  }

  const successAttempt = normalized.event.successAttempt || 0;
  const attempts =
    normalized.event.outcome === "great_success"
      ? successAttempt
      : normalized.event.recommendedUses;
  const greatSuccesses = normalized.event.outcome === "great_success" ? 1 : 0;
  const environment = clientEnvironment(request);

  const duplicate = await commitEvent(env, normalized.eventId, now, "kit_result", [
    env.DB.prepare(
      `INSERT INTO event_aggregates
      (date_key, grade, level, exp_bucket, kit, recommended_uses, outcome, success_attempt, events, attempts, great_successes, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(date_key, grade, level, exp_bucket, kit, recommended_uses, outcome, success_attempt)
     DO UPDATE SET
      events = events + 1,
      attempts = attempts + excluded.attempts,
      great_successes = great_successes + excluded.great_successes,
      last_seen = excluded.last_seen`,
    ).bind(
      dateKey,
      normalized.event.start.grade,
      normalized.event.start.level,
      normalized.event.start.exp,
      normalized.event.kit,
      normalized.event.recommendedUses,
      normalized.event.outcome,
      successAttempt,
      attempts,
      greatSuccesses,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO referrer_aggregates
      (date_key, source_host, events, last_seen)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(date_key, source_host)
     DO UPDATE SET
      events = events + 1,
      last_seen = excluded.last_seen`,
    ).bind(dateKey, normalized.sourceHost, now),
    env.DB.prepare(
      `INSERT INTO client_env_aggregates
      (date_key, browser, browser_major, os, os_major, device_type, events, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date_key, browser, browser_major, os, os_major, device_type)
     DO UPDATE SET
      events = events + 1,
      last_seen = excluded.last_seen`,
    ).bind(
      dateKey,
      environment.browser,
      environment.browserMajor,
      environment.os,
      environment.osMajor,
      environment.deviceType,
      now,
    ),
  ]);

  scheduleCleanup(env, ctx, now);

  return jsonResponse(request, env, duplicate ? { ok: true, duplicate: true } : { ok: true });
}

async function commitEvent(
  env: Env,
  eventId: string,
  now: number,
  eventKind: StatsEventKind,
  aggregateStatements: D1PreparedStatement[],
): Promise<boolean> {
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO event_ids (id, created_at) VALUES (?, ?)").bind(eventId, now),
      ...aggregateStatements,
    ]);
    return false;
  } catch (error) {
    let existing: { event_exists?: number } | null;
    try {
      existing = await env.DB.prepare("SELECT 1 AS event_exists FROM event_ids WHERE id = ?")
        .bind(eventId)
        .first<{ event_exists?: number }>();
    } catch {
      console.error("Statistics event storage lookup failed.", {
        eventKind,
        error: error instanceof Error ? error.message : "unknown_error",
      });
      throw new HttpError(503, "storage_unavailable", true);
    }
    if (existing?.event_exists === 1) return true;
    console.error("Statistics event storage failed.", {
      eventKind,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    throw new HttpError(503, "storage_unavailable", true);
  }
}

function buildSolverDiagnosticAggregateStatement(
  env: Env,
  dateKey: string,
  event: AnyValue,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO solver_diagnostic_aggregates
      (date_key, diagnostic_version, solver_version, solver_phase, grade, level, exp_bucket,
       strategy, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
       recommended_kit, recommended_uses_bucket, candidate_count_bucket,
       probability_gap_bucket, resource_cost_bucket, legacy_supply_cost_bucket,
       total_expected_cost_bucket,
       blue_share_bucket, min_autonomy_days_bucket, changed_from_single,
       changed_from_legacy_supply, legacy_private_stats_available,
       legacy_event_aggregate_matchable, events, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(date_key, diagnostic_version, solver_version, solver_phase, grade, level,
       exp_bucket, strategy, stock_bucket_blue, stock_bucket_purple, stock_bucket_yellow,
       recommended_kit, recommended_uses_bucket, candidate_count_bucket,
       probability_gap_bucket, resource_cost_bucket, legacy_supply_cost_bucket,
       total_expected_cost_bucket,
       blue_share_bucket, min_autonomy_days_bucket, changed_from_single,
       changed_from_legacy_supply, legacy_private_stats_available,
       legacy_event_aggregate_matchable)
     DO UPDATE SET
      events = events + 1,
      last_seen = excluded.last_seen`,
  ).bind(
    dateKey,
    event.diagnosticVersion,
    event.solverVersion,
    event.solverPhase,
    event.start.grade,
    event.start.level,
    event.start.exp,
    event.strategy,
    event.stockBuckets.blue,
    event.stockBuckets.purple,
    event.stockBuckets.yellow,
    event.recommendedKit,
    event.recommendedUsesBucket,
    event.candidateCountBucket,
    event.probabilityGapBucket,
    event.resourceCostBucket,
    event.legacySupplyCostBucket,
    event.totalExpectedCostBucket,
    event.blueShareBucket,
    event.minAutonomyDaysBucket,
    event.changedFromSingle,
    event.changedFromLegacySupply,
    event.legacyPrivateStatsAvailable ? 1 : 0,
    event.legacyEventAggregateMatchable ? 1 : 0,
    now,
  );
}

async function handleStats(request: Request, env: Env) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");
  const now = Math.floor(Date.now() / 1000);
  const today = kstDateKeyFromUnixSeconds(now);
  const since = kstDateKeyFromUnixSeconds(now - 86400 * 30);

  const [statRows, cumulativeRows, todayRow] = await Promise.all([
    env.DB.prepare(
      `SELECT grade, level, kit, SUM(events) AS events, SUM(attempts) AS attempts, SUM(great_successes) AS great_successes
       FROM event_aggregates
       WHERE date_key >= ?
       GROUP BY grade, level, kit`,
    )
      .bind(since)
      .all(),
    env.DB.prepare(
      `SELECT grade, level, kit, SUM(events) AS events, SUM(attempts) AS attempts, SUM(great_successes) AS great_successes
       FROM event_aggregates
       GROUP BY grade, level, kit`,
    ).all(),
    env.DB.prepare(
      `SELECT SUM(events) AS events, SUM(attempts) AS attempts, SUM(great_successes) AS great_successes
       FROM event_aggregates
       WHERE date_key = ?`,
    )
      .bind(today)
      .first(),
  ]);

  const rows = (statRows.results || []) as AnyValue[];
  const allRows = (cumulativeRows.results || []) as AnyValue[];
  const summary = summarizeRows(rows);
  const cumulativeSummary = summarizeRows(allRows);
  const byKit = buildByKitStats(rows);
  const cumulativeByKit = buildByKitStats(allRows);

  const segmentStats = buildSegmentStats(rows);
  const mostUsedKit = byKit.reduce<(typeof byKit)[number] | null>((best, item) => {
    if (!best || Number(item.attempts || 0) > Number(best.attempts || 0)) return item;
    return best;
  }, null);
  const cumulativeMostUsedKit = cumulativeByKit.reduce<(typeof cumulativeByKit)[number] | null>(
    (best, item) => {
      if (!best || Number(item.attempts || 0) > Number(best.attempts || 0)) return item;
      return best;
    },
    null,
  );

  return jsonResponse(
    request,
    env,
    {
      windowDays: 30,
      today,
      summary: {
        ...summary,
        greatSuccessRate: rate(summary.greatSuccesses, summary.attempts),
        todayEvents: Number(todayRow?.events || 0),
        todayAttempts: Number(todayRow?.attempts || 0),
        todayGreatSuccesses: Number(todayRow?.great_successes || 0),
        mostUsedKit: mostUsedKit ? mostUsedKit.kit : null,
        mostUsedKitPieces: mostUsedKit ? Number(mostUsedKit.attempts || 0) * 10 : 0,
      },
      byKit,
      cumulative: {
        summary: {
          ...cumulativeSummary,
          mostUsedKit: cumulativeMostUsedKit ? cumulativeMostUsedKit.kit : null,
          mostUsedKitPieces: cumulativeMostUsedKit
            ? Number(cumulativeMostUsedKit.attempts || 0) * 10
            : 0,
        },
        byKit: cumulativeByKit,
      },
      levelKitStats: [],
      segmentStats,
      successAttemptDistribution: [],
    },
    200,
    "public, max-age=60, s-maxage=60",
  );
}

function summarizeRows(rows: AnyValue[]) {
  const totals = rows.reduce(
    (total: { events: number; attempts: number; greatSuccesses: number }, row: AnyValue) => {
      total.events += Number(row.events || 0);
      total.attempts += Number(row.attempts || 0);
      total.greatSuccesses += Number(row.great_successes || 0);
      return total;
    },
    { events: 0, attempts: 0, greatSuccesses: 0 },
  );
  return {
    ...totals,
    greatSuccessRate: rate(totals.greatSuccesses, totals.attempts),
  };
}

function buildByKitStats(rows: AnyValue[]) {
  return KIT_ORDER.map((kit) => {
    const kitRows = rows.filter((item) => item.kit === kit);
    const totals = aggregateRows(kitRows);
    return {
      kit,
      events: totals.events,
      attempts: totals.attempts,
      greatSuccesses: totals.greatSuccesses,
      greatSuccessRate: rate(totals.greatSuccesses, totals.attempts),
      theoreticalGreatSuccessRate: rate(totals.expectedGreatSuccesses, totals.attempts),
    };
  });
}

function aggregateRows(rows: AnyValue[]) {
  return rows.reduce(
    (
      total: {
        events: number;
        attempts: number;
        greatSuccesses: number;
        expectedGreatSuccesses: number;
      },
      row: AnyValue,
    ) => {
      const attempts = Number(row.attempts || 0);
      total.events += Number(row.events || 0);
      total.attempts += attempts;
      total.greatSuccesses += Number(row.great_successes || 0);
      total.expectedGreatSuccesses +=
        attempts * greatSuccessProbability(row.grade as Grade, Number(row.level), row.kit as Kit);
      return total;
    },
    { events: 0, attempts: 0, greatSuccesses: 0, expectedGreatSuccesses: 0 },
  );
}

function buildSegmentStats(rows: AnyValue[]) {
  const groups = new Map();
  for (const row of rows) {
    const segment = segmentForState(row.grade as Grade, Number(row.level));
    if (!segment) continue;
    const group = groups.get(segment.key) || { ...segment, rows: [] };
    group.rows.push(row);
    groups.set(segment.key, group);
  }

  return ["R:0", "R:5", "R:10", "SR:0", "SR:5", "SR:10"].map((key) => {
    const group = groups.get(key) || segmentForKey(key);
    const totals = aggregateRows(group.rows || []);
    const actualRate = rate(totals.greatSuccesses, totals.attempts);
    return {
      key,
      label: group.label,
      events: totals.events,
      attempts: totals.attempts,
      greatSuccesses: totals.greatSuccesses,
      greatSuccessRate: actualRate,
      theoreticalGreatSuccessRate: rate(totals.expectedGreatSuccesses, totals.attempts),
      averageAttempts: rate(totals.attempts, totals.events),
    };
  });
}

function greatSuccessProbability(grade: Grade, level: number, kit: Kit) {
  const table = GREAT_SUCCESS[grade]?.[kit];
  if (!table || level < 0 || level > 14) return 0;
  return Number(table[level] || 0) / 100;
}

function segmentForState(grade: Grade, level: number) {
  if (grade !== "R" && grade !== "SR") return null;
  if (level >= 0 && level <= 4) return { key: `${grade}:0`, label: `${grade} 0→5` };
  if (level >= 5 && level <= 9) return { key: `${grade}:5`, label: `${grade} 5→10` };
  if (level >= 10 && level <= 14) return { key: `${grade}:10`, label: `${grade} 10→15` };
  return null;
}

function segmentForKey(key: string) {
  const [grade, start] = key.split(":");
  const end = start === "0" ? "5" : start === "5" ? "10" : "15";
  return { key, label: `${grade} ${start}→${end}`, rows: [] };
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

type SiteverifyResult = {
  success?: boolean;
  action?: string;
  "error-codes"?: string[];
};

type SiteverifyTransportFailure = "fetch_error" | "http_status" | "invalid_json" | "timeout";

class SiteverifyTransportError extends Error {
  failure: SiteverifyTransportFailure;
  httpStatus: number | null;

  constructor(failure: SiteverifyTransportFailure, httpStatus: number | null = null) {
    super("Siteverify transport failed.");
    this.failure = failure;
    this.httpStatus = httpStatus;
  }
}

async function requestTurnstileVerification(
  request: Request,
  env: Env,
  token: string,
  idempotencyKey: string,
): Promise<SiteverifyResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURNSTILE_VERIFY_TIMEOUT_MS);
  try {
    const form = new URLSearchParams();
    form.append("secret", String(env.TURNSTILE_SECRET_KEY));
    form.append("response", token);
    form.append("idempotency_key", idempotencyKey);
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) form.append("remoteip", ip);

    try {
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: controller.signal,
      });
      let result: SiteverifyResult;
      try {
        result = (await response.json()) as SiteverifyResult;
      } catch {
        throw new SiteverifyTransportError("invalid_json", response.status);
      }
      if (!response.ok && !Array.isArray(result["error-codes"])) {
        throw new SiteverifyTransportError("http_status", response.status);
      }
      return result;
    } catch (error) {
      if (error instanceof SiteverifyTransportError) throw error;
      throw new SiteverifyTransportError(controller.signal.aborted ? "timeout" : "fetch_error");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function logTurnstileFailure(
  eventKind: StatsEventKind,
  result: SiteverifyResult | null,
  internallyRetried: boolean,
) {
  console.warn("Turnstile verification failed.", {
    eventKind,
    expectedAction: eventKind,
    returnedAction: result?.action || null,
    errorCodes: result?.["error-codes"] || ["siteverify_unavailable"],
    internallyRetried,
  });
}

function logTurnstileTransportFailure(
  eventKind: StatsEventKind,
  error: unknown,
  internallyRetried: boolean,
) {
  const transportError = error instanceof SiteverifyTransportError ? error : null;
  console.warn("Turnstile verification unavailable.", {
    eventKind,
    expectedAction: eventKind,
    failure: transportError?.failure || "fetch_error",
    httpStatus: transportError?.httpStatus ?? null,
    internallyRetried,
  });
}

async function verifyTurnstile(
  request: Request,
  env: Env,
  token: string,
  eventKind: StatsEventKind,
) {
  if (!env.TURNSTILE_SECRET_KEY) throw new HttpError(500, "turnstile_not_configured");
  if (typeof token !== "string" || token.length < 20 || token.length > 2048) {
    throw new HttpError(403, "turnstile_token_required", false);
  }

  const idempotencyKey = crypto.randomUUID();
  let internallyRetried = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: SiteverifyResult;
    try {
      result = await requestTurnstileVerification(request, env, token, idempotencyKey);
    } catch (error) {
      if (attempt === 0) {
        internallyRetried = true;
        continue;
      }
      logTurnstileTransportFailure(eventKind, error, internallyRetried);
      throw new HttpError(502, "turnstile_unavailable", true);
    }

    if (result.success) {
      if (result.action && result.action !== eventKind) {
        console.warn("Turnstile action mismatch observed.", {
          eventKind,
          expectedAction: eventKind,
          returnedAction: result.action,
          internallyRetried,
        });
      }
      return;
    }

    const errorCodes = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
    if (errorCodes.includes("internal-error") && attempt === 0) {
      internallyRetried = true;
      continue;
    }
    logTurnstileFailure(eventKind, result, internallyRetried);
    if (errorCodes.includes("internal-error")) {
      throw new HttpError(502, "turnstile_unavailable", true);
    }
    const retryable = errorCodes.some((code) => TURNSTILE_CLIENT_RETRY_CODES.has(code));
    throw new HttpError(403, "turnstile_failed", retryable);
  }
}

async function rateLimit(
  request: Request,
  env: Env,
  scope: string,
  minuteLimit: number,
  dayLimit: number,
  now: number,
) {
  const ip =
    request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const key = await hashKey(`${env.RATE_LIMIT_SECRET}:${ip}`);
  const minute = Math.floor(now / 60);
  const day = Math.floor(now / 86400);
  const counters = [
    { key: `${scope}:m:${key}:${minute}`, limit: minuteLimit, expiresAt: now + 180 },
    { key: `${scope}:d:${key}:${day}`, limit: dayLimit, expiresAt: now + 86400 * 2 },
  ];
  const statements = counters.map((counter) =>
    env.DB.prepare(
      `INSERT INTO rate_limits (key, count, expires_at)
       VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = count + 1, expires_at = ?
       RETURNING count`,
    ).bind(counter.key, counter.expiresAt, counter.expiresAt),
  );
  const results = await env.DB.batch(statements);
  results.forEach((result: D1Result<unknown>, index: number) => {
    const row = result.results?.[0] as { count?: number } | undefined;
    if (Number(row?.count) > counters[index].limit) throw new HttpError(429, "rate_limited");
  });
}

function scheduleCleanup(env: Env, ctx: ExecutionContext, now: number) {
  if (!ctx || now % 20 !== 0) return;
  ctx.waitUntil(
    Promise.all([
      env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now).run(),
      env.DB.prepare("DELETE FROM event_ids WHERE created_at < ?")
        .bind(now - 86400 * 14)
        .run(),
    ]),
  );
}

async function hashKey(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function validatePayload(payload: AnyValue) {
  if (!payload || payload.version !== 1) throw new HttpError(400, "invalid_version");
  if (typeof payload.eventId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(payload.eventId)) {
    throw new HttpError(400, "invalid_event_id");
  }
  const event = payload.event;
  if (!event) throw new HttpError(400, "invalid_event_kind");
  if (event.kind === "solver_diagnostic") {
    return {
      eventId: payload.eventId,
      sourceHost: normalizeSourceHost(payload.sourceHost),
      event: {
        kind: "solver_diagnostic",
        diagnosticVersion: event.diagnosticVersion,
        solverVersion: normalizeDiagnosticToken(event.solverVersion),
        solverPhase: normalizeDiagnosticToken(event.solverPhase),
        start: normalizeState(event.start, false),
        strategy: normalizeStrategy(event.strategy),
        stockBuckets: {
          blue: event.stockBuckets.blue,
          purple: event.stockBuckets.purple,
          yellow: event.stockBuckets.yellow,
        },
        recommendedKit: event.recommendedKit,
        recommendedUsesBucket: event.recommendedUsesBucket,
        candidateCountBucket: event.candidateCountBucket,
        probabilityGapBucket: event.probabilityGapBucket,
        resourceCostBucket: event.resourceCostBucket,
        legacySupplyCostBucket: event.legacySupplyCostBucket,
        totalExpectedCostBucket: event.totalExpectedCostBucket,
        blueShareBucket: event.blueShareBucket,
        minAutonomyDaysBucket: event.minAutonomyDaysBucket,
        changedFromSingle: event.changedFromSingle,
        changedFromLegacySupply: event.changedFromLegacySupply,
        legacyPrivateStatsAvailable: Boolean(event.legacyPrivateStatsAvailable),
        legacyEventAggregateMatchable: Boolean(event.legacyEventAggregateMatchable),
      },
    };
  }
  if (event.kind !== "kit_result") throw new HttpError(400, "invalid_event_kind");
  const start = normalizeState(event.start, false);
  const resultState = normalizeState(event.resultState, true);
  const stockBefore = normalizeStock(event.stockBefore);
  const stockAfter = normalizeStock(event.stockAfter);
  const kit = KIT_ORDER.includes(event.kit as Kit) ? (event.kit as Kit) : null;
  if (!kit) throw new HttpError(400, "invalid_kit");
  const recommendedUses = intInRange(
    event.recommendedUses,
    1,
    MAX_RECOMMENDED_USES,
    "invalid_recommended_uses",
  );
  const outcome =
    event.outcome === "great_success" || event.outcome === "no_great_success"
      ? event.outcome
      : null;
  if (!outcome) throw new HttpError(400, "invalid_outcome");

  const otherChanged = KIT_ORDER.some(
    (name) => name !== kit && stockBefore[name] !== stockAfter[name],
  );
  if (otherChanged) throw new HttpError(400, "unexpected_stock_change");
  const usedKits = stockBefore[kit] - stockAfter[kit];
  if (usedKits <= 0 || usedKits % 10 !== 0) throw new HttpError(400, "invalid_stock_delta");
  const usedAttempts = usedKits / 10;

  let successAttempt: number | null = null;
  if (outcome === "great_success") {
    successAttempt = intInRange(
      event.successAttempt,
      1,
      recommendedUses,
      "invalid_success_attempt",
    );
    if (usedAttempts !== successAttempt)
      throw new HttpError(400, "stock_delta_does_not_match_success_attempt");
    if (!sameState(resultState, greatSuccessState(start)))
      throw new HttpError(400, "invalid_success_result_state");
  } else {
    if (event.successAttempt !== null && event.successAttempt !== undefined)
      throw new HttpError(400, "unexpected_success_attempt");
    if (usedAttempts !== recommendedUses)
      throw new HttpError(400, "stock_delta_does_not_match_recommended_uses");
    if (!sameState(resultState, failAfterUses(start, kit, recommendedUses))) {
      throw new HttpError(400, "invalid_fail_result_state");
    }
  }

  return {
    eventId: payload.eventId,
    sourceHost: normalizeSourceHost(payload.sourceHost),
    event: {
      kind: "kit_result",
      start,
      kit,
      recommendedUses,
      outcome,
      successAttempt,
      stockBefore,
      stockAfter,
      resultState,
    },
  };
}

function normalizeState(state: AnyValue, allowLevel15: boolean): CollectionState {
  if (!state || (state.grade !== "R" && state.grade !== "SR"))
    throw new HttpError(400, "invalid_state_grade");
  const grade = state.grade as Grade;
  const maxLevel = allowLevel15 ? 15 : 14;
  const level = intInRange(state.level, 0, maxLevel, "invalid_state_level");
  const required = REQUIRED_EXP[grade];
  const exp = intInRange(state.exp, 0, required - 100, "invalid_state_exp");
  if (exp % 100 !== 0) throw new HttpError(400, "invalid_state_exp_step");
  if (level === 15 && exp !== 0) throw new HttpError(400, "invalid_level_15_exp");
  return { grade, level, exp };
}

function normalizeStock(stock: AnyValue): KitRecord<number> {
  if (!stock) throw new HttpError(400, "invalid_stock");
  return {
    blue: intInRange(stock.blue, 0, MAX_STOCK, "invalid_blue_stock"),
    purple: intInRange(stock.purple, 0, MAX_STOCK, "invalid_purple_stock"),
    yellow: intInRange(stock.yellow, 0, MAX_STOCK, "invalid_yellow_stock"),
  };
}

function intInRange(value: unknown, min: number, max: number, message: string) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new HttpError(400, message);
  }
  return numeric;
}

function sameState(a: CollectionState, b: CollectionState) {
  return a.grade === b.grade && a.level === b.level && a.exp === b.exp;
}

function nextBoundary(level: number) {
  if (level < 5) return 5;
  if (level < 10) return 10;
  return 15;
}

function greatSuccessState(state: CollectionState) {
  return { grade: state.grade, level: nextBoundary(state.level), exp: 0 };
}

function failAfterUses(state: CollectionState, kit: Kit, uses: number) {
  let next = { ...state };
  for (let index = 0; index < uses; index += 1) next = failOnce(next, kit);
  return next;
}

function failOnce(state: CollectionState, kit: Kit) {
  if (state.level >= 15) return { grade: state.grade, level: 15, exp: 0 };
  let level = state.level;
  let exp = state.exp + KIT_EXP[kit];
  const required = REQUIRED_EXP[state.grade];
  while (exp >= required && level < 15) {
    exp -= required;
    level += 1;
    if (level === 5 || level === 10 || level === 15) {
      exp = 0;
      break;
    }
  }
  return { grade: state.grade, level, exp };
}
