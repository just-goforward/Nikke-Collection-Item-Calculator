import { appendFile } from "node:fs/promises";
import {
  buildForecastCandidate,
  resolveSoloSchedule,
} from "../forecast-collector/src/candidate.ts";
import { fetchNaverFeedMetadata, parseScheduleEvents } from "../forecast-collector/src/naver.ts";
import type {
  ScheduleEvent,
  SourceQueueItem,
  SourceQueueResult,
} from "../forecast-collector/src/types.ts";
import { readBoundedText } from "../shared/boundedHttp.ts";
import { fetchNaverActionItem, fetchNaverActionSoloHistory } from "./forecast-naver-action.ts";

const baseUrl = requiredEnvironment("FORECAST_COLLECTOR_URL").replace(/\/$/, "");
const token = requiredEnvironment("FORECAST_COLLECTOR_ADMIN_TOKEN");
const directPoll = process.env["FORECAST_DIRECT_NAVER_POLL"] === "true";
const bootstrap = process.env["FORECAST_BOOTSTRAP_SOLO_HISTORY"] === "true";
const queueResponse =
  directPoll || bootstrap ? null : await request("/admin/source-queue?limit=20");
const queue = bootstrap
  ? await bootstrapItems()
  : directPoll
    ? await directItems()
    : parseQueue(queueResponse);

if (queue.length === 0) {
  await outputs({ queue_found: "false", candidate_created: "false" });
  console.log("No forecast source item is pending.");
  process.exit(0);
}

const ledger = parseLedger(await request("/admin/schedule-ledger"));
const results: SourceQueueResult[] = [];
for (const queued of queue) results.push(await processItem(queued));

const newEvents = results.flatMap((result) => (result.event ? [result.event] : []));
const combinedEvents = deduplicateEvents([...ledger.events, ...newEvents]);
let candidate:
  | {
      eventId: string;
      gameDay: string;
      revision: number;
      envelope: Awaited<ReturnType<typeof buildForecastCandidate>>;
    }
  | undefined;
if (
  newEvents.some((event) => !event.manualReview) &&
  !hasUnresolvedScheduleChange(combinedEvents)
) {
  const resolved = resolveSoloSchedule(combinedEvents, Date.now());
  if (resolved) {
    const envelope = await buildForecastCandidate(
      resolved,
      combinedEvents,
      { status: "x_unavailable", sourceItem: null, reason: "github_actions_advisory_pending" },
      Date.now(),
      ledger.nextRevision,
    );
    candidate = {
      eventId:
        resolved.scheduleStatus === "estimated"
          ? (resolved.evidenceEvents.at(-1)?.eventId ?? resolved.event.eventId)
          : resolved.event.eventId,
      gameDay: ledger.gameDay,
      revision: ledger.nextRevision,
      envelope,
    };
  }
}

const processResponse = await request("/admin/source-queue/process", {
  method: "POST",
  body: JSON.stringify({
    mode: directPoll || bootstrap ? "bootstrap" : "queue",
    results,
    candidate,
  }),
  headers: { "content-type": "application/json" },
});
if (!isRecord(processResponse) || typeof processResponse["processed"] !== "number") {
  throw new Error("Collector returned an invalid queue-processing response.");
}
await outputs({
  queue_found: "true",
  candidate_created: String(processResponse["candidateCreated"] === true),
});
console.log(JSON.stringify(processResponse));

async function processItem(queued: SourceQueueItem): Promise<SourceQueueResult> {
  if (!queued.official) return baseResult(queued, "ignored", "not_official_manager");
  try {
    const boardId = queued.source === "naver-board-48" ? 48 : 56;
    const item = await fetchNaverActionItem(boardId, queued.itemId);
    if (!item) return baseResult(queued, "ignored", "no_relevant_keyword");
    if (!item.official || !item.structured) {
      return { ...baseResult(queued, "manual_review", "source_contract_failed"), item };
    }
    const events = await parseScheduleEvents([item]);
    const event = events[0];
    if (!event) return { ...baseResult(queued, "ignored", "no_schedule_event"), item };
    return {
      ...baseResult(queued, event.manualReview ? "manual_review" : "processed", event.reason),
      item,
      event,
    };
  } catch (error) {
    const errorCode = sanitizeErrorCode(error);
    const disposition = queueErrorDisposition(errorCode);
    if (disposition === "fatal") throw error;
    return baseResult(queued, disposition, errorCode);
  }
}

async function directItems() {
  const pages = await Promise.all([fetchNaverFeedMetadata(48), fetchNaverFeedMetadata(56)]);
  if (pages.some((page) => page.unknownRejected.length > 0)) {
    throw new Error("naver_partial_schema_drift");
  }
  return pages
    .flatMap((page) => page.items)
    .map(
      (item): SourceQueueItem => ({
        ...item,
        status: "pending",
        attempts: 0,
        errorCode: null,
      }),
    );
}

async function bootstrapItems() {
  return (await fetchNaverActionSoloHistory()).map(
    (item): SourceQueueItem => ({
      source: item.source as "naver-board-56",
      itemId: item.itemId,
      url: item.url,
      title: item.title,
      publishedAt: item.publishedAt,
      official: item.official,
      status: "pending",
      attempts: 0,
      errorCode: null,
    }),
  );
}

function baseResult(
  item: SourceQueueItem,
  outcome: SourceQueueResult["outcome"],
  errorCode: string | null,
): SourceQueueResult {
  return {
    source: item.source,
    itemId: item.itemId,
    outcome,
    ...(errorCode ? { errorCode } : {}),
  };
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await readBoundedText(response, 1_100_000, "collector_response_too_large");
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text.slice(0, 240)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("collector_response_invalid_json");
  }
}

function parseQueue(value: unknown): SourceQueueItem[] {
  if (!isRecord(value) || !Array.isArray(value["items"])) throw new Error("Invalid source queue.");
  return value["items"] as SourceQueueItem[];
}

function parseLedger(value: unknown): {
  gameDay: string;
  nextRevision: number;
  events: ScheduleEvent[];
} {
  if (
    !isRecord(value) ||
    typeof value["gameDay"] !== "string" ||
    typeof value["nextRevision"] !== "number" ||
    !Array.isArray(value["events"])
  ) {
    throw new Error("Invalid schedule ledger.");
  }
  return value as ReturnType<typeof parseLedger>;
}

function deduplicateEvents(events: readonly ScheduleEvent[]) {
  return [...new Map(events.map((event) => [event.eventId, event])).values()];
}

function hasUnresolvedScheduleChange(events: readonly ScheduleEvent[]) {
  const latestSolo = events
    .filter((event) => event.eventType === "solo")
    .sort(
      (left, right) =>
        Date.parse(right.sourceItem.publishedAt) - Date.parse(left.sourceItem.publishedAt),
    )[0];
  return events.some(
    (event) =>
      event.eventType === "schedule_change" &&
      event.manualReview &&
      (!latestSolo ||
        Date.parse(event.sourceItem.publishedAt) >= Date.parse(latestSolo.sourceItem.publishedAt)),
  );
}

async function outputs(values: Record<string, string>) {
  const path = process.env["GITHUB_OUTPUT"];
  if (!path) return;
  await appendFile(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value.replace(/[\r\n]/g, " ")}`)
      .join("\n")}\n`,
  );
}

function sanitizeErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : "unknown";
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

function queueErrorDisposition(
  errorCode: string,
): Extract<SourceQueueResult["outcome"], "retry" | "manual_review"> | "fatal" {
  if (
    errorCode === "naver_timeout" ||
    errorCode === "naver_network" ||
    errorCode === "naver_http_429" ||
    /^naver_http_5\d\d$/.test(errorCode)
  ) {
    return "retry";
  }
  if (
    errorCode === "naver_unstructured_body" ||
    errorCode === "naver_http_404" ||
    errorCode.startsWith("naver_detail_")
  ) {
    return "manual_review";
  }
  return "fatal";
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
