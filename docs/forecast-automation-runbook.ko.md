# Forecast 자동화 운영 Runbook

현재 활성값, 미병합 후보와 재개 순서는
[Forecast 구현 상태와 재개 절차](./forecast-status.ko.md)에 날짜별 스냅샷으로 정리한다.
이 문서는 배포·장애 대응 절차를 다룬다.

## 책임 경계

- Collector는 Naver 48·56번 게시판의 얕은 메타데이터만 3분마다 수집한다.
- Dispatcher는 1·4·7분 순서의 offset Cron에서 D1 작업을 발견하고 고정된 GitHub workflow를
  호출한다. Actions의 `17,47` schedule은 30분 watchdog이다.
- Interaction Router는 Discord 서명·guild·channel·approver를 검증하고 staging 또는 production
  D1의 제한된 승인 상태만 바꾼다. GitHub key, Collector admin token, Discord bot token은 없다.
- 수집·승인·research 결과만으로 Forecast를 활성화하거나 PR을 병합하지 않는다.

## PR 검증과 Migration

- 자동 Forecast 및 staging-adoption PR은 branch push 후 `pages.yml`을 명시적으로 호출한다.
  GITHUB_TOKEN으로 만든 PR의 자동 이벤트에만 의존하지 않는다. branch namespace, 원격 SHA,
  등록된 run ID를 검증하며 수동 호출에서는 Pages 업로드·배포가 실행되지 않는다.
- `main`의 필수 검사는 `verify`, `Analyze (actions)`, `Analyze (javascript-typescript)`,
  `Analyze (rust)`, `CodeQL`이다. 각각 현재 GitHub Actions/Advanced Security 앱의 결과로
  한정하고 최신 main을 포함한 검증을 요구한다. 기존 관리자 예외 설정은 유지하지만 운영
  절차에서 실패 검사를 우회하지 않는다.
- staging/production Forecast migration은 `scripts/apply-forecast-d1-migrations.ts` 한곳에서
  파일 순서와 ledger를 확인하고 누락된 필수 버전만 적용한다. 각 파일 적용 후 ledger를 다시
  읽으며, 알 수 없는 버전·중간 누락·예상하지 않은 ledger 변화가 있으면 중단한다.
- `schema.sql`은 version 10의 신규 DB용 snapshot이다. 기존 DB에 재실행하지 않는다. runner가
  빈 저장소임을 확인한 경우에만 bootstrap하고, 기존 production의 선택적 0004..0006 누락은
  허용한다. 부분 적용이나 외부에서 바꾼 schema를 자동 복구하는 기능은 아니다.
- production migration은 기존 `cloudflare-production` 승인 job 내부에서만 실행한다.
  로컬 검증은 `node scripts/apply-forecast-d1-migrations.ts --env staging --local`을 사용한다.

## 필수 Repository 설정

Variables:

```text
FORECAST_COLLECTOR_STAGING_URL
FORECAST_COLLECTOR_PRODUCTION_URL
FORECAST_COLLECTOR_URL
FORECAST_INTERACTIONS_URL
CLOUDFLARE_USAGE_GUARD_URL
FORECAST_GITHUB_APP_ID
FORECAST_GITHUB_APP_INSTALLATION_ID
DISCORD_FORECAST_GUILD_ID
DISCORD_FORECAST_APPROVER_USER_ID
DISCORD_FORECAST_APPLICATION_ID
DISCORD_FORECAST_PUBLIC_KEY
DISCORD_FORECAST_APPROVAL_CHANNEL_ID
DISCORD_FORECAST_ALERT_CHANNEL_ID
DISCORD_FORECAST_ACTIVITY_CHANNEL_ID
DISCORD_FORECAST_FALLBACK_CHANNEL_ID
DISCORD_FORECAST_CHANNEL_ID
```

Secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_D1_ANALYTICS_TOKEN
CLOUDFLARE_BILLING_READ_TOKEN (Account > Billing > Read 전용)
FORECAST_COLLECTOR_ADMIN_TOKEN
FORECAST_GITHUB_APP_PRIVATE_KEY
DISCORD_FORECAST_BOT_TOKEN
```

GitHub App은 이 저장소 하나에만 설치하고 `Actions: write`, `Metadata: read`만 허용한다.
`DISCORD_FORECAST_APPLICATION_ID`와 `DISCORD_FORECAST_PUBLIC_KEY`는 Developer Portal 값을
등록한다. 배포 workflow는 Bot token으로 Discord API를 조회한 값과 두 변수를 대조하고,
불일치하면 Router 배포 전에 중단한다.

## Staging 배포와 Router 전환

1. 실행 중인 canary가 있으면 먼저 해당 SHA의 `canary_only=true` 결과를 보존한다.
2. migration 0009가 production Forecast D1에 아직 없으면 `Remediate Forecast D1 Indexes`를
   실행하고 `cloudflare-production` 승인을 거친다. 이 workflow는 통계 production read probe,
   covering index 생성, query-plan 검증만 수행하며 Worker를 배포하지 않는다.
3. `Deploy Forecast Collector Staging`을 `router_endpoint_ready=false`로 실행한다.
4. workflow가 전용 Usage Guard D1 schema를 적용하고 Usage Guard를 먼저 배포한다. Guard가
   Workers Paid 구독·실제 결제기간·계정 전체 Workers/D1 사용량을 확인해 `normal`을 기록해야
   이후 단계로 넘어간다.
5. staging D1 migration 0009와 양쪽 Forecast D1 covering index를 확인한 뒤 계정 전체 Paid
   preflight를 실행한다. 이후 Collector와 Dispatcher를 disabled 상태로 배포하고 Router
   readiness를 확인한다. 이 단계에서는 새 canary가 시작되지 않는다.
6. Wrangler 출력의 Router origin을 `FORECAST_INTERACTIONS_URL`에 등록한다.
7. Discord Developer Portal의 Interaction Endpoint URL을
   `${FORECAST_INTERACTIONS_URL}/discord/interactions`로 바꿔 검증을 통과시킨다.
8. `Deploy Forecast Collector Staging`을 `router_endpoint_ready=true`로 다시 실행한다.
9. activity 채널의 mutation-free Router test 버튼을 지정 approver 계정으로 누른다.
10. workflow는 통계 production D1 read probe와 계정 전체 baseline을 확인한 뒤
    Collector·Dispatcher를 활성화하고 30분 burn-in을 수행한다. 월간 결제기간을 사용하므로
    KST/UTC 자정에 맞출 필요가 없다.
11. 활성화 후 7분 live-contract probe와 30분 burn-in 뒤 재검증이 모두 통과하고, 현재·월말
    예상 사용률이 모두 25% 미만이면 독립 `canaryId`의 v10 row가 생성된다.
   실패하면 staging Collector·Dispatcher가 모두 비활성화되고 alert 채널에 직접 경고한다.

Collector의 예전 `/discord/interactions` 경로는 Router readiness가 끝난 뒤 owner 설정으로
비활성화한다. Endpoint 소유자는 동시에 두 곳이 될 수 없다.

## Manual Review

- alert 채널의 `재처리`는 queue를 `pending`, attempts 0으로 되돌린다.
- `관련 없음`은 queue를 `ignored`로 확정한다.
- 날짜·기간을 직접 확정해야 하면 카드의 workflow 링크에서 `Resolve Forecast Manual Review`를
  실행한다. 자유 JSON 대신 event type, KST 시작·종료, schedule status만 입력한다.
- production 결정은 `cloudflare-production` 승인이 필요하다.
- 동일 request ID와 payload의 재전송은 이전 결과를 반환한다. 같은 request ID에 다른 payload를
  보내면 409이며, 새 request ID로 의도를 다시 제출해야 한다.

## Workers Paid 월간 사용량 보호

이 저장소의 통계·Forecast Worker와 모든 D1은 같은 Workers Paid 계정의 월간 제공량을 공유한다.
기본 제공량은 Workers 요청 1,000만 회, CPU 3,000만 ms, D1 read 250억 행, write 5,000만 행,
저장공간 5GB다. Cloudflare는 초과 과금을 절대 차단하는 계정 기능을 제공하지 않으므로,
전용 `collection-kit-usage-guard`가 각 항목의 **50%를 프로젝트 hard cap**으로 사용한다. 나머지
50%는 계량 지연, 수동 작업, 이 계정의 다른 리소스와 비상 제어를 위한 여유다.

- Billing Read token으로 실제 Workers Paid 구독과 `current_period_start/end`를 확인한다. 토큰
  누락, 정확한 `WORKERS_PAID` 플랜 미확인, 기간 역전은 배포를 중단한다. Workers AI나 별도
  reseller/enterprise 플랜은 제공량 계약이 다르므로 자동 수용하지 않는다.
- Analytics는 계정의 모든 Worker와 D1을 합산한다. 월말 예상치는
  `누적 + max(일별 p95, 가용한 최대 6시간 환산, 기간 평균) × 남은 기간 × 2`로 계산한다.
  새 배포 직후에는 30분 burn-in부터 시작하고 표본이 쌓이면 최대 6시간 창을 사용한다.
- 25%는 경고, 35%는 staging 자동화 중단, 40%는 production Forecast 중단, 45%는 통계 POST와
  비필수 관리자 쓰기 중단, 50%는 선택적 D1/Cron hard-stop이다. 오류 응답은
  `telemetry_budget_disabled`, `retryable: false`라서 클라이언트 outbox가 재시도하지 않는다.
- 같은 결제기간에는 자동으로 낮은 단계로 복귀하지 않는다. 새 결제기간의 정상 측정을 연속
  두 번 확인한 뒤에만 latch를 해제한다.
- evidence가 45분 이상 갱신되지 않으면 production Forecast까지 중단하고, 2시간이면 hard-stop한다.
- `Watch Forecast D1 Budget`은 canary 유무와 관계없이 30분마다 독립 preflight와 Guard health를
  확인한다. 25% 경고만으로 staging을 끄지 않으며 35% 이상에서만 Collector·Dispatcher를
  disabled 상태로 재배포한다.
- watchdog의 상시 canary 확인은 D1 한 번만 읽는 `/admin/canary-window`를 사용한다. 전체 slot과
  invariant를 읽는 report는 시작 후 2·4·6시간 중간 판정과 8시간 종료 후 최종 판정에서만 만든다.
  최종 CPU p99는 서버가 기록한 `startedAt` 이상 `endsAt` 이하의 고정 구간을 별도로 조회해
  판정하므로, 반복적인 관리자 report 호출이 측정 대상을 오염시키지 않는다.
- 40% 이상이면 watchdog이 `Emergency Stop Cloudflare Automation`을 요청한다. Worker 내부 guard가
  먼저 즉시 차단하고, Cron trigger 제거는 `cloudflare-production` 승인 후에만 수행한다. 40~45%는
  production Forecast Cron을, 50% `hard_stop`은 staging Forecast와 통계 정리 Cron까지 제거한다.
  Usage Guard의 15분 Cron은 다음 결제기간 복구를 관측해야 하므로 유지한다. trigger 복구는 Guard가
  새 결제기간 정상 측정 두 번을 기록한 뒤 정상 production 배포로만 수행한다.
- 계산기와 Rust/WASM solver는 브라우저에서 계속 동작한다. 중단되는 것은 통계 기록과 Forecast
  자동 갱신이며, Cloudflare Budget Alert는 외부 알림일 뿐 이 차단 계약을 대체하지 않는다.

## Canary v10 판독

Canary는 이전 기간을 합치지 않고 `canary_runs.startedAt`부터 정확히 8시간 진행한다. Collector
`*/3`과 Dispatcher `1-59/3`의 예상 slot을 이 구간에서 생성하므로 정상적으로 Worker별 약 160개
slot을 관찰한다. 전체 구간이 현재 결제기간 안에 있어야 하며 같은 deployment SHA도 새
`canaryId`로 다시 검증할 수 있다.

통과 조건:

```text
version = 10
policyId = forecast-canary-v10-live-contract-v1
windowMode = fixed_8_hours
endsAt = startedAt + 8시간
각 Worker deliveryRate >= 99%
각 Worker completionRate >= 99%
각 Worker missingSlots <= 1
각 Worker latest status = completed
abandoned, late/unexpected/duplicate invocation, duplicate dispatch/run = 0
invalid queue/cursor/candidate/watermark/review = 0
partial schema rejection = 0
callback conflict, unsent critical alert = 0
Dispatcher smoke run과 Discord activity message >= 1
Router signed test interaction >= 1
Router duplicate = 0, initial response < 1초
모든 manual_review queue row에 pending review와 전송된 alert 존재
저장된 quota evidence hash와 계정 전체 Worker·D1 합계 일치
quota action = normal, 현재·월말 예상 사용률 < 25%
Workers Observability scheduled marker coverage >= 99%
Workers Observability CPU sample coverage >= 95%, CPU samples >= 100
모든 대상 Worker의 정확한 canary 8시간 구간에서 exceededCpu = 0, 비정상 outcome = 0
quota evidence freshness 오류 = 0
```

2시간 이후 abandoned 비율 1% 초과, missing-slot 비율 5% 초과, invariant 오류, Router 서명·권한
smoke 실패는 조기 실패다. 일시적인 slot 1개 누락만으로는 조기 실패시키지 않는다.

v10은 판정 자료의 유효성과 정책 위반을 분리한다. Wrangler가 반환한 불변 Worker Version ID를
canary row에 저장하고 Observability의 Version ID나 tag가 제공되면 대조한다. Cloudflare가 이
선택 메타데이터를 생략하면 배포 SHA·구조화 Cron marker·D1 slot의 조합으로 대조하고 경고를
남긴다. API 지연, telemetry coverage 부족, hash나 배포 신원 불일치는 `incomplete`이며 production으로
진행하지 않는다. 완전한 증거가 기능·무결성·
quota·runtime hard gate 위반을 증명할 때만 `failed`다. CPU p99가 설정 상한의 80% 이상이면
warning, 95% 이상이면 높은 등급의 warning이지만 `exceededCpu=0`이고 다른 hard gate가 정상이면
`passed_with_warning`이다. 이 상태도 workflow 성공으로 기록되지만 production 승격에는 기존
`cloudflare-production` 수동 승인이 필요하다.

Observability의 `invocations` 응답은 긴 구간에서 한 invocation의 custom marker와 runtime summary가
서로 다른 응답 페이지에 놓일 수 있다. 따라서 8시간 증거는 30분짜리 반개방 구간 16개로 조회한 뒤
request ID hash로 멱등 병합한다. 같은 invocation이 서로 다른 내용으로 반복되면 증거 충돌로 거부한다.
custom marker는 있지만 Cloudflare가 해당 invocation runtime summary를 표본화하지 않은 경우에는 전체
수집을 버리지 않는다. marker는 실행 신원 증거로 유지하고 CPU 표본만 누락으로 센다. marker coverage는
99%를 유지하며, exact-window GraphQL의 오류·CPU 초과 0건 확인을 전제로 CPU 분포는 95% 이상이면서
100개 이상의 표본이면 사용할 수 있다. 95~99%는 성능 경고로 표시하고 기준선 후보에도 표본 수와
coverage를 함께 기록한다.

Canary 시작 직전에는 UTC minute modulo 3이 2인 안전 구간에서 직전 Collector·Dispatcher 실행이 모두
완료됐는지 확인한다. 이 정렬은 canary 시작 전에 예약됐지만 Cloudflare에서 늦게 전달된 Cron을 새
window의 unexpected invocation으로 잘못 세는 경계 오류를 막는다. 종료 후 runtime evidence를 최대
30분 재조회할 수 있으므로 최종 quota evidence는 그 재조회가 끝난 뒤 새로 측정한다.

첫 v10은 이전 v8 GraphQL 집계를 hard baseline으로 사용하지 않고 scheduled-only 기준선을 만드는
`baseline_bootstrap`이다. 생성된 기준선 후보는 Actions artifact일 뿐 자동 적용되지 않는다. 별도
검토 PR로 `forecast-collector/runtime-baseline.json`을 추가한 뒤에만 이후 v10이 이를 소비한다.
승인된 기준선이 있는 경우에만 전체 p95와 평균, 독립 4시간 구간 두
개의 회귀가 모두 같은 방향으로 확인될 때 성능 hard failure로 판정한다. 종료 시 telemetry가
늦으면 5분 간격으로 최대 30분 재조회하며, 그래도 부족하면 immutable 8시간 window를
`incomplete`로 보존한다. 같은 window는 evidence만 다시 조회할 수 있지만 `failed` window는
소급 재판정하지 않는다.

`CLOUDFLARE_WORKERS_OBSERVABILITY_TOKEN`은 현재 API가 요구하는 최소 Workers Observability
권한으로 별도 repository secret에 둔다. staging Collector와 Dispatcher만 canary 동안 log head
sampling `1.0`을 사용하고 production은 기존 sampling을 유지한다.

## Production 승격

1. v10 인증 상태가 `passed` 또는 `passed_with_warning`이고 promotion 시점의 계정 전체 Paid quota
   preflight가 통과한 뒤에만
   `Promote Forecast Collector`를 실행한다.
2. `cloudflare-production` environment 승인은 관리자가 직접 수행한다.
3. workflow는 보호된 remediation에서 production migration 0009와 covering index가 검증됐는지
   다시 확인한 뒤 Router safe mode, Collector, disabled Dispatcher,
   queue/bootstrap smoke, enabled Dispatcher 순으로 진행한다.
4. 모든 smoke가 통과한 마지막 단계에서만 Router production mutation을 활성화한다.
5. 이 승격은 Forecast ID 전환, Forecast PR merge, H/p adoption을 수행하지 않는다.

## Rollback

- 일반 Dispatcher 장애는 `DISPATCH_ENABLED=false`로 되돌린다. D1 예산·통계 D1 장애에서는
  staging Collector도 `COLLECT_ENABLED=false`로 함께 중지한다.
- Collector queue·cursor·watermark, Forecast registry, 기존 승인 Forecast는 유지한다.
- 30분 Actions watchdog은 Dispatcher 비활성 기간의 제한된 fallback이다.
- Router 오류 시 production mutation을 false로 되돌리고 Discord Endpoint는 마지막 검증된 Router
  deployment로 유지한다. Collector route를 동시에 다시 켜지 않는다.
- 실패한 canary 기간은 수정 후 canary에 재사용하지 않는다.

## 로컬 검증

```powershell
npm run test:forecast-collector
npm run test:forecast-dispatcher
npm run test:forecast-interactions
npm run test:usage-guard
npm test -- scripts/d1-budget.test.ts scripts/cloudflare-paid-quota-config.test.ts scripts/forecast-dispatcher-workflow.spec.ts
npm run typecheck
npm run lint
```
