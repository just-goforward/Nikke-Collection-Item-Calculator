# Forecast 구현 상태와 재개 절차

이 문서는 2026-09-05 KST 기준 운영 상태를 정리한 스냅샷이다. 실행 의미론의 정본은
`shared/supplyForecasts.json`, 생성 코드, Worker 코드와 테스트이며, 이 문서는 그 계약을
대체하지 않는다.

## 현재 보류 상태

Forecast 자동화 인프라는 production에 배포됐지만 제품 Forecast 전환은 보류한다. 이 문서를
작성하는 작업에서는 Forecast 후보 PR을 병합하거나, `activeForecastId`를 바꾸거나, H/p 정책을
변경하거나, Worker를 재배포하지 않는다.

| 구분 | 현재 값 | 의미 |
|---|---|---|
| 제품 활성 Forecast | `supply-2026-08-21-v1` | `legacy-28-day-v1` 고정 수급량을 제품 solver가 사용한다. |
| 레지스트리 staging/approved | `supply-2026-08-28-v1` | `schedule-kit-v2`를 staging 쿼리에서 검토할 수 있으나 제품값은 아니다. |
| 최신 미병합 후보 | PR #37, `supply-2026-09-04-v1` | 새 일정 증거로 만든 inactive 후보다. |
| 이전 미병합 후보 | PR #15, `supply-2026-09-01-v1` | PR #37보다 오래된 동일 계열 후보다. 자동 폐기하지 않았다. |
| 최신 v10 자동화 인증 | `passed_with_warning` | 기능·무결성·quota hard gate는 통과했지만 첫 scheduled-only 성능 기준선 bootstrap, Collector CPU 표본의 부분 coverage, 선택적 runtime identity 부재 경고가 남았다. |

- PR #37: <https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/37>
- PR #15: <https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/15>
- production 자동화 승격 근거: <https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/33880761235>

두 PR의 `Deploy GitHub Pages`가 `action_required`인 것은 PR에서 production Pages 배포 승인을
요구하지 않는 현재 보호 설정의 결과다. CodeQL 검사는 통과했지만, 이것만으로 Forecast 내용의
제품 채택이 승인되는 것은 아니다.

위 `passed_with_warning`은 production 승인 단계로 진행할 수 있다는 자동화 인증이지 Forecast
내용의 채택 판정이 아니다. 해당 실행만으로 `forecast-collector/runtime-baseline.json`을 정본
기준선으로 채택하지 않았으며, 기준선 갱신에는 별도 검토가 필요하다.

## 구현된 범위

### 수급 모델

- 레지스트리 version 3에서 고정 Forecast와 일정 기반 Forecast를 함께 보관한다.
- KST 05:00을 게임 일자 경계로 사용한다.
- 솔로 레이드 1·2일차와 3일차 이후의 수급 구간을 분리한다.
- 솔로 레이드 3일차부터는 현재 회차 잔여 보상과 다음 회차 2일차까지의 미래 수급을 계산한다.
- 협동작전은 매주 화요일 05:00 상자 II 5개를 기본으로 하고, 확인된 콜라보 기간에 속한
  reset만 10개로 계산한다.
- 다음 솔로 레이드 일정이 확정되지 않았을 때는 전체 회차 조사에서 얻은 28일 중앙값을
  추정 cadence로 사용한다.
- 파견은 `dispatch-policy-v1`의 0·1·2회 리롤 혼합 기대값을 사용한다.
- 모든 profile은 `forecastId`, `forecastProfileId`, rules version과 source evidence로 당시
  expected gain을 재구성할 수 있다.

### 수집과 승인 자동화

- Collector는 Naver 48·56번 게시판의 얕은 메타데이터를 3분 Cron으로 수집하고 D1 queue에
  멱등 저장한다.
- Dispatcher는 별도 offset Cron에서 pending fingerprint를 계산하고 최소 권한 GitHub App으로
  `Propose Supply Forecast`를 호출한다.
- GitHub Actions가 상세 본문, 관리자 게시물, 구조화 SmartEditor, 일정 불변식과 payload hash를
  다시 검증한 뒤 inactive Forecast PR만 생성한다.
- X/Jina는 보조 증거다. 확인 실패는 Naver 후보를 자동 기각하지 않지만 PR의 수동 확인을
  생략할 근거도 되지 않는다.
- Discord Interaction Router는 서명, application, guild, channel, approver와 action 상태를
  검증한다. 버튼은 staging 승인 또는 manual-review 상태만 바꾸며 PR merge나 production
  Forecast 활성화를 수행하지 않는다.
- manual review는 재처리, 관련 없음, GitHub workflow를 통한 일정 직접 확정으로 분리한다.

### 운영 안전장치

- Forecast D1, 통계 D1, Usage Guard D1과 staging/production binding을 분리한다.
- Workers Paid 사용량은 계정 전체 Workers와 D1을 합산하고 프로젝트 hard cap을 기본 제공량의
  50%로 둔다. 25/35/40/45/50% 단계별로 경고와 선택적 기능 중단을 적용한다.
- Collector, Dispatcher, Router readiness와 D1 schema를 배포 workflow에서 검증한다.
- v10 canary는 8시간 expected slot, D1 무결성, Discord, quota, Observability marker와 CPU
  evidence를 분리해 인증한다.
- production 승격은 `cloudflare-production` 환경의 관리자 승인을 우회할 수 없다.

### Solver 연결

- Rust min-E[f]와 Rust phase2는 동일한 Forecast context와 gain vector를 받을 수 있다.
- cache identity에는 Forecast profile 신원이 포함돼 서로 다른 수급량의 memo가 섞이지 않는다.
- dynamic H/p 연구 결과는 `researchOnly=true`, `productAdoptionAuthorized=false`를 유지한다.
- 연구 인증서나 Discord 승인만으로 제품 상수와 활성 Forecast를 바꾸지 않는다.

## 최신 후보의 미확정 사항

PR #37은 `schedule-kit-v2`, payload v3, 28일 cadence 후보지만 다음 항목은 관리자가 직접
확인해야 한다.

1. X `@NIKKE_kr`의 관련 공지와 Naver 일정이 충돌하지 않는지 확인한다. 자동 X/Jina 결과는
   `unavailable / rate_limited`다.
2. 솔로 레이드 예상 기간 `2026-09-17 12:00`부터 `2026-09-24 04:59` KST가 최신 공식
   공지와 맞는지 확인한다. 확정 공지가 없다면 예상 일정임을 유지한다.
3. 콜라보 기간 `2026-08-20 05:00`부터 `2026-09-10 04:59` KST와 기간 내 화요일
   상자 II 10개 적용을 확인한다.
4. 05:00 경계, 솔로 레이드 1·2일차 누적 구간, 3일차 전방 구간 전환의 각 profile gain을
   확인한다.

PR #15에는 확인 가능한 X 게시물 후보가 있지만 더 오래된 Forecast snapshot이다. 두 PR을 동시에
병합하지 말고, 최신 증거를 기준으로 하나를 선택한 뒤 다른 하나를 `superseded`로 정리한다.

## 재개 순서

1. PR #37의 Naver 출처, X 수동 확인, 일정과 profile 표를 검토한다.
2. PR #37을 채택할지, 새 공식 일정이 나올 때까지 보류할지 결정한다. 보류 중에는 PR #15도
   병합하지 않는다.
3. 채택 시 PR이 오직 `shared/supplyForecasts.json`과 생성된 Forecast 파일만 변경하며 기존
   `activeForecastId`를 유지하는지 확인한 뒤 inactive 상태로 병합한다.
4. 병합된 registry hash, rules version, Forecast/profile ID와 기존 exact interactive/H/p 인증서의
   identity를 대조한다. gain vector나 identity가 다르면 해당 inactive Forecast로 연구를 다시
   실행한다. 동일하면 중복 연산 없이 기존 인증서를 재사용할 수 있는지 검토한다.
5. exact interactive gate에서 SR15 성공확률, 총 기대 사용량, 키트별 고갈확률, supply-debt
   CVaR90, typed failure와 지연 기준을 확인한다.
6. 인증 결과가 제품 채택 기준을 통과한 경우에만 별도 adoption PR을 만든다. 이 PR은
   `activeForecastId` 변경과 생성 파일 diff를 명시해야 한다.
7. adoption PR을 staging에 적용해 `?statsEnv=staging` 표시, solver 전달, 통계의
   `forecastId/forecastProfileId`, 05:00 전환을 smoke한다.
8. 관리자 검토와 `cloudflare-production` 승인을 거쳐 production에 반영하고 24시간 동안
   Collector/Dispatcher, quota, solver recovery와 통계 계약을 관찰한다.
9. 채택하지 않은 후보 PR과 자동화 branch는 근거 링크를 남긴 뒤 닫거나 삭제한다.

## 보류 중 금지 사항

- `activeForecastId` 또는 H/p 상수를 직접 수정하지 않는다.
- inactive Forecast PR을 자동 merge하지 않는다.
- X/Jina 실패를 일정 불일치나 일정 일치로 단정하지 않는다.
- canary 성공을 Forecast 내용 승인으로 표현하지 않는다.
- 과거 H/p 결과를 다른 gain-vector identity에 그대로 붙이지 않는다.

운영 명령과 장애 대응은 [Forecast 자동화 운영 Runbook](./forecast-automation-runbook.ko.md)을
따른다.
