# 일정 기반 키트 수급 Forecast 연구 계약

## 상태

- `[확인]` 기존 제품은 `supply-2026-08-21-v1`의 고정 28일 기대 수급량을 사용한다.
- `[확인]` 일정 기반 모델과 동적 Rust/WASM gain ABI는 기존 고정값을 입력했을 때 의미론을
  보존하도록 구현됐다.
- `[미검증]` 일정 기반 forecast는 고정 8시간 staging shadow, production smoke, 새 H/p 연구와
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
처리하지 않고 얕은 feed 메타데이터만 D1 queue에 넣는다. 3분 offset Dispatcher가 actionable
work를 발견하면 proposal workflow를 요청하며, `17,47` Actions schedule은 30분 watchdog으로만
남는다. Actions가 구조화된 SmartEditor JSON을 다시 받아 일정 해석과 후보 생성을 수행한다.
X 검증은 후보가 있을 때만
Actions에서 실행한다. `X_API_BEARER_TOKEN`이 있으면 공식 recent search를 1차로 사용하고,
`from:NIKKE_kr`·솔로 레이드/콜라보/협동작전/키트 상자 키워드·최대 10건으로 범위를
제한한다. 응답의 author expansion이 `NIKKE_kr`임을 확인한 게시물만 사용한다. 솔로 레이드와
콜라보는 후보 일정과 자동 비교하고, 협동작전·키트 상자는 정확한 URL을 수동 확인 후보로만
전달한다. API가 없거나 실패하면 공개 프로필 원본에서
status ID를 찾고 X의 구조화된 `tweet-result` 응답으로 ID·작성자·본문·시각을 재검증한다.
그다음 profile syndication의 `__NEXT_DATA__`, 마지막으로 Jina Reader를 확인한다. X를 읽을 수
없으면 관리자 확인 체크를 남기고, 공식 API 또는 X 구조화 응답에서 확인한 일정이 충돌하면
draft PR로 격리한다.

[Defuddle](https://github.com/kepano/defuddle)은 이미 알고 있는 URL이나 접근 가능한 DOM을
Markdown으로 정리하는 데는 쓸 수 있지만, 차단되거나 불완전한 프로필에서 최신 status URL을
안정적으로 발견하지는 못한다. 선택적 X fallback도 FxTwitter를 사용한다. 2026-08-28 live
검사에서도 알려진 개별 status와 프로필 본문은 읽었지만, 개별 status 결과에 주변 timeline
본문이 섞였고 프로필 Markdown에서는 원본에 있던 status URL 5개를 보존하지 못했다. 따라서
발견·기계 검증 단계에는 넣지 않으며, 공식 API/구조화 응답이 이미 제공하는 본문을 다시 손실
변환하는 용도로도 추가하지 않는다. [Jina
Reader](https://jina.ai/reader/)는 제3자 fetch/cache 중계이므로 마지막 보조
경로로만 사용한다. status Snowflake로 최신성을 검사하고, Jina 일치는 수동 원문 확인을
요구하며 Jina만으로 충돌을 만들지 않는다.

문서화된 API 계약에 기반한 1차 URL 발견에는 GitHub repository secret
`X_API_BEARER_TOKEN`이 필요하다. X
Developer Console에서는 recent search 읽기만 가능한 앱과 소액 prepaid 한도·알림을 사용하고,
게시·DM·계정 관리 권한은 주지 않는다. secret이 없어도 검증된 공개 프로필 경로로 자동
발견을 시도하지만, 비문서화 경로의 rate limit이나 형식 변경 시 Discord/PR 수동 확인으로
강등된다. `npm run
probe:forecast-x`는 token이나 원문을 출력하지 않고 공급자별 건수·사유·첫 URL·시각만 점검한다.

- `[확인]` 2026-08-28 live probe에서 공개 프로필 HTML의 status ID 5개를 찾았고,
  `tweet-result`로 5개 모두의 `NIKKE_kr` 작성자·본문·시각을 검증했다. 같은 시각 timeline
  syndication과 Jina는 rate limit이었다. 따라서 무자격증명 경로는 프로필 ID + 개별 구조화
  검증을 우선하고, 나머지는 장애 격리용 fallback으로 둔다.

- `[확인]` 2026-08-25 live contract 검사에서 48·56번 최신 관리자 글과 솔로 레이드 공지는
  SmartEditor JSON이 아니라 SmartEditor HTML을 반환했다. 현재 JSON-only 경계는 이를
  `manual_review`로 차단하므로 안전하지만, 검토된 Actions용 구조 파서가 추가되기 전까지
  Naver 자동 candidate 생성은 활성화할 수 없다.

수집 Worker는 invocation, poll cursor, 최소 queue metadata, 검증된 일정·후보만 전용 D1에
보존한다. GitHub Actions가 같은 schema와 hash를 다시 검증해 inactive forecast PR을 만들며,
관리자의 PR 병합이 승인이다. 이 승인만으로 제품은 바뀌지 않는다. Canary v7은 독립
`canaryId`와 서버가 기록한 시작 시각부터 고정 8시간 동안의 Collector·Dispatcher 예상 Cron slot을 생성한다. 두 Worker 모두 전달률과
완료율 99% 이상, 누락 slot 최대 1개, 최신 상태 completed, abandoned·late·unexpected·중복
0건이어야 한다.
queue/cursor/candidate/watermark/manual-review 정합성, Dispatcher smoke와 서명된 Router smoke도
함께 통과해야 한다. production·staging Forecast D1의 covering index를 먼저 검증한 뒤, 시작 전
30분 burn-in과 실행 중 30분 watchdog은 같은 Cloudflare 계정의 모든 Worker와 D1을 합산한다.
Workers Paid 월간 제공량의 25% 미만에서만 canary를 시작하며, 35/40/45/50% 단계별 guard가
staging, production Forecast, 통계 write, 선택적 D1/Cron을 차례로 중단한다.

Canary가 통과하면 staging의 공식 일정 원장을 다시 처리해 inactive forecast PR을 만든다.
H/p Actions는 그 PR의 코드를 checkout하거나 실행하지 않고, GitHub Actions bot이 만든 비-draft
PR인지와 변경 파일이 registry 2개뿐인지 확인한 뒤 `shared/supplyForecasts.json`만 commit SHA로
추출한다. 따라서 관리자가 PR을 병합하기 전에도 후보 수급 profile의 exact interactive gate와
H/p 연구를 시작할 수 있다. 완료된 exact-gate 인증서가 있으면 Discord 버튼은 staging 적용
승인만 기록한다. 별도 Actions가 인증서를 다시 확인해 staging adoption PR을 만들지만, PR을
병합하거나 제품 `activeForecastId`를 변경하지 않는다. 관리자가 Adoption PR을 병합하고 Pages
배포가 끝나면 registry v3의 `stagingForecastId`와 전용 경량 runtime 모듈이 갱신된다. 따라서
같은 정적 사이트의 `?statsEnv=staging` 요청은 승인된 임시 forecast를 사용하고, 쿼리가 없는
실서비스 요청은 계속 `activeForecastId`를 사용한다. 별도 forecast staging Worker는 운영하지
않는다.

## H/p 재연구

승인된 일정 forecast는 21·28·35일 주기, 확정·추정 일정, 일반일·솔로 레이드 1·2·3일차
profile 매트릭스에 들어간다. 각 profile에서 기존 49개 H/p 격자를 재평가한다. 성공확률,
총 기대 사용량, 키트별 고갈확률, supply-debt CVaR90, typed failure와 cold/warm 지연을
기준점 `H=0.75, p=3`과 비교한다. 서로 다른 p의 `E[F_p]` 값 자체는 직접 비교하지 않는다.

Actions 연구는 profile별 report와 checkpoint를 격리해 제한된 slice만 진행하고 재개할 수
있다. 미완료 profile이 있으면 기본 최대 24개 bounded workflow generation(0부터 23까지) 안에서
자동 재개하고, 모든 exact gate가 끝난 경우에만 최종 통합 summary를 만든다. 설정한 상한에 먼저
도달하면 bounded-incomplete 진단 인증 자료를 생성한 뒤 fail-closed로 종료한다. 연구 report는
제품 채택 권한을 갖지 않는다. 통과 후보가 있더라도 runtime 활성화는 별도 adoption PR에서만
이뤄진다.

동일한 `blue/purple/yellow expectedGain` 벡터는 SHA-256 identity로 묶어 한 번만 계산한다.
날짜·확정 상태·forecast profile ID가 달라도 gain 벡터가 같으면 원 profile은 evidence alias로
모두 보존되고, 후보 집계에서는 고유 벡터 한 건으로만 센다. 중복 profile의 기존 결과가 서로
다르면 이를 숨기지 않고 인증서 생성을 실패시킨다. 최종 exact-gate artifact는 solver WASM,
rules version, 후보 격자, screening/exact 시나리오 집합의 hash와 고유 gain별 결과 hash를 포함해
90일간 보존한다. 이 artifact에는 통합 summary와 profile matrix뿐 아니라 고유 gain vector별
canonical profile report 원문을 하나씩 포함한다. 따라서 날짜별 evidence alias 80개를 유지하면서
동일 gain 결과 파일은 중복 저장하지 않고, 요약 해시가 가리키는 판정 원문도 같은 보존 기간 동안
재검증할 수 있다.

GitHub Free의 표준 hosted-runner 동시 job 한도 20개를 research matrix에 모두 사용한다. 이 한도는
계정 단위이므로 연구 중 다른 CI·배포 job은 runner가 반환될 때까지 queue에 남을 수 있다. 구형
workflow가 이미 만든 continuation은 checkpoint 집합을 바꾸지 않도록 deduplication을 끈 상태로
끝내고, 새 generation-0 캠페인부터 `gain-vector-v1`을 적용한다.
