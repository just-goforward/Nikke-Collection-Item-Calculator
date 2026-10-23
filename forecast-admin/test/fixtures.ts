import {
  addGameDays,
  calendarRange,
  gameDayEnd,
} from "../../forecast-collector/src/v2/rules/game-day.ts";

/** Shared by the workerd tests, the Node CPU spec and the Playwright spec (no network). */
export const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
export const ACCESS_AUD = "a".repeat(64);
// Placeholder identity; the real allow-list is deploy configuration only.
export const ADMIN_EMAIL = "admin@example.com";

type SqlDatabase = {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<unknown> };
  };
};

/**
 * Splits a SQL script into statements for bindings that run one statement per
 * prepare (Miniflare's D1 from Node). Quotes and comments are skipped, and a
 * `;` inside a trigger's BEGIN…END body (including nested CASE…END) does not end
 * the statement. workerd tests use D1's own parser via shared/testD1Sql.ts.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let words: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < sql.length && !(sql[j] === close && sql[j + 1] !== close))
        j += sql[j] === close ? 2 : 1;
      i = j + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql.charAt(j))) j++;
      const word = sql.slice(i, j).toUpperCase();
      words.push(word);
      const trigger = words[0] === "CREATE" && words.slice(1, 4).includes("TRIGGER");
      if (trigger && (word === "BEGIN" || (depth > 0 && word === "CASE"))) depth++;
      else if (trigger && depth > 0 && word === "END") depth--;
      i = j;
    } else if (ch === ";" && depth === 0) {
      const text = sql.slice(start, i).trim();
      if (words.length > 0) statements.push(text);
      start = i + 1;
      words = [];
      i++;
    } else i++;
  }
  if (words.length > 0) statements.push(sql.slice(start).trim());
  return statements;
}

export async function applySql(db: SqlDatabase, sql: string) {
  for (const statement of splitSqlStatements(sql)) await db.prepare(statement).bind().run();
}

export const SCHEMA_LEDGER_SQL =
  "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);\n";

export async function seedUsageGuard(db: SqlDatabase, nowMs: number, action = "normal") {
  const now = new Date(nowMs).toISOString();
  await db
    .prepare(`INSERT OR REPLACE INTO usage_guard_state
    (singleton_id,action,observed_at,period_start,period_end,evidence_json,evidence_hash,
    current_percent,projected_percent,governing_metric,normal_streak,release_pending,updated_at)
    VALUES(1,?,?,?,?,'{}',?,0,0,'workerRequests',2,0,?)`)
    .bind(
      action,
      now,
      new Date(nowMs - 86_400_000).toISOString(),
      new Date(nowMs + 86_400_000).toISOString(),
      "0".repeat(64),
      now,
    )
    .run();
}

const EVENT_TITLES: Record<string, string> = {
  "solo-s42": "시즌 42",
  "solo-s43": "시즌 43",
  "maint-1": "정기 점검",
  "collab-1": "콜라보 이벤트",
};

export type SeedOptions = {
  version?: number;
  rangeShiftDays?: number;
  titles?: Record<string, string>;
  brokenPayload?: boolean;
};

const kst = (day: string, time: string) => new Date(`${day}T${time}+09:00`).toISOString();

/** Events relative to the current game day T (all in range for any 28–31 day month):
 * S42 confirmed T-6..T, S43 predicted T+15..T+21 (alternative T+22, notice T+9 17:00),
 * maintenance T+5 06:00–10:00, collaboration after that maintenance through T+32,
 * grant + open decision on T+2, co-op every Tuesday (×10 inside the collaboration). */
export function calendarFixture(nowMs: number) {
  const today = calendarRange(nowMs).start;
  const day = (offset: number) => addGameDays(today, offset);
  const events = [
    {
      id: "solo-s42",
      kind: "solo",
      status: "confirmed",
      startsAt: kst(day(-6), "12:00:00"),
      endsAt: gameDayEnd(day(0)),
      startDay: day(-6),
      endDay: day(0),
      maintenance: null,
      provenance: null,
    },
    {
      id: "solo-s43",
      kind: "solo",
      status: "predicted",
      startsAt: kst(day(15), "12:00:00"),
      endsAt: gameDayEnd(day(21)),
      startDay: day(15),
      endDay: day(21),
      maintenance: null,
      provenance: {
        intervalDays: 21,
        alternativeIntervalDays: 28,
        alternativeStartsAt: kst(day(22), "12:00:00"),
        expectedNoticeAt: kst(day(9), "17:00:00"),
      },
    },
    {
      id: "maint-1",
      kind: "maintenance",
      status: "confirmed",
      startsAt: kst(day(5), "06:00:00"),
      endsAt: kst(day(5), "10:00:00"),
      startDay: day(5),
      endDay: day(5),
      maintenance: null,
      provenance: null,
    },
    {
      id: "collab-1",
      kind: "collaboration",
      status: "confirmed",
      startsAt: kst(day(5), "10:00:00"),
      endsAt: gameDayEnd(day(32)),
      startDay: day(5),
      endDay: day(32),
      maintenance: "maint-1",
      provenance: null,
    },
  ] as const;
  const collaboration = events[3];
  return { today, day, events, collaboration };
}

export async function seedCalendar(db: SqlDatabase, nowMs: number, options: SeedOptions = {}) {
  const { day, events, collaboration } = calendarFixture(nowMs);
  const range = calendarRange(nowMs - (options.rangeShiftDays ?? 0) * 86_400_000);
  const titles = { ...EVENT_TITLES, ...options.titles };
  const created = new Date(nowMs).toISOString();
  for (const event of events)
    await db
      .prepare(`INSERT INTO forecast_v2_calendar_revisions(event_id,revision,kind,status,starts_at,
        ends_at,start_game_day,end_game_day,maintenance_event_id,maintenance_revision,
        prediction_provenance_json,source_feed_ids_json,created_at) VALUES(?,1,?,?,?,?,?,?,?,?,?,'[]',?)`)
      .bind(
        event.id,
        event.kind,
        event.status,
        event.startsAt,
        event.endsAt,
        event.startDay,
        event.endDay,
        event.maintenance,
        event.maintenance ? 1 : null,
        event.provenance ? JSON.stringify(event.provenance) : null,
        created,
      )
      .run();
  const snapshotId = `snap-${range.start}`;
  await db
    .prepare(
      "INSERT INTO forecast_v2_calendar_snapshots(snapshot_id,range_start,range_end,content_hash,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(snapshotId, range.start, range.end, "c".repeat(64), created)
    .run();
  for (let current = range.start; current <= range.end; current = addGameDays(current, 1)) {
    const linked = events.filter((event) => event.startDay <= current && event.endDay >= current);
    const tuesday = new Date(`${current}T00:00:00Z`).getUTCDay() === 2;
    const coopInstant = kst(current, "05:00:00");
    const coop = !tuesday
      ? 0
      : coopInstant >= collaboration.startsAt && coopInstant <= collaboration.endsAt
        ? 10
        : 5;
    const grants = current === day(2) ? [{ label: "점검 보상", ii: 10, box: 2 }] : [];
    const payload =
      options.brokenPayload && current === range.start
        ? { kits: { ii: -1, box: 0 }, coop: 0 }
        : {
            kits: {
              ii: coop + grants.reduce((sum, grant) => sum + grant.ii, 0),
              box: grants.reduce((sum, grant) => sum + grant.box, 0),
            },
            coop,
            grants,
            pending: current === day(2) ? ["지급일 결정 대기 · 게시글 6579018"] : [],
            titles: Object.fromEntries(linked.map((event) => [event.id, titles[event.id]])),
          };
    await db
      .prepare(
        "INSERT INTO forecast_v2_calendar_days(snapshot_id,game_day,payload_json) VALUES(?,?,?)",
      )
      .bind(snapshotId, current, JSON.stringify(payload))
      .run();
    for (const event of linked)
      await db
        .prepare(
          "INSERT INTO forecast_v2_calendar_event_links(snapshot_id,game_day,event_id,revision) VALUES(?,?,?,1)",
        )
        .bind(snapshotId, current, event.id)
        .run();
  }
  await db
    .prepare(
      "INSERT INTO forecast_v2_calendar_active(singleton,snapshot_id,version,updated_at) VALUES(1,?,?,?)",
    )
    .bind(snapshotId, options.version ?? 3, created)
    .run();
  return { snapshotId, range };
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export const encodeJson = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function createAccessKeys(kid = "test-kid") {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    jwks: { keys: [{ kty: "RSA", kid, alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] },
  };
}

export function accessClaims(nowMs: number, overrides: Record<string, unknown> = {}) {
  const seconds = Math.floor(nowMs / 1000);
  return {
    iss: TEAM_DOMAIN,
    aud: [ACCESS_AUD],
    email: ADMIN_EMAIL,
    sub: "00000000-0000-4000-8000-000000000000",
    type: "app",
    iat: seconds,
    nbf: seconds,
    exp: seconds + 600,
    ...overrides,
  };
}

export async function signAccessToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: "test-kid", typ: "JWT" },
) {
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
