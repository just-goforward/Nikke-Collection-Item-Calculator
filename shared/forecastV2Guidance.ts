// One reason-code → (막힌 이유, 해 주실 일) table for every v2 decision reason.
// Presentation only: the codes come from the collector judges and never change
// a judgment. Unknown codes fall back to a generic but still actionable line.

export type Guidance = readonly [blocked: string, todo: string];

export const FORECAST_V2_GUIDANCE: Record<string, Guidance> = {
  maintenance_period_missing: [
    "점검 공지에서 점검 일시(시작·종료)를 읽지 못했습니다.",
    "공지의 점검 일시를 확인해 [일정 수정]으로 시작·종료를 입력해 주세요. 점검과 무관하면 [관련 없음].",
  ],
  solo_period_unresolved: [
    "솔로 레이드 진행 기간(시작·종료)을 확정하지 못했습니다.",
    "공지의 진행 기간을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 무관한 공지면 [관련 없음].",
  ],
  maintenance_missing: [
    "같은 날짜의 점검 일정을 찾지 못해 '점검 완료 후' 시각을 확정하지 못했습니다.",
    "점검 일정을 확인해 주세요. 점검 공지가 아직 없다면 잠시 기다리고, 점검이 있는데 달력에 없다면 [일정 수정]으로 직접 입력해 주세요.",
  ],
  maintenance_multiple: [
    "같은 날짜에 점검이 여러 건 있어 적용할 점검 종료 시각을 고르지 못했습니다.",
    "어느 점검 시간이 맞는지 확인한 뒤 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 달력의 중복 점검도 함께 확인해 주세요.",
  ],
  maintenance_conflict: [
    "같은 날짜에 이미 다른 점검 일정이 있어 어느 점검 시간을 달력에 남길지 확인이 필요합니다.",
    "이 공지의 점검 시간을 적용할지 기존 점검을 유지할지 버튼으로 고르고, 둘 다 아니면 [일정 수정]으로 직접 입력해 주세요.",
  ],
  collaboration_start_unresolved: [
    "콜라보 시작 시각('점검 완료 후' 등)을 확정하지 못했습니다.",
    "아래 버튼에 맞는 시작 일정이 있으면 고르고, 없으면 [일정 수정]으로 시작·종료를 직접 입력해 주세요.",
  ],
  collaboration_overlap: [
    "기존 콜라보 일정과 기간이 겹쳐 새 일정인지 같은 일정인지 확정하지 못했습니다.",
    "새 일정이면 [새 콜라보], 기존과 같으면 [기존 콜라보], 기간이 다르면 [일정 수정]으로 직접 입력, 반영할 필요가 없으면 [관련 없음]을 눌러 주세요.",
  ],
  archive_readdition: [
    "아카이브 추가 안내여서 새 콜라보 일정인지 확인하지 못했습니다.",
    "새로 등록할 콜라보면 [일정 수정]으로 시작·종료를 입력해 주세요. 기존 아카이브 안내일 뿐이면 [관련 없음].",
  ],
  grant_date: [
    "지급일 후보가 여러 개라 지급일 하나를 확정하지 못했습니다.",
    "아래 버튼에서 맞는 지급일을 골라 주세요. 후보에 없으면 공지의 지급일을 다시 확인해 주세요.",
  ],
  grant_date_precision: [
    "지급일의 시각(정밀도)을 확인하지 못했습니다.",
    "공지의 지급일·시각을 확인해 아래 버튼에서 맞는 지급일을 골라 주세요.",
  ],
  grant_quantity: [
    "같은 날 지급 수량이 이미 달력에 있는 값과 달라 별도 지급인지 정정인지 확인이 필요합니다.",
    "별도로 더 지급된 것이면 [별도 지급], 기존 수량을 고치는 것이면 [정정].",
  ],
  // apply-grants rejects every option when one feed has several prior occurrences
  // (grant_correction_target_ambiguous), so neither button can be applied.
  grant_quantity_ambiguous: [
    "이 공지의 이전 지급 기록이 여러 건이라 [별도 지급]과 [정정] 중 어느 쪽을 골라도 자동으로 반영되지 않습니다.",
    "공지의 지급일·수량을 확인해 운영자에게 알려 주세요. 버튼은 누르지 않아도 됩니다.",
  ],
  b_evidence_only: [
    "B 게시판 공지는 근거 자료일 뿐이라 자동으로 확정하지 않았습니다.",
    "추출된 일정이 맞으면 [이 일정으로 확정], 다르면 [일정 수정], 무관하면 [관련 없음].",
  ],
};

export const FALLBACK_GUIDANCE: Guidance = [
  "자동 판단을 마치지 못했습니다.",
  "공지 원문을 확인하고, 맞으면 버튼으로 확정하거나 [일정 수정]으로 직접 입력해 주세요.",
];

export function guidance(code: string | undefined): Guidance | undefined {
  return code !== undefined && Object.hasOwn(FORECAST_V2_GUIDANCE, code)
    ? FORECAST_V2_GUIDANCE[code]
    : undefined;
}
