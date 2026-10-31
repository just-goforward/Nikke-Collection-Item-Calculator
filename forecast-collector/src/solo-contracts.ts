import type { ScheduleEvent } from "./types";

type Times = {
  startsAt: string | null;
  endsAt: string | null;
  startKst: string | null;
  endKst: string | null;
};
type SegmentComparison = {
  segment: number;
  kind: string;
  startKst: string;
  endKst: string;
  rewardDays: number;
};
export type Judgment = {
  blockIndex: number;
  verdict: "no_change" | "solo" | "schedule_change" | "manual_review" | "ignored";
  reason: string | null;
  question: string;
  triggers: string[];
  blockExcerpt: string;
  maintenanceInputs: string[];
  comparison: {
    known: (Times & { eventId: string; segments?: SegmentComparison[] }) | null;
    extracted: Times | null;
    equal: boolean;
    segments?: SegmentComparison[];
    blocking?: boolean;
    exclusion?: {
      rule: "irrelevant_museum" | "modeled_past_reopen" | "grant_outside_horizon";
      contextHash: string;
    };
    grant?: {
      grantGameDate: string | null;
      kits: { law: "box-ii-v1" | "regular-box-v1"; count: number }[];
      claimUntilKst: string | null;
      claimWindowAssumed: boolean;
    };
  };
  event?: ScheduleEvent;
};
export type SoloContext = {
  known?: readonly ScheduleEvent[];
  maintenance?: readonly { text: string; publishedAt: string }[];
};
