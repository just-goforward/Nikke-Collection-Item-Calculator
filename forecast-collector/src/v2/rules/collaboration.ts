import { extractNoticeText } from "../../solo-sections";
import {
  collaborationIdentity,
  type ExistingWindow,
  excludedCollaborationTitle,
  type IdentityJudgment,
  resolveMaintenance,
} from "./identity";
import { noticeDates } from "./notice-dates";
import type { Notice } from "./schedules";

export function judgeCollaboration(
  post: Notice,
  maintenance: readonly ExistingWindow[],
  existing: readonly ExistingWindow[],
): IdentityJudgment {
  if (excludedCollaborationTitle(post.title)) return { action: "ignore" };
  const text = extractNoticeText(post.body).effective;
  if (/아카이브\s*추가\s*안내/.test(post.title) || /아카이브에\s*추가됩니다/.test(text))
    return { action: "decision", reason: "archive_readdition", candidates: [] };
  const { starts, unresolved, dependencies } = collaborationStarts(
    text,
    post.postedAt,
    maintenance,
  );
  if (unresolved.length || starts.size > 1)
    return {
      action: "decision",
      reason: "collaboration_start_unresolved",
      candidates: [...starts, ...unresolved],
    };
  const judgment = collaborationIdentity(post.title, [...starts][0] ?? null, existing);
  const dependency = dependencies.size === 1 ? [...dependencies][0] : undefined;
  return judgment.action === "create" && dependency
    ? { ...judgment, maintenanceEventId: dependency }
    : judgment;
}

function collaborationStarts(
  text: string,
  postedAt: string,
  maintenance: readonly ExistingWindow[],
) {
  const lines = text.split("\n");
  const starts = new Set<string>();
  const unresolved: string[] = [];
  const dependencies = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      !/콜라보.*진행\s*결정|재등장\s*예정|점검\s*완료\s*후|미니\s*게임|스토리\s*이벤트|진행\s*기간/.test(
        line,
      )
    )
      continue;
    const dates = noticeDates(`${line}\n${lines[i + 1] ?? ""}`, postedAt);
    const first = dates[0];
    if (!first) continue;
    if (first.instant) starts.add(first.instant);
    else {
      const match = resolveMaintenance(first.date, maintenance);
      if ("reason" in match) unresolved.push(first.date);
      else {
        starts.add(match.endAt);
        dependencies.add(match.eventId);
      }
    }
  }
  return { starts, unresolved, dependencies };
}
