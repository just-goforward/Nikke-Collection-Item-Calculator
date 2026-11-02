import { OutcomeAnalyticsError } from "../../shared/decisionOutcomeV4.ts";
import type { WorkerEnv } from "./env.ts";
import { configuredPositive } from "./outcome-handler.ts";
import { assertQuotaAllows } from "./quota-guard.ts";
import {
  RAW_READER_MAX_BYTES, RAW_READER_MAX_ROWS, RAW_READER_MAX_SUPPLY_DAYS,
  type RawCalculationPage, type RawCalculationQuery, type RawCalculationRead, type RawCalculationRequest,
} from "./stats-capability-contract.ts";

export type RawReaderEnv = {
  STATS_RAW_READER_ENABLED?: string; STATS_RAW_MAX_RESPONSE_BYTES?: string;
  STATS_RAW_MAX_ROWS?: string; STATS_RAW_MAX_QUERY_DAYS?: string;
  STATS_RAW_MAX_SLOTS?: string; STATS_RAW_MAX_IN_FLIGHT?: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
let inFlight = 0;
const COLUMNS = `f.*,r.outcome,r.attempt_count,e.legacy_settled,
  s.content_hash AS publication_content_hash,s.game_day AS public_game_day,
  s.slot_start AS public_slot_start,s.slot_end AS public_slot_end,s.projection_status`;
const JOINS = `JOIN outcome_results r ON r.report_id=f.report_id
  JOIN outcome_effects e ON e.report_id=f.report_id
  JOIN outcome_public_slots s ON s.slot_id=f.slot_id`;

function invalid(): never { throw new OutcomeAnalyticsError(400, "invalid_raw_query"); }
function inputRecord(input: unknown, allowed: readonly string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !allowed.includes(key))) invalid();
}
function requested(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
  return value;
}
function date(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) invalid();
  return parsed;
}
function configuration(env: RawReaderEnv) {
  const bytes = configuredPositive(env.STATS_RAW_MAX_RESPONSE_BYTES, RAW_READER_MAX_BYTES);
  const rows = configuredPositive(env.STATS_RAW_MAX_ROWS, RAW_READER_MAX_ROWS);
  const days = configuredPositive(env.STATS_RAW_MAX_QUERY_DAYS, RAW_READER_MAX_SUPPLY_DAYS);
  const slots = configuredPositive(env.STATS_RAW_MAX_SLOTS, 100);
  const concurrent = configuredPositive(env.STATS_RAW_MAX_IN_FLIGHT, 4);
  if (env.STATS_RAW_READER_ENABLED !== "true" || bytes === null || rows === null ||
      days === null || slots === null || concurrent === null)
    throw new OutcomeAnalyticsError(503, "raw_reader_unconfigured");
  return { bytes, rows, days, slots, concurrent };
}
async function bounded<T>(env: WorkerEnv, operation: (config: ReturnType<typeof configuration>) => Promise<T>): Promise<T> {
  const config = configuration(env);
  if (inFlight >= config.concurrent) throw new OutcomeAnalyticsError(429, "raw_reader_busy");
  inFlight++;
  try {
    await assertQuotaAllows(env, "admin_read");
    return await operation(config);
  } finally { inFlight--; }
}
function output<T>(value: T, maxBytes: number): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes)
    throw new OutcomeAnalyticsError(413, "raw_response_budget_exceeded");
  return value;
}
export function readCalculation(env: WorkerEnv, input: RawCalculationRequest): Promise<RawCalculationRead> {
  return bounded(env, async config => {
    inputRecord(input, ["calculationId", "maxBytes"]);
    if (typeof input.calculationId !== "string" || !UUID.test(input.calculationId)) invalid();
    const maxBytes = requested(input.maxBytes, config.bytes);
    const calculation = await env.DB.withSession("first-primary").prepare(
      `SELECT ${COLUMNS} FROM outcome_facts f ${JOINS} WHERE f.report_id=?`,
    ).bind(input.calculationId).first<Record<string, unknown>>();
    return output({ calculation }, maxBytes);
  });
}
export function queryCalculations(env: WorkerEnv, input: RawCalculationQuery): Promise<RawCalculationPage> {
  return bounded(env, async config => {
    inputRecord(input, ["fromGameDate", "untilGameDate", "publicationContentHash", "slotId",
      "afterCalculationId", "maxRows", "maxBytes"]);
    const from = date(input.fromGameDate), until = date(input.untilGameDate);
    if (until <= from || until - from > config.days * 86_400_000) invalid();
    const rows = requested(input.maxRows, config.rows), bytes = requested(input.maxBytes, config.bytes);
    if (input.publicationContentHash !== undefined && !HASH.test(input.publicationContentHash)) invalid();
    if (input.slotId !== undefined && !HASH.test(input.slotId)) invalid();
    if (input.afterCalculationId !== undefined && !UUID.test(input.afterCalculationId)) invalid();
    const db = env.DB.withSession("first-primary");
    const filters = ["game_day>=?", "game_day<?"];
    const bindings: unknown[] = [input.fromGameDate, input.untilGameDate];
    if (input.publicationContentHash !== undefined) { filters.push("content_hash=?"); bindings.push(input.publicationContentHash); }
    if (input.slotId !== undefined) { filters.push("slot_id=?"); bindings.push(input.slotId); }
    const slots = await db.prepare(
      `SELECT slot_id FROM outcome_public_slots WHERE ${filters.join(" AND ")} ORDER BY game_day,slot_id LIMIT ?`,
    ).bind(...bindings, config.slots + 1).all<{ slot_id: string }>();
    if (slots.results.length > config.slots) throw new OutcomeAnalyticsError(413, "raw_query_slot_budget_exceeded");
    if (input.slotId && slots.results.length === 0) throw new OutcomeAnalyticsError(404, "public_slot_not_found");
    // Per-slot indexed keyset reads are individually limited. A final global LIMIT
    // alone would permit an unbounded sort/scan of the matching private facts.
    const pages = slots.results.length ? await db.batch<Record<string, unknown>>(slots.results.map(slot => db.prepare(
      `SELECT ${COLUMNS} FROM outcome_facts f ${JOINS}
       WHERE f.slot_id=? AND f.report_id>? ORDER BY f.report_id LIMIT ?`,
    ).bind(slot.slot_id, input.afterCalculationId ?? "", rows + 1))) : [];
    const candidates = pages.flatMap(page => page.results)
      .sort((a, b) => String(a["report_id"]) < String(b["report_id"]) ? -1 : 1);
    const calculations = candidates.slice(0, rows);
    return output({
      calculations, nextCursor: candidates.length > rows ? String(calculations.at(-1)!["report_id"]) : null,
    }, bytes);
  });
}
