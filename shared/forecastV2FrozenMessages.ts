// Goldens copied verbatim from the pre-split renderer (commit 6d51486).
//
// Every entry records the exact embed description and button set that renderer produced.
// The refactor that split the renderer into `compose` + per-kind bodies must not change
// one byte of output, so these strings are stored, not recomputed — a regression shows up
// as a diff against a frozen expectation rather than as agreement with the new code.
//
// Regenerating them would defeat the purpose: only do it when a message change is intended.

export type FrozenMessage = {
  name: string;
  kind: "decision_request" | "decision_reminder" | "b_report" | "calendar_changed";
  payload: unknown;
  expected: {
    description: string;
    buttons?: { label: string; custom_id: string }[];
  };
};

export const frozenMessages: FrozenMessage[] = [
  {
    name: "request:grant_date:bare",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "grant_date",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [{ id: "a", label: "오늘" }],
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 보상 지급일 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 지급일 후보를 아래 버튼으로 모았습니다.\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 아래 버튼에서 맞는 지급일을 골라 주세요. 후보에 없으면 공지의 지급일을 다시 확인해 주세요.\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "오늘", custom_id: "fv2:s:opt:one:7:a" }],
    },
  },
  {
    name: "request:grant_date:guess",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "grant_date",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [{ id: "a", label: "오늘" }],
      expiresAt: "2026-11-01T00:00:00Z",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 보상 지급일 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 지급일 후보가 여러 개라 지급일 하나를 확정하지 못했습니다.\n👉 해 주실 일: 아래 버튼에서 맞는 지급일을 골라 주세요. 후보에 없으면 공지의 지급일을 다시 확인해 주세요.\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "오늘", custom_id: "fv2:s:opt:one:7:a" }],
    },
  },
  {
    name: "reminder:grant_date:bare",
    kind: "decision_reminder",
    payload: { decisionRequestId: "one", type: "grant_date" },
    expected: {
      description:
        "🔎 결정 대기 알림\n하려던 일: 보상 지급일 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
    },
  },
  {
    name: "reminder:grant_date:guess",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "grant_date",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 보상 지급일 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 자동 판단을 마치지 못했습니다.\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.\n만료 11/01(일) 09:00 KST",
    },
  },
  {
    name: "reminder:grant_date:quarter",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "grant_date",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-11-27T07:00:00Z" },
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      expiresAt: "2026-11-01T00:00:00Z",
      reason: "collaboration_overlap",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 보상 지급일 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 11/27(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 기존 콜라보 일정과 기간이 겹쳐 새 일정인지 같은 일정인지 확정하지 못했습니다.\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.\n만료 11/01(일) 09:00 KST",
    },
  },
  {
    name: "request:grant_quantity:bare",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "grant_quantity",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [{ id: "a", label: "오늘" }],
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 지급 수량 확인\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 지급일 후보를 아래 버튼으로 모았습니다.\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 별도로 더 지급된 것이면 , 기존 수량을 고치는 것이면 .\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "오늘", custom_id: "fv2:s:opt:one:7:a" }],
    },
  },
  {
    name: "request:grant_quantity:guess",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "grant_quantity",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [{ id: "a", label: "오늘" }],
      expiresAt: "2026-11-01T00:00:00Z",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 지급 수량 확인\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 같은 날 지급 수량이 이미 달력에 있는 값과 달라 별도 지급인지 정정인지 확인이 필요합니다.\n👉 해 주실 일: 별도로 더 지급된 것이면 , 기존 수량을 고치는 것이면 .\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "오늘", custom_id: "fv2:s:opt:one:7:a" }],
    },
  },
  {
    name: "reminder:grant_quantity:bare",
    kind: "decision_reminder",
    payload: { decisionRequestId: "one", type: "grant_quantity" },
    expected: {
      description:
        "🔎 결정 대기 알림\n하려던 일: 지급 수량 확인\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
    },
  },
  {
    name: "reminder:grant_quantity:guess",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "grant_quantity",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 지급 수량 확인\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 자동 판단을 마치지 못했습니다.\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.\n만료 11/01(일) 09:00 KST",
    },
  },
  {
    name: "reminder:grant_quantity:quarter",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "grant_quantity",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-11-27T07:00:00Z" },
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      expiresAt: "2026-11-01T00:00:00Z",
      reason: "collaboration_overlap",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 지급 수량 확인\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 11/27(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 기존 콜라보 일정과 기간이 겹쳐 새 일정인지 같은 일정인지 확정하지 못했습니다.\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.\n만료 11/01(일) 09:00 KST",
    },
  },
  {
    name: "request:solo_review:bare",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "solo_review",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [],
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 솔로 레이드 일정 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 공지의 진행 기간을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 무관한 공지면 [관련 없음].\n만료 11/01(일) 09:00 KST",
      buttons: [
        { label: "일정 수정", custom_id: "fv2:s:bedit:one:7" },
        { label: "관련 없음", custom_id: "fv2:s:bno:one:7" },
      ],
    },
  },
  {
    name: "request:solo_review:guess",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "solo_review",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [],
      expiresAt: "2026-11-01T00:00:00Z",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 솔로 레이드 일정 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 솔로 레이드 진행 기간(시작·종료)을 확정하지 못했습니다.\n👉 해 주실 일: 공지의 진행 기간을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 무관한 공지면 [관련 없음].\n만료 11/01(일) 09:00 KST",
      buttons: [
        { label: "일정 수정", custom_id: "fv2:s:bedit:one:7" },
        { label: "관련 없음", custom_id: "fv2:s:bno:one:7" },
      ],
    },
  },
  {
    name: "reminder:solo_review:bare",
    kind: "decision_reminder",
    payload: { decisionRequestId: "one", type: "solo_review" },
    expected: {
      description:
        "🔎 결정 대기 알림\n하려던 일: 솔로 레이드 일정 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
    },
  },
  {
    name: "reminder:solo_review:guess",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "solo_review",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 솔로 레이드 일정 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 자동 판단을 마치지 못했습니다.\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.\n만료 11/01(일) 09:00 KST",
    },
  },
  {
    name: "reminder:solo_review:quarter",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "solo_review",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-11-27T07:00:00Z" },
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      expiresAt: "2026-11-01T00:00:00Z",
      reason: "collaboration_overlap",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 솔로 레이드 일정 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 11/27(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 기존 콜라보 일정과 기간이 겹쳐 새 일정인지 같은 일정인지 확정하지 못했습니다.\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.\n만료 11/01(일) 09:00 KST",
    },
  },
  {
    name: "request:collaboration:bare",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "collaboration",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [],
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 콜라보 일정 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 아래 버튼에 맞는 시작 일정이 있으면 고르고, 없으면 [일정 수정]으로 시작·종료를 직접 입력해 주세요.\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "일정 수정", custom_id: "fv2:s:bedit:one:7" }],
    },
  },
  {
    name: "request:collaboration:guess",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "collaboration",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [],
      expiresAt: "2026-11-01T00:00:00Z",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 콜라보 일정 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 콜라보 시작 시각('점검 완료 후' 등)을 확정하지 못했습니다.\n👉 해 주실 일: 아래 버튼에 맞는 시작 일정이 있으면 고르고, 없으면 [일정 수정]으로 시작·종료를 직접 입력해 주세요.\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "일정 수정", custom_id: "fv2:s:bedit:one:7" }],
    },
  },
  {
    name: "reminder:collaboration:bare",
    kind: "decision_reminder",
    payload: { decisionRequestId: "one", type: "collaboration" },
    expected: {
      description:
        "🔎 결정 대기 알림\n하려던 일: 콜라보 일정 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
    },
  },
  {
    name: "reminder:collaboration:guess",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "collaboration",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 콜라보 일정 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 자동 판단을 마치지 못했습니다.\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.\n만료 11/01(일) 09:00 KST",
    },
  },
  {
    name: "reminder:collaboration:quarter",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "collaboration",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-11-27T07:00:00Z" },
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      expiresAt: "2026-11-01T00:00:00Z",
      reason: "collaboration_overlap",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 콜라보 일정 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 11/27(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 기존 콜라보 일정과 기간이 겹쳐 새 일정인지 같은 일정인지 확정하지 못했습니다.\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.\n만료 11/01(일) 09:00 KST",
    },
  },
  {
    name: "request:maintenance:bare",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "maintenance",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [],
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 점검 일정 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 공지의 점검 일시를 확인해 [일정 수정]으로 시작·종료를 입력해 주세요. 점검과 무관하면 .\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "일정 수정", custom_id: "fv2:s:bedit:one:7" }],
    },
  },
  {
    name: "request:maintenance:guess",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "maintenance",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [],
      expiresAt: "2026-11-01T00:00:00Z",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 점검 일정 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 점검 공지에서 점검 일시(시작·종료)를 읽지 못했습니다.\n👉 해 주실 일: 공지의 점검 일시를 확인해 [일정 수정]으로 시작·종료를 입력해 주세요. 점검과 무관하면 .\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "일정 수정", custom_id: "fv2:s:bedit:one:7" }],
    },
  },
  {
    name: "reminder:maintenance:bare",
    kind: "decision_reminder",
    payload: { decisionRequestId: "one", type: "maintenance" },
    expected: {
      description:
        "🔎 결정 대기 알림\n하려던 일: 점검 일정 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
    },
  },
  {
    name: "reminder:maintenance:guess",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "maintenance",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 점검 일정 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 자동 판단을 마치지 못했습니다.\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.\n만료 11/01(일) 09:00 KST",
    },
  },
  {
    name: "reminder:maintenance:quarter",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "maintenance",
      guess: { startAt: "2026-10-23T02:00:00Z", endAt: "2026-11-27T07:00:00Z" },
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      expiresAt: "2026-11-01T00:00:00Z",
      reason: "collaboration_overlap",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 점검 일정 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 11/27(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: 기존 콜라보 일정과 기간이 겹쳐 새 일정인지 같은 일정인지 확정하지 못했습니다.\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.\n만료 11/01(일) 09:00 KST",
    },
  },
  {
    name: "request:longTitle",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "grant_date",
      feedIds: [1],
      title:
        "가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [{ id: "a", label: "오늘" }],
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 보상 지급일 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 지급일 후보를 아래 버튼으로 모았습니다.\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 아래 버튼에서 맞는 지급일을 골라 주세요. 후보에 없으면 공지의 지급일을 다시 확인해 주세요.\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "오늘", custom_id: "fv2:s:opt:one:7:a" }],
    },
  },
  {
    name: "request:longUrl",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "grant_date",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1?pad=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      options: [{ id: "a", label: "오늘" }],
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 @​everyone \\*\\*공지\\*\\*\n하려던 일: 보상 지급일 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 지급일 후보를 아래 버튼으로 모았습니다.\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 아래 버튼에서 맞는 지급일을 골라 주세요. 후보에 없으면 공지의 지급일을 다시 확인해 주세요.\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "오늘", custom_id: "fv2:s:opt:one:7:a" }],
    },
  },
  {
    name: "request:manyItems",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "grant_date",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [{ id: "a", label: "오늘" }],
      expiresAt: "2026-11-01T00:00:00Z",
      confirmed: ["확인 0", "확인 1", "확인 2", "확인 3", "확인 4", "확인 5"],
      guessed: ["후보 0", "후보 1", "후보 2", "후보 3", "후보 4", "후보 5"],
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 보상 지급일 확정\n✅ 확인한 것: 확인 0 · 확인 1 · 확인 2 · 확인 3 · 확인 4 · 확인 5\n🤔 추측한 것: 읽은 후보 후보 0 · 후보 1 · 후보 2 · 후보 3 · 후보 4 · 후보 5\n❌ 막힌 이유: 지급일 후보가 여러 개라 지급일 하나를 확정하지 못했습니다.\n👉 해 주실 일: 아래 버튼에서 맞는 지급일을 골라 주세요. 후보에 없으면 공지의 지급일을 다시 확인해 주세요.\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "오늘", custom_id: "fv2:s:opt:one:7:a" }],
    },
  },
  {
    name: "request:blockedBrackets",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "grant_date",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [{ id: "a", label: "오늘" }],
      expiresAt: "2026-11-01T00:00:00Z",
      blocked: "[없는 버튼]과 [일정 수정] 안내",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 보상 지급일 확정\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 지급일 후보를 아래 버튼으로 모았습니다.\n❌ 막힌 이유: [없는 버튼]과 [일정 수정] 안내\n👉 해 주실 일: 아래 버튼에서 맞는 지급일을 골라 주세요. 후보에 없으면 공지의 지급일을 다시 확인해 주세요.\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "오늘", custom_id: "fv2:s:opt:one:7:a" }],
    },
  },
  {
    name: "request:legacy",
    kind: "decision_request",
    payload: {
      decisionRequestId: "one",
      type: "grant_date",
      feedIds: [1],
      title: "@everyone **공지**",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      options: [{ id: "a", label: "오늘" }],
      expiresAt: "2026-11-01T00:00:00Z",
    },
    expected: {
      description:
        "🔎 [@​everyone \\*\\*공지\\*\\*](https://game.naver.com/lounge/nikke/board/detail/1)\n하려던 일: 보상 지급일 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 지급일 후보를 아래 버튼으로 모았습니다.\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 아래 버튼에서 맞는 지급일을 골라 주세요. 후보에 없으면 공지의 지급일을 다시 확인해 주세요.\n만료 11/01(일) 09:00 KST",
      buttons: [{ label: "오늘", custom_id: "fv2:s:opt:one:7:a" }],
    },
  },
  {
    name: "reminder:minimal",
    kind: "decision_reminder",
    payload: { decisionRequestId: "one" },
    expected: {
      description:
        "🔎 결정 대기 알림\n하려던 일: 결정 대기 중인 요청 확인\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
    },
  },
  {
    name: "reminder:noType",
    kind: "decision_reminder",
    payload: { decisionRequestId: "one" },
    expected: {
      description:
        "🔎 결정 대기 알림\n하려던 일: 결정 대기 중인 요청 확인\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
    },
  },
  {
    name: "reminder:legacy",
    kind: "decision_reminder",
    payload: { decisionRequestId: "one", type: "collaboration" },
    expected: {
      description:
        "🔎 결정 대기 알림\n하려던 일: 콜라보 일정 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
    },
  },
  {
    name: "reminder:longUrl",
    kind: "decision_reminder",
    payload: {
      decisionRequestId: "one",
      type: "collaboration",
      url: "https://game.naver.com/lounge/nikke/board/detail/1?pad=yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
    },
    expected: {
      description:
        "🔎 결정 대기 알림\n하려던 일: 콜라보 일정 확정\n✅ 확인한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n🤔 추측한 것: 이전 형식의 요청이라 세부 근거가 저장되지 않았습니다\n❌ 막힌 이유: 이전 형식의 요청이라 막힌 이유가 저장되지 않았습니다\n👉 해 주실 일: 원래 결정 요청 메시지에서 버튼을 눌러 처리해 주세요.",
    },
  },
  {
    name: "b:none",
    kind: "b_report",
    payload: {
      feedId: 1,
      title: "중단",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      postedAt: "2026-11-01T00:00:00Z",
      decisionRequestId: "one",
      extracted: { segments: [], kits: [] },
    },
    expected: {
      description:
        "🔎 [중단](https://game.naver.com/lounge/nikke/board/detail/1) · 게시 11/01(일) 09:00\n하려던 일: B 게시판의 일정 변경 근거를 달력에 반영할지 확인\n✅ 확인한 것: 확정에 쓸 수 있는 항목을 찾지 못했습니다\n🤔 추측한 것: 공지에서 구간을 읽지 못해 직접 입력이 필요합니다.\n❌ 막힌 이유: B 게시판 공지는 근거 자료일 뿐이라 자동으로 확정하지 않았습니다.\n👉 해 주실 일: 공지의 변경 구간을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 근거가 무관하면 [관련 없음].",
      buttons: [
        { label: "일정 수정", custom_id: "fv2:s:bedit:one:7" },
        { label: "관련 없음", custom_id: "fv2:s:bno:one:7" },
      ],
    },
  },
  {
    name: "b:complete",
    kind: "b_report",
    payload: {
      feedId: 1,
      title: "중단",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      postedAt: "2026-11-01T00:00:00Z",
      decisionRequestId: "one",
      extracted: { segments: [{ kind: "suspend" }], kits: [] },
      decision: { complete: true, startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
    },
    expected: {
      description:
        "🔎 [중단](https://game.naver.com/lounge/nikke/board/detail/1) · 게시 11/01(일) 09:00\n하려던 일: B 게시판의 일정 변경 근거를 달력에 반영할지 확인\n✅ 확인한 것: 중단: 시각 미확정\n🤔 추측한 것: 이 일정(10/23(금) 11:00 ~ 10/23(금) 16:00)으로 하면 될까요?\n❌ 막힌 이유: B 게시판 공지는 근거 자료일 뿐이라 자동으로 확정하지 않았습니다.\n👉 해 주실 일: 추출한 일정이 맞으면 [이 일정으로 확정], 다르면 [일정 수정]으로 직접 입력, 근거가 무관하면 [관련 없음].",
      buttons: [
        { label: "이 일정으로 확정", custom_id: "fv2:s:bok:one:7" },
        { label: "일정 수정", custom_id: "fv2:s:bedit:one:7" },
        { label: "관련 없음", custom_id: "fv2:s:bno:one:7" },
      ],
    },
  },
  {
    name: "b:incomplete",
    kind: "b_report",
    payload: {
      feedId: 1,
      title: "중단",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      postedAt: "2026-11-01T00:00:00Z",
      decisionRequestId: "one",
      extracted: { segments: [{ kind: "suspend" }], kits: [] },
      decision: { complete: false, startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
    },
    expected: {
      description:
        "🔎 [중단](https://game.naver.com/lounge/nikke/board/detail/1) · 게시 11/01(일) 09:00\n하려던 일: B 게시판의 일정 변경 근거를 달력에 반영할지 확인\n✅ 확인한 것: 중단: 시각 미확정\n🤔 추측한 것: 읽은 구간: 중단: 시각 미확정\n❌ 막힌 이유: B 게시판 공지는 근거 자료일 뿐이라 자동으로 확정하지 않았습니다.\n👉 해 주실 일: 공지의 변경 구간을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 근거가 무관하면 [관련 없음].",
      buttons: [
        { label: "일정 수정", custom_id: "fv2:s:bedit:one:7" },
        { label: "관련 없음", custom_id: "fv2:s:bno:one:7" },
      ],
    },
  },
  {
    name: "b:dozens",
    kind: "b_report",
    payload: {
      feedId: 1,
      title: "중단",
      url: "https://game.naver.com/lounge/nikke/board/detail/1",
      postedAt: "2026-11-01T00:00:00Z",
      decisionRequestId: "one",
      extracted: {
        segments: [
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
          { kind: "suspend" },
        ],
        kits: [],
      },
      decision: { complete: false, startAt: "2026-10-23T02:00:00Z", endAt: "2026-10-23T07:00:00Z" },
    },
    expected: {
      description:
        "🔎 [중단](https://game.naver.com/lounge/nikke/board/detail/1) · 게시 11/01(일) 09:00\n하려던 일: B 게시판의 일정 변경 근거를 달력에 반영할지 확인\n✅ 확인한 것: 중단: 시각 미확정 · 중단: 시각 미확정 · 중단: 시각 미확정 · 중단: 시각 미확정 · 중단: 시각 미확정 · 중단: 시각 미확정 · 외 64건\n🤔 추측한 것: 읽은 구간: 중단: 시각 미확정 / 중단: 시각 미확정 / 중단: 시각 미확정 / 중단: 시각 미확정 / 중단: 시각 미확정 / 중단: 시각 미확정 / 중단: 시각 미확정 / 중단: 시각 미확정 / 중단: 시각 미확정 / 중단: 시각 미확정 / 중단: 시각 미확정 / 중단: 시각 미확…\n❌ 막힌 이유: B 게시판 공지는 근거 자료일 뿐이라 자동으로 확정하지 않았습니다.\n👉 해 주실 일: 공지의 변경 구간을 확인해 [일정 수정]으로 시작·종료를 직접 입력해 주세요. 근거가 무관하면 [관련 없음].",
      buttons: [
        { label: "일정 수정", custom_id: "fv2:s:bedit:one:7" },
        { label: "관련 없음", custom_id: "fv2:s:bno:one:7" },
      ],
    },
  },
  {
    name: "cal:none",
    kind: "calendar_changed",
    payload: {
      snapshotId: "s1",
      revision: 2,
      adminUrl: "https://forecast-admin-staging.nikkecollection.com/?rev=8#gd-2026-10-18",
      changes: [],
    },
    expected: {
      description:
        "🗓 달력 변경 (rev 2)\n• 의미 있는 변경 없음\n\n[달력 보기](https://forecast-admin-staging.nikkecollection.com/?rev=2#gd-2026-10-18)",
    },
  },
  {
    name: "cal:changes",
    kind: "calendar_changed",
    payload: {
      snapshotId: "s1",
      revision: 9,
      adminUrl: "https://forecast-admin-staging.nikkecollection.com/?rev=8#gd-2026-10-18",
      changes: [
        { kind: "solo", label: "솔로 1", change: "added", after: "2026-10-18" },
        {
          kind: "collaboration",
          label: "콜라보",
          change: "changed",
          before: '{"startAt":"2026-10-23T02:00:00Z","endAt":"2026-10-23T07:00:00Z"}',
          after: '{"startAt":"2026-10-23T02:00:00Z","endAt":"2026-10-23T07:00:00Z"}',
        },
        {
          kind: "grant",
          label: "2026-10-18",
          change: "added",
          after: '{"gameDay":"2026-10-18","ii":3,"box":4}',
        },
        { kind: "maintenance", label: "점검", change: "removed", before: "plain label" },
      ],
    },
    expected: {
      description:
        "🗓 달력 변경 (rev 9)\n• 추가 [솔로] 솔로 1: 없음 → 2026-10-18\n• 변경 [콜라보] 콜라보: 10/23(금) 11:00 ~ 10/23(금) 16:00 → 10/23(금) 11:00 ~ 10/23(금) 16:00\n• 추가 [지급] 10/18(일): 없음 → 10/18(일) 관리 키트 II 3 · 상자 4\n• 삭제 [점검] 점검: plain label → 없음\n\n[달력 보기](https://forecast-admin-staging.nikkecollection.com/?rev=9#gd-2026-10-18)",
    },
  },
  {
    name: "cal:longLabel",
    kind: "calendar_changed",
    payload: {
      snapshotId: "s1",
      revision: 2,
      adminUrl: "https://forecast-admin-staging.nikkecollection.com/?rev=8#gd-2026-10-18",
      changes: [
        {
          kind: "grant",
          label:
            "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          change: "changed",
          before: "1",
          after: "2",
        },
      ],
    },
    expected: {
      description:
        "🗓 달력 변경 (rev 2)\n• 변경 [지급] xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…(생략)\n[달력 보기](https://forecast-admin-staging.nikkecollection.com/?rev=2#gd-2026-10-18)",
    },
  },
];
