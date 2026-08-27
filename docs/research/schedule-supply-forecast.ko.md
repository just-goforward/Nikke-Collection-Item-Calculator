# 일정 기반 키트 수급 Forecast 연구 계약

## 상태

- `[확인]` 기존 제품은 `supply-2026-08-21-v1`의 고정 28일 기대 수급량을 사용한다.
- `[확인]` 일정 기반 모델과 동적 Rust/WASM gain ABI는 기존 고정값을 입력했을 때 의미론을
  보존하도록 구현됐다.
- `[미검증]` 일정 기반 forecast는 staging 12시간 shadow, production smoke, 새 H/p 연구와
  별도 adoption PR을 통과하기 전에는 제품에 활성화되지 않는다.

## 계산 범위

게임 일자는 한국시간 05:00에 바뀐다. schedule profile의 `expectedGain`은 미수령 미래 재고만을
뜻하지 않고, 솔로 레이드 3일차를 기점으로 선택되는 **수급 기준 구간의 기대 총량**을 뜻한다.
04:59:59까지는 이전 게임 일자의 profile을 유지하고 정확히 05:00:00부터 다음 게임 일자의
profile과 주간 reset을 적용한다.

- 솔로 레이드 1·2일차: 사용자가 아직 키트를 사용하지 않았다고 보고, 이전 회차 3일차부터
  현재 회차의 해당 일차까지 수령 가능한 기대 수급량을 누적한다.
- 솔로 레이드 3일차부터 종료까지: 현재 게임 일자부터 이번 회차의 종료일까지와 다음 회차
  1·2일차의 기대 수급량을 합한다.
- 회차 종료 후 다음 회차 전: 현재 게임 일자부터 다음 회차 2일차까지의 기대 수급량을 합한다.

구간의 시작일과 종료일은 모두 포함한다. 따라서 profile은 1일차에서 2일차로 갈 때 증가할 수
있고, 3일차에는 기준 구간이 전환되며, 이후에는 시간이 지날수록 감소한다. 전체 profile에
단조 감소를 요구하지 않는다.

솔로 레이드 일별 기대값은 1일차 `28.8 / 2.4 / 0`, 2일차
`37.6 / 4.0 / 1.6`, 3일차 이후 매일 `42.0 / 4.8 / 2.4`다.

파견은 0회·최대 1회·최대 2회 재추첨 사용자를 각각 1/3로 혼합한다. 유지 대상은 보라
직접 보상, 노랑 직접 보상, 일반 상자 2개, 상자 II 1·2개다. 이 정책의 하루 기대값은
`8.947399682 / 2.014546824 / 0.714208160`이다. 협동작전 상점 수급은 개별 협동작전 개최
여부와 무관하게, 수급 기준 구간 안의 매주 화요일 05:00마다 상자 II 5개를 고정 반영한다.
공식 콜라보 예정 기간이 공개되면 그 기간 안에 속하는 화요일 05:00만 10개로 계산한다.
콜라보 일정이 미공개·추정·불명확한 동안에는 2배를 가정하지 않고 기본 5개를 유지한다.
공지가 바뀌면 콜라보 일정 ledger와 새 forecast revision을 통해 자동 반영한다.

이 규칙은 `schedule-kit-v2`이며, 이전 `schedule-kit-v1`의 “현재부터 다음 솔레 3일차까지의
미래 수급” 규칙과 결과를 이어 붙이지 않는다.

## 일정 증거와 승인

Naver 라운지 56·48번 게시판이 자동 판정의 주 출처다. Free Worker의 3분 Cron은 본문을
처리하지 않고 얕은 feed 메타데이터만 D1 queue에 넣는다. 5분 GitHub Actions가 구조화된
SmartEditor JSON을 다시 받아 일정 해석과 후보 생성을 수행한다. X 공개 타임라인은 후보가
있을 때만 Actions에서 공식 embed, 공개 profile, Jina Reader를 각각 한 번 확인하며 API,
비공식 RSS, 로그인 cookie를 사용하지 않는다. X를 읽을 수 없으면 관리자 확인 체크를
남기고, 일정이 충돌하면 draft PR로 격리한다.

[Defuddle](https://github.com/kepano/defuddle)은 이미 읽을 수 있는 DOM의 본문 정리 도구이며
선택적 X fallback이 FxTwitter를 사용하므로 채택하지 않는다. [Jina
Reader](https://jina.ai/reader/)는 공개 프로필 live preflight에 성공했지만 제3자
fetch/cache 중계 계층이므로 공식 일정 근거로 채택하지 않는다. `unavailable` 전의 보조
fallback으로만 사용하며, Jina 일치는 수동 원문 확인을 요구하고 Jina만으로 충돌을 만들지
않는다.

- `[확인]` 2026-08-25 live contract 검사에서 48·56번 최신 관리자 글과 솔로 레이드 공지는
  SmartEditor JSON이 아니라 SmartEditor HTML을 반환했다. 현재 JSON-only 경계는 이를
  `manual_review`로 차단하므로 안전하지만, 검토된 Actions용 구조 파서가 추가되기 전까지
  Naver 자동 candidate 생성은 활성화할 수 없다.

수집 Worker는 invocation, poll cursor, 최소 queue metadata, 검증된 일정·후보만 전용 D1에
보존한다. GitHub Actions가 같은 schema와 hash를 다시 검증해 inactive forecast PR을 만들며,
관리자의 PR 병합이 승인이다. 이 승인만으로 제품은 바뀌지 않는다. Canary v3는 12시간,
200회 이상, 완료율 99% 이상, abandoned 0건과 queue/cursor/candidate/watermark 정합성을
요구한다.

## H/p 재연구

승인된 일정 forecast는 21·28·35일 주기, 확정·추정 일정, 일반일·솔로 레이드 1·2·3일차
profile 매트릭스에 들어간다. 각 profile에서 기존 49개 H/p 격자를 재평가한다. 성공확률,
총 기대 사용량, 키트별 고갈확률, supply-debt CVaR90, typed failure와 cold/warm 지연을
기준점 `H=0.75, p=3`과 비교한다. 서로 다른 p의 `E[F_p]` 값 자체는 직접 비교하지 않는다.

Actions 연구는 profile별 report와 checkpoint를 격리해 제한된 slice만 진행하고 재개할 수
있다. 연구 report는 제품 채택 권한을 갖지 않는다. 통과 후보가 있더라도 runtime 활성화는
별도 adoption PR에서만 이뤄진다.
