import { extractNoticeText } from "../../solo-sections";
import { gameDay } from "./game-day";
import { type ExistingWindow, resolveMaintenance } from "./identity";
import { type GrantDateCandidate, grantDateCandidates } from "./notice-dates";
import type { Notice } from "./schedules";

export type GrantJudgment =
  | { action: "ignore" }
  | {
      action: "decision";
      reason: string;
      ii: number;
      box: number;
      candidates: GrantDateCandidate[];
    }
  | {
      action: "grant";
      ii: number;
      box: number;
      gameDay: string;
      instant: string | null;
      basis: GrantDateCandidate["basis"];
    };

/** U16: item mentions alone are insufficient without all-account distribution evidence. */
export function judgeGrant(post: Notice, maintenance: readonly ExistingWindow[]): GrantJudgment {
  const text = extractNoticeText(post.body).effective;
  if (!eligibleGrant(text)) return { action: "ignore" };
  const { ii, box } = kitQuantities(text);
  if (!ii && !box) return { action: "ignore" };
  return dateGrant(text, post.postedAt, maintenance, ii, box);
}

function eligibleGrant(text: string) {
  const generalDistribution = /전체|모든|전\s*서버/.test(text) && /우편|지급|보상/.test(text);
  const compensationMail =
    /보상/.test(text) &&
    (/메일함|우편/.test(text) ||
      /지휘관\s*여러분/.test(text) ||
      /(?:중단|진입\s*불가|오류)[^\n]*보상\s*안내/.test(text));
  return generalDistribution || compensationMail;
}

function kitQuantities(text: string) {
  let ii = 0;
  let box = 0;
  for (const match of text.matchAll(
    /관리\s*키트\s*상자\s*(II|Ⅱ)?\s*(?:[*×xX:]|\s)\s*(\d[\d,]*)/g,
  )) {
    const count = Number(match[2]!.replaceAll(",", ""));
    if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError("Invalid kit quantity");
    if (match[1]) ii += count;
    else box += count;
  }
  return { ii, box };
}

function dateGrant(
  text: string,
  postedAt: string,
  maintenance: readonly ExistingWindow[],
  ii: number,
  box: number,
): GrantJudgment {
  const candidates = grantDateCandidates(text, postedAt);
  const candidate = candidates[0]!;
  if (candidates.length !== 1)
    return { action: "decision", reason: "grant_date", ii, box, candidates };
  let instant = candidate.instant;
  if (candidate.maintenance) {
    const match = resolveMaintenance(candidate.date, maintenance);
    if ("reason" in match) return { action: "decision", reason: match.reason, ii, box, candidates };
    instant = match.endAt;
  }
  if (!instant && candidate.basis === "explicit_payment")
    return {
      action: "grant",
      ii,
      box,
      gameDay: candidate.date,
      instant: null,
      basis: candidate.basis,
    };
  if (!instant) return { action: "decision", reason: "grant_date_precision", ii, box, candidates };
  return { action: "grant", ii, box, gameDay: gameDay(instant), instant, basis: candidate.basis };
}
