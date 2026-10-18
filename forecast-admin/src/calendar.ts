/** Read model of the active calendar snapshot (plan §3B: active → snapshot → days/event links
 * → revisions). The page has exactly one SQL text, with no parameters; nothing from the
 * request can reach SQL.
 *
 * Day payload contract (`forecast_v2_calendar_days.payload_json`, written by the collector
 * projection):
 *   {
 *     "kits": { "ii": int >= 0, "box": int >= 0 },        // game-day total incl. co-op
 *     "coop": 0 | 5 | 10,                                  // co-op shop box II on this day
 *     "grants"?: [{ "label": string, "ii": int, "box": int }],  // notice grants this day
 *     "pending"?: [string],                                // open decisions / notes
 *     "titles"?: { "<event_id>": string }                  // display titles of linked events
 *   }
 * Prediction provenance (`forecast_v2_calendar_revisions.prediction_provenance_json`), all
 * optional: { intervalDays, alternativeIntervalDays, alternativeStartsAt, expectedNoticeAt }.
 */
type Statement = { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> };
type ReadSession = { prepare(sql: string): Statement };
export type ReadDatabase = { withSession(constraint: "first-primary"): ReadSession };

export type EventKind = "solo" | "collaboration" | "maintenance";
export type EventStatus = "confirmed" | "predicted" | "pending" | "cancelled";
type Provenance = {
  intervalDays?: number;
  alternativeIntervalDays?: number;
  alternativeStartsAt?: string;
  expectedNoticeAt?: string;
};
export type CalendarEvent = {
  eventId: string;
  revision: number;
  kind: EventKind;
  status: EventStatus;
  startsAt: string | null;
  endsAt: string | null;
  startGameDay: string | null;
  endGameDay: string | null;
  afterMaintenance: boolean;
  provenance: Provenance | null;
  title: string | null;
};
type CalendarDay = {
  gameDay: string;
  kits: { ii: number; box: number };
  coop: 0 | 5 | 10;
  grants: { label: string; ii: number; box: number }[];
  pending: string[];
  eventIds: string[];
};
export type ActiveCalendar = {
  version: number;
  updatedAt: string;
  snapshotId: string;
  rangeStart: string;
  rangeEnd: string;
  createdAt: string;
  days: Map<string, CalendarDay>;
  events: Map<string, CalendarEvent>;
};

const MAX_ROWS = 4_000;
const ACTIVE_CALENDAR_SQL = `SELECT a.version,a.updated_at,s.snapshot_id,s.range_start,s.range_end,
  s.created_at AS snapshot_created_at,d.game_day,d.payload_json,
  r.event_id,r.revision,r.kind,r.status,r.starts_at,r.ends_at,r.start_game_day,r.end_game_day,
  r.maintenance_event_id,r.prediction_provenance_json
  FROM forecast_v2_calendar_active a
  JOIN forecast_v2_calendar_snapshots s ON s.snapshot_id=a.snapshot_id
  LEFT JOIN forecast_v2_calendar_days d ON d.snapshot_id=s.snapshot_id
  LEFT JOIN forecast_v2_calendar_event_links l ON l.snapshot_id=d.snapshot_id AND l.game_day=d.game_day
  LEFT JOIN forecast_v2_calendar_revisions r ON r.event_id=l.event_id AND r.revision=l.revision
  WHERE a.singleton=1
  ORDER BY d.game_day,r.starts_at,r.event_id
  LIMIT ${MAX_ROWS + 1}`;

type Row = {
  version: number;
  updated_at: string;
  snapshot_id: string;
  range_start: string;
  range_end: string;
  snapshot_created_at: string;
  game_day: string | null;
  payload_json: string | null;
  event_id: string | null;
  revision: number | null;
  kind: string | null;
  status: string | null;
  starts_at: string | null;
  ends_at: string | null;
  start_game_day: string | null;
  end_game_day: string | null;
  maintenance_event_id: string | null;
  prediction_provenance_json: string | null;
};

class CalendarDataError extends Error {}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: readonly string[] = ["solo", "collaboration", "maintenance"];
const STATUSES: readonly string[] = ["confirmed", "predicted", "pending", "cancelled"];
const MAX_TEXT = 200;

function fail(code: string): never {
  throw new CalendarDataError(code);
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const label = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
const instant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const optionalDay = (value: unknown) =>
  value === null || (typeof value === "string" && DAY.test(value));
const optionalInstant = (value: unknown) => value === null || instant(value);

function parseJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail(code);
  }
}

function parseDay(gameDay: string, payloadJson: string) {
  const payload = parseJson(payloadJson, "day_payload_json");
  if (!record(payload) || !record(payload["kits"])) fail("day_payload_shape");
  const kits = payload["kits"];
  const coop = payload["coop"];
  if (!count(kits["ii"]) || !count(kits["box"]) || (coop !== 0 && coop !== 5 && coop !== 10))
    fail("day_payload_kits");
  const grants = payload["grants"] ?? [];
  const pending = payload["pending"] ?? [];
  const titles = payload["titles"] ?? {};
  if (
    !Array.isArray(grants) ||
    !grants.every((g) => record(g) && label(g["label"]) && count(g["ii"]) && count(g["box"])) ||
    !Array.isArray(pending) ||
    !pending.every(label) ||
    !record(titles) ||
    !Object.values(titles).every(label)
  )
    fail("day_payload_items");
  const day: CalendarDay = {
    gameDay,
    kits: { ii: Number(kits["ii"]), box: Number(kits["box"]) },
    coop,
    grants: grants.map((g) => ({
      label: String(g["label"]),
      ii: Number(g["ii"]),
      box: Number(g["box"]),
    })),
    pending: pending as string[],
    eventIds: [],
  };
  return { day, titles: titles as Record<string, string> };
}

function parseProvenance(text: string | null): Provenance | null {
  if (text === null) return null;
  const value = parseJson(text, "provenance_json");
  if (!record(value)) fail("provenance_shape");
  const provenance: Provenance = {};
  for (const key of ["intervalDays", "alternativeIntervalDays"] as const) {
    const days = value[key];
    if (days === undefined) continue;
    if (!Number.isSafeInteger(days) || Number(days) <= 0 || Number(days) > 400)
      fail("provenance_days");
    provenance[key] = Number(days);
  }
  for (const key of ["alternativeStartsAt", "expectedNoticeAt"] as const) {
    const at = value[key];
    if (at === undefined) continue;
    if (!instant(at)) fail("provenance_instant");
    provenance[key] = at;
  }
  return provenance;
}

function parseEvent(row: Row): CalendarEvent {
  if (
    !label(row.event_id) ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) <= 0 ||
    !KINDS.includes(String(row.kind)) ||
    !STATUSES.includes(String(row.status)) ||
    !optionalInstant(row.starts_at) ||
    !optionalInstant(row.ends_at) ||
    !optionalDay(row.start_game_day) ||
    !optionalDay(row.end_game_day)
  )
    fail("revision_shape");
  return {
    eventId: row.event_id,
    revision: Number(row.revision),
    kind: row.kind as EventKind,
    status: row.status as EventStatus,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    startGameDay: row.start_game_day,
    endGameDay: row.end_game_day,
    afterMaintenance: row.maintenance_event_id !== null,
    provenance: parseProvenance(row.prediction_provenance_json),
    title: null,
  };
}

/** Returns null when no calendar has been activated; throws on any inconsistent data. */
export async function readActiveCalendar(db: ReadDatabase): Promise<ActiveCalendar | null> {
  const { results } = await db.withSession("first-primary").prepare(ACTIVE_CALENDAR_SQL).all<Row>();
  const first = results[0];
  if (!first) return null;
  if (results.length > MAX_ROWS) fail("too_many_rows");
  if (
    !Number.isSafeInteger(first.version) ||
    first.version <= 0 ||
    !label(first.snapshot_id) ||
    !DAY.test(String(first.range_start)) ||
    !DAY.test(String(first.range_end)) ||
    !instant(first.snapshot_created_at) ||
    !instant(first.updated_at)
  )
    fail("snapshot_shape");
  const calendar: ActiveCalendar = {
    version: first.version,
    updatedAt: first.updated_at,
    snapshotId: first.snapshot_id,
    rangeStart: first.range_start,
    rangeEnd: first.range_end,
    createdAt: first.snapshot_created_at,
    days: new Map(),
    events: new Map(),
  };
  let titles: Record<string, string> = {};
  for (const row of results) {
    if (row.game_day === null) continue;
    if (!DAY.test(row.game_day) || row.payload_json === null) fail("day_shape");
    let day = calendar.days.get(row.game_day);
    if (!day) {
      const parsed = parseDay(row.game_day, row.payload_json);
      day = parsed.day;
      titles = parsed.titles;
      calendar.days.set(row.game_day, day);
    }
    if (row.event_id === null) continue;
    // A link to a missing revision is a broken snapshot, never silently dropped.
    if (row.kind === null) fail("revision_missing");
    const event = parseEvent(row);
    const known = calendar.events.get(event.eventId);
    if (known && known.revision !== event.revision) fail("revision_conflict");
    const stored = known ?? event;
    stored.title ??= titles[event.eventId] ?? null;
    calendar.events.set(stored.eventId, stored);
    day.eventIds.push(stored.eventId);
  }
  return calendar;
}
