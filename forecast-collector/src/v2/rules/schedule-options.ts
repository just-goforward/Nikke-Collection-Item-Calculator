import { judgeCollaboration } from "./collaboration";
import type { DecisionInput } from "./decisions";
import { collaborationEnd } from "./game-day";
import type { ExistingWindow } from "./identity";
import type { Notice } from "./schedules";

export function windowOptions(
  windows: readonly { startAt: string; endAt: string }[],
): DecisionInput["options"] {
  const unique = new Map(windows.map((window) => [`${window.startAt}/${window.endAt}`, window]));
  return [...unique.values()].map((window, i) => ({
    id: `window_${i}`,
    label: `${kst(window.startAt)} ~ ${kst(window.endAt)} (KST)`,
    ...window,
  }));
}

function kst(instant: string) {
  return new Date(Date.parse(instant) + 9 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

export function collaborationOptions(post: Notice, maintenance: readonly ExistingWindow[]) {
  const windows: { startAt: string; endAt: string }[] = [];
  const judgments = [
    judgeCollaboration(post, maintenance, []),
    ...maintenance.map((event) => judgeCollaboration(post, [event], [])),
  ];
  for (const judgment of judgments) {
    if (judgment.action === "create") windows.push(judgment);
    if (judgment.action !== "decision") continue;
    for (const startAt of judgment.candidates) {
      if (!startAt.includes("T") || !Number.isFinite(Date.parse(startAt))) continue;
      windows.push({ startAt, endAt: collaborationEnd(startAt) });
    }
  }
  return windowOptions(windows);
}

export function maintenanceConflictOptions(
  source: { startAt: string; endAt: string },
  conflicts: readonly (ExistingWindow & { revision: number })[],
): DecisionInput["options"] {
  return conflicts.flatMap((event, index) => [
    {
      id: `source_${index}`,
      // The approver picks between two calendar entries, so name the existing one
      // by its window rather than by its internal event id.
      label: `기존 점검(${kst(event.startAt)} ~ ${kst(event.endAt)})에 이 공지 시간 적용`,
      ...source,
      eventId: event.id,
      expectedRevision: event.revision,
    },
    {
      ...windowOptions([event])[0]!,
      id: `window_${index}`,
      eventId: event.id,
      expectedRevision: event.revision,
    },
  ]);
}
