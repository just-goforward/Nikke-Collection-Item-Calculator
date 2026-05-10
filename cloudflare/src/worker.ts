/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS?: string;
  TURNSTILE_SECRET_KEY?: string;
  RATE_LIMIT_SECRET?: string;
}

const KIT_ORDER = ["blue", "purple", "yellow"];
const KIT_EXP = { blue: 200, purple: 500, yellow: 1000 };
const REQUIRED_EXP = { R: 1000, SR: 3000 };
const MAX_BODY_BYTES = 4096;
const MAX_STOCK = 100000;
const MAX_RECOMMENDED_USES = 100;
const MAX_SOURCE_HOST_LENGTH = 80;
const PRE_MINUTE_LIMIT = 120;
const PRE_DAY_LIMIT = 1000;
const POST_MINUTE_LIMIT = 30;
const POST_DAY_LIMIT = 200;
const KST_OFFSET_SECONDS = 9 * 60 * 60;
const GREAT_SUCCESS = {
  R: {
    blue: [null, 20.8, 24.0, 27.2, 40.0, 16.0, 19.2, 22.4, 27.2, 40.0, 14.4, 17.6, 22.4, 27.2, 40.0],
    purple: [null, 65.0, 75.0, 85.0, 100.0, 50.0, 60.0, 70.0, 85.0, 100.0, 45.0, 55.0, 70.0, 85.0, 100.0],
    yellow: [null, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
  },
  SR: {
    blue: [null, 5.9, 7.8, 11.3, 15.0, 2.2, 3.3, 4.9, 7.6, 12.5, 1.2, 2.2, 3.1, 4.7, 10.0],
    purple: [null, 19.8, 28.7, 41.3, 55.0, 8.0, 12.0, 18.0, 28.0, 50.0, 5.4, 9.9, 14.4, 21.6, 45.0],
    yellow: [null, 40.0, 55.0, 75.0, 100.0, 20.0, 30.0, 45.0, 70.0, 100.0, 15.0, 27.5, 40.0, 60.0, 100.0],
  },
};

class HttpError extends Error {
  status: number;

  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return handleOptions(request, env);
      if (url.pathname === "/api/stats" && request.method === "GET") return handleStats(request, env);
      if (url.pathname === "/api/events" && request.method === "POST") return handleEvent(request, env, ctx);
      return jsonResponse(request, env, { error: "not_found" }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      return jsonResponse(request, env, { error: error.message || "internal_error" }, status);
    }
  },
};

export default worker;

function normalizeOrigin(origin) {
  return String(origin || "").trim().replace(/\/+$/, "");
}

function normalizeSourceHost(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/^www\./, "") : "";
  if (!raw) return "unknown";
  if (raw === "direct" || raw === "same-site" || raw === "unknown") return raw;
  if (raw.length > MAX_SOURCE_HOST_LENGTH) return "unknown";
  if (!/^[a-z0-9.-]+$/.test(raw)) return "unknown";
  if (raw.includes("..") || raw.startsWith(".") || raw.endsWith(".") || raw.startsWith("-") || raw.endsWith("-")) return "unknown";
  return raw;
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
}

function isAllowedOrigin(request, env) {
  const origin = normalizeOrigin(request.headers.get("Origin"));
  const allowed = allowedOrigins(env);
  if (!origin) return true;
  return allowed.includes(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const normalizedOrigin = normalizeOrigin(origin);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (normalizedOrigin && isAllowedOrigin(request, env)) headers["Access-Control-Allow-Origin"] = normalizedOrigin;
  return headers;
}

function securityHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

function handleOptions(request, env) {
  if (!isAllowedOrigin(request, env)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function jsonResponse(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders(), ...corsHeaders(request, env) },
  });
}

function kstDateKeyFromUnixSeconds(seconds) {
  return new Date((seconds + KST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

async function handleEvent(request, env, ctx) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) throw new HttpError(415, "json_required");
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
  const now = Math.floor(Date.now() / 1000);

  await rateLimit(request, env, "pre", PRE_MINUTE_LIMIT, PRE_DAY_LIMIT, now);

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new HttpError(400, "invalid_json");
  }

  await verifyTurnstile(request, env, payload.turnstileToken);
  await rateLimit(request, env, "post", POST_MINUTE_LIMIT, POST_DAY_LIMIT, now);
  const normalized = validatePayload(payload);

  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO event_ids (id, created_at) VALUES (?, ?)")
    .bind(normalized.eventId, now)
    .run();

  if (!inserted.meta || inserted.meta.changes === 0) {
    scheduleCleanup(env, ctx, now);
    return jsonResponse(request, env, { ok: true, duplicate: true });
  }

  const dateKey = kstDateKeyFromUnixSeconds(now);
  const successAttempt = normalized.event.successAttempt || 0;
  const attempts = normalized.event.outcome === "great_success" ? successAttempt : normalized.event.recommendedUses;
  const greatSuccesses = normalized.event.outcome === "great_success" ? 1 : 0;

  await env.DB.prepare(
    `INSERT INTO event_aggregates
      (date_key, grade, level, exp_bucket, kit, recommended_uses, outcome, success_attempt, events, attempts, great_successes, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(date_key, grade, level, exp_bucket, kit, recommended_uses, outcome, success_attempt)
     DO UPDATE SET
      events = events + 1,
      attempts = attempts + excluded.attempts,
      great_successes = great_successes + excluded.great_successes,
      last_seen = excluded.last_seen`,
  )
    .bind(
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
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO referrer_aggregates
      (date_key, source_host, events, last_seen)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(date_key, source_host)
     DO UPDATE SET
      events = events + 1,
      last_seen = excluded.last_seen`,
  )
    .bind(dateKey, normalized.sourceHost, now)
    .run();

  scheduleCleanup(env, ctx, now);

  return jsonResponse(request, env, { ok: true });
}

async function handleStats(request, env) {
  if (!isAllowedOrigin(request, env)) throw new HttpError(403, "origin_not_allowed");
  if (!env.DB) throw new HttpError(500, "database_not_configured");
  const now = Math.floor(Date.now() / 1000);
  const today = kstDateKeyFromUnixSeconds(now);
  const since = kstDateKeyFromUnixSeconds(now - 86400 * 30);

  const statRows = await env.DB.prepare(
    `SELECT grade, level, kit, SUM(events) AS events, SUM(attempts) AS attempts, SUM(great_successes) AS great_successes
     FROM event_aggregates
     WHERE date_key >= ?
     GROUP BY grade, level, kit`,
  )
    .bind(since)
    .all();

  const distributionRows = await env.DB.prepare(
    `SELECT kit, success_attempt, SUM(events) AS events
     FROM event_aggregates
     WHERE date_key >= ? AND outcome = 'great_success'
     GROUP BY kit, success_attempt
     ORDER BY kit, success_attempt`,
  )
    .bind(since)
    .all();

  const todayRow = await env.DB.prepare(
    `SELECT SUM(events) AS events, SUM(attempts) AS attempts, SUM(great_successes) AS great_successes
     FROM event_aggregates
     WHERE date_key = ?`,
  )
    .bind(today)
    .first();

  const rows = statRows.results || [];
  const summary = rows.reduce(
    (total, row) => {
      total.events += Number(row.events || 0);
      total.attempts += Number(row.attempts || 0);
      total.greatSuccesses += Number(row.great_successes || 0);
      return total;
    },
    { events: 0, attempts: 0, greatSuccesses: 0 },
  );

  const byKit = KIT_ORDER.map((kit) => {
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

  const segmentStats = buildSegmentStats(rows);
  const levelKitStats = buildLevelKitStats(rows);
  const mostUsedKit = byKit.reduce((best, item) => {
    if (!best || Number(item.attempts || 0) > Number(best.attempts || 0)) return item;
    return best;
  }, null);

  return jsonResponse(request, env, {
    windowDays: 30,
    today,
    summary: {
      ...summary,
      greatSuccessRate: rate(summary.greatSuccesses, summary.attempts),
      todayEvents: Number((todayRow && todayRow.events) || 0),
      todayAttempts: Number((todayRow && todayRow.attempts) || 0),
      todayGreatSuccesses: Number((todayRow && todayRow.great_successes) || 0),
      mostUsedKit: mostUsedKit ? mostUsedKit.kit : null,
      mostUsedKitPieces: mostUsedKit ? Number(mostUsedKit.attempts || 0) * 10 : 0,
    },
    byKit,
    levelKitStats,
    segmentStats,
    successAttemptDistribution: (distributionRows.results || []).map((row) => ({
      kit: row.kit,
      successAttempt: Number(row.success_attempt),
      events: Number(row.events || 0),
    })),
  });
}

function aggregateRows(rows) {
  return rows.reduce(
    (total, row) => {
      const attempts = Number(row.attempts || 0);
      total.events += Number(row.events || 0);
      total.attempts += attempts;
      total.greatSuccesses += Number(row.great_successes || 0);
      total.expectedGreatSuccesses += attempts * greatSuccessProbability(row.grade, Number(row.level), row.kit);
      return total;
    },
    { events: 0, attempts: 0, greatSuccesses: 0, expectedGreatSuccesses: 0 },
  );
}

function buildSegmentStats(rows) {
  const groups = new Map();
  for (const row of rows) {
    const segment = segmentForState(row.grade, Number(row.level));
    if (!segment) continue;
    const group = groups.get(segment.key) || { ...segment, rows: [] };
    group.rows.push(row);
    groups.set(segment.key, group);
  }

  return ["R:1", "R:5", "R:10", "SR:1", "SR:5", "SR:10"].map((key) => {
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

function buildLevelKitStats(rows) {
  return ["R", "SR"].flatMap((grade) =>
    Array.from({ length: 14 }, (_, index) => {
      const level = index + 1;
      const kits = Object.fromEntries(
        KIT_ORDER.map((kit) => {
          const totals = aggregateRows(rows.filter((row) => row.grade === grade && Number(row.level) === level && row.kit === kit));
          return [
            kit,
            {
              attempts: totals.attempts,
              greatSuccesses: totals.greatSuccesses,
              greatSuccessRate: rate(totals.greatSuccesses, totals.attempts),
              theoreticalGreatSuccessRate: greatSuccessProbability(grade, level, kit),
            },
          ];
        }),
      );
      return { grade, level, kits };
    }),
  );
}

function greatSuccessProbability(grade, level, kit) {
  const table = GREAT_SUCCESS[grade] && GREAT_SUCCESS[grade][kit];
  if (!table || level < 1 || level > 14) return 0;
  return Number(table[level] || 0) / 100;
}

function segmentForState(grade, level) {
  if (grade !== "R" && grade !== "SR") return null;
  if (level >= 1 && level <= 4) return { key: `${grade}:1`, label: `${grade} 1→5` };
  if (level >= 5 && level <= 9) return { key: `${grade}:5`, label: `${grade} 5→10` };
  if (level >= 10 && level <= 14) return { key: `${grade}:10`, label: `${grade} 10→15` };
  return null;
}

function segmentForKey(key) {
  const [grade, start] = key.split(":");
  const end = start === "1" ? "5" : start === "5" ? "10" : "15";
  return { key, label: `${grade} ${start}→${end}`, rows: [] };
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET_KEY) throw new HttpError(500, "turnstile_not_configured");
  if (typeof token !== "string" || token.length < 20 || token.length > 2048) {
    throw new HttpError(403, "turnstile_token_required");
  }

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const result = (await response.json()) as { success?: boolean };
  if (!result.success) throw new HttpError(403, "turnstile_failed");
}

async function rateLimit(request, env, scope, minuteLimit, dayLimit, now) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const key = await hashKey(`${env.RATE_LIMIT_SECRET || "change-this-secret"}:${ip}`);
  const minute = Math.floor(now / 60);
  const day = Math.floor(now / 86400);
  await bumpLimit(env.DB, `${scope}:m:${key}:${minute}`, minuteLimit, now + 180);
  await bumpLimit(env.DB, `${scope}:d:${key}:${day}`, dayLimit, now + 86400 * 2);
}

async function bumpLimit(db, key, limit, expiresAt) {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, expires_at)
       VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = count + 1, expires_at = ?
       RETURNING count`,
    )
    .bind(key, expiresAt, expiresAt)
    .first();
  if (Number(row && row.count) > limit) throw new HttpError(429, "rate_limited");
}

function scheduleCleanup(env, ctx, now) {
  if (!ctx || now % 20 !== 0) return;
  ctx.waitUntil(
    Promise.all([
      env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now).run(),
      env.DB.prepare("DELETE FROM event_ids WHERE created_at < ?").bind(now - 86400 * 14).run(),
    ]),
  );
}

async function hashKey(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function validatePayload(payload) {
  if (!payload || payload.version !== 1) throw new HttpError(400, "invalid_version");
  if (typeof payload.eventId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(payload.eventId)) {
    throw new HttpError(400, "invalid_event_id");
  }
  const event = payload.event;
  if (!event || event.kind !== "kit_result") throw new HttpError(400, "invalid_event_kind");
  const start = normalizeState(event.start, false);
  const resultState = normalizeState(event.resultState, true);
  const stockBefore = normalizeStock(event.stockBefore);
  const stockAfter = normalizeStock(event.stockAfter);
  const kit = KIT_ORDER.includes(event.kit) ? event.kit : null;
  if (!kit) throw new HttpError(400, "invalid_kit");
  const recommendedUses = intInRange(event.recommendedUses, 1, MAX_RECOMMENDED_USES, "invalid_recommended_uses");
  const outcome = event.outcome === "great_success" || event.outcome === "no_great_success" ? event.outcome : null;
  if (!outcome) throw new HttpError(400, "invalid_outcome");

  const otherChanged = KIT_ORDER.some((name) => name !== kit && stockBefore[name] !== stockAfter[name]);
  if (otherChanged) throw new HttpError(400, "unexpected_stock_change");
  const usedKits = stockBefore[kit] - stockAfter[kit];
  if (usedKits <= 0 || usedKits % 10 !== 0) throw new HttpError(400, "invalid_stock_delta");
  const usedAttempts = usedKits / 10;

  let successAttempt = null;
  if (outcome === "great_success") {
    successAttempt = intInRange(event.successAttempt, 1, recommendedUses, "invalid_success_attempt");
    if (usedAttempts !== successAttempt) throw new HttpError(400, "stock_delta_does_not_match_success_attempt");
    if (!sameState(resultState, greatSuccessState(start))) throw new HttpError(400, "invalid_success_result_state");
  } else {
    if (event.successAttempt !== null && event.successAttempt !== undefined) throw new HttpError(400, "unexpected_success_attempt");
    if (usedAttempts !== recommendedUses) throw new HttpError(400, "stock_delta_does_not_match_recommended_uses");
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

function normalizeState(state, allowLevel15) {
  if (!state || (state.grade !== "R" && state.grade !== "SR")) throw new HttpError(400, "invalid_state_grade");
  const maxLevel = allowLevel15 ? 15 : 14;
  const level = intInRange(state.level, 1, maxLevel, "invalid_state_level");
  const required = REQUIRED_EXP[state.grade];
  const exp = intInRange(state.exp, 0, required - 100, "invalid_state_exp");
  if (exp % 100 !== 0) throw new HttpError(400, "invalid_state_exp_step");
  if (level === 15 && exp !== 0) throw new HttpError(400, "invalid_level_15_exp");
  return { grade: state.grade, level, exp };
}

function normalizeStock(stock) {
  if (!stock) throw new HttpError(400, "invalid_stock");
  return {
    blue: intInRange(stock.blue, 0, MAX_STOCK, "invalid_blue_stock"),
    purple: intInRange(stock.purple, 0, MAX_STOCK, "invalid_purple_stock"),
    yellow: intInRange(stock.yellow, 0, MAX_STOCK, "invalid_yellow_stock"),
  };
}

function intInRange(value, min, max, message) {
  if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, message);
  return value;
}

function sameState(a, b) {
  return a.grade === b.grade && a.level === b.level && a.exp === b.exp;
}

function nextBoundary(level) {
  if (level < 5) return 5;
  if (level < 10) return 10;
  return 15;
}

function greatSuccessState(state) {
  return { grade: state.grade, level: nextBoundary(state.level), exp: 0 };
}

function failAfterUses(state, kit, uses) {
  let next = { ...state };
  for (let index = 0; index < uses; index += 1) next = failOnce(next, kit);
  return next;
}

function failOnce(state, kit) {
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
