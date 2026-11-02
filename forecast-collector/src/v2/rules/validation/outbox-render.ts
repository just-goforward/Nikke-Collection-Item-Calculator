import { renderForecastV2Notification } from "../../../../../shared/forecastV2Notifications";
import { hash } from "../decisions";

// Test helper: renders every outbox row exactly as forecast-dispatcher/src/v2-outbox.ts
// does (payload hash check, decision join, expected revision, idempotency key), for
// both environments, and checks each custom_id against the §3B contract.
const CUSTOM_ID = /^fv2:([sp]):(opt|bok|bedit|bno):(d_[0-9a-f]{24}):(\d+)(?::([A-Za-z0-9_-]+))?$/;

type OutboxRow = {
  outbox_id: string;
  idempotency_key: string;
  kind: "b_report" | "decision_request" | "calendar_changed" | "decision_reminder";
  decision_id: string | null;
  payload_json: string;
  payload_hash: string;
  expected_calendar_revision: number | null;
  decision_type: string | null;
};
export type RenderReport = {
  rows: number;
  kinds: Record<string, number>;
  decisionTypes: Record<string, number>;
  decisionIds: string[];
  customIds: string[];
  maxCustomIdLength: number;
  problems: string[];
};

type Payload = { decisionRequestId?: string; options?: { id: string }[] };
type Environment = "staging" | "production";
type Rendered = ReturnType<typeof renderForecastV2Notification>;

export async function renderOutbox(db: D1Database): Promise<RenderReport> {
  const rows = (
    await db
      .prepare(`SELECT o.outbox_id,o.idempotency_key,o.kind,o.decision_id,o.payload_json,o.payload_hash,
      d.expected_calendar_revision,d.type decision_type FROM forecast_v2_notification_outbox o
      LEFT JOIN forecast_v2_decision_requests d ON d.decision_id=o.decision_id ORDER BY o.created_at,o.outbox_id`)
      .all<OutboxRow>()
  ).results;
  const decisionIds = (
    await db.prepare("SELECT decision_id FROM forecast_v2_decision_requests").all<{
      decision_id: string;
    }>()
  ).results.map((row) => row.decision_id);
  const report: RenderReport = {
    rows: rows.length,
    kinds: {},
    decisionTypes: {},
    decisionIds,
    customIds: [],
    maxCustomIdLength: 0,
    problems: [],
  };
  for (const id of decisionIds)
    if (!/^d_[0-9a-f]{24}$/.test(id)) report.problems.push(`decision id not compact: ${id}`);
  for (const row of rows) await checkRow(report, row);
  return report;
}

async function checkRow(report: RenderReport, row: OutboxRow) {
  report.kinds[row.kind] = (report.kinds[row.kind] ?? 0) + 1;
  if (row.kind === "decision_request" && row.decision_type)
    report.decisionTypes[row.decision_type] = (report.decisionTypes[row.decision_type] ?? 0) + 1;
  const where = `${row.kind} ${row.outbox_id}`;
  if ((await hash(row.payload_json)) !== row.payload_hash)
    report.problems.push(`${where}: payload hash`);
  if (row.kind !== "calendar_changed" && row.expected_calendar_revision === null) {
    report.problems.push(`${where}: decision row missing (${row.decision_id})`);
    return;
  }
  const payload: Payload = JSON.parse(row.payload_json);
  for (const environment of ["staging", "production"] as const) {
    let rendered: Rendered;
    try {
      rendered = renderForecastV2Notification(row.kind, payload, {
        environment,
        expectedRevision: row.expected_calendar_revision ?? 0,
        idempotencyKey: row.idempotency_key,
      });
    } catch (error) {
      report.problems.push(`${where} ${environment}: ${String(error)}`);
      continue;
    }
    checkRendered(report, row, payload, environment, rendered);
  }
}

function checkRendered(
  report: RenderReport,
  row: OutboxRow,
  payload: Payload,
  environment: Environment,
  rendered: Rendered,
) {
  const where = `${row.kind} ${row.outbox_id}`;
  const description = rendered.embeds[0]?.description ?? "";
  if (!description || description.length > 2000)
    report.problems.push(`${where}: embed description length ${description.length}`);
  // Every approver message must say what it tried, what blocked it and what to do.
  if (row.kind !== "calendar_changed")
    for (const section of ["하려던 일:", "확인한 것:", "추측한 것:", "막힌 이유:", "해 주실 일:"])
      if (!description.includes(section)) report.problems.push(`${where}: missing ${section}`);
  // Raw ISO stamps in any common form ("T" or space separator, optional seconds).
  if (/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(description))
    report.problems.push(`${where}: raw ISO instant in message`);
  // Internal identifiers (reason/basis codes, event/decision ids) must never reach the approver.
  const visible = `${description}\n${rendered.components
    .flatMap((container) => container.components)
    .map((component) => component.label)
    .join("\n")}`;
  if (/\b[a-z]+_[a-z0-9_]+\b/.test(visible))
    report.problems.push(`${where}: internal code ${/\b[a-z]+_[a-z0-9_]+\b/.exec(visible)?.[0]}`);
  if (rendered.components.length > 5 || rendered.components.some((r) => r.components.length > 5))
    report.problems.push(`${where}: component layout`);
  const buttons = rendered.components.flatMap((r) => r.components);
  if ((row.kind === "decision_request" || row.kind === "b_report") && !buttons.length)
    report.problems.push(`${where}: no buttons`);
  for (const button of buttons) checkCustomId(report, row, payload, environment, button.custom_id);
}

function checkCustomId(
  report: RenderReport,
  row: OutboxRow,
  payload: Payload,
  environment: Environment,
  id: string,
) {
  const where = `${row.kind} ${row.outbox_id}`;
  report.customIds.push(id);
  report.maxCustomIdLength = Math.max(report.maxCustomIdLength, id.length);
  const match = CUSTOM_ID.exec(id);
  if (id.length > 100 || !match) {
    report.problems.push(`${where}: custom_id ${id} (${id.length})`);
    return;
  }
  const [, env, action, decision, revision, option] = match;
  if (env !== (environment === "staging" ? "s" : "p")) report.problems.push(`${where}: env ${id}`);
  if (decision !== payload.decisionRequestId || decision !== row.decision_id)
    report.problems.push(`${where}: decision ${id}`);
  if (Number(revision) !== row.expected_calendar_revision)
    report.problems.push(`${where}: revision ${id}`);
  if (action === "opt" && !payload.options?.some((value) => value.id === option))
    report.problems.push(`${where}: option ${id}`);
}
