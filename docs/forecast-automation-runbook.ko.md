# Forecast 자동화 운영 Runbook

## 책임 경계

- Collector는 Naver 48·56번 게시판의 얕은 메타데이터만 3분마다 수집한다.
- Dispatcher는 1·4·7분 순서의 offset Cron에서 D1 작업을 발견하고 고정된 GitHub workflow를
  호출한다. Actions의 `17,47` schedule은 30분 watchdog이다.
- Interaction Router는 Discord 서명·guild·channel·approver를 검증하고 staging 또는 production
  D1의 제한된 승인 상태만 바꾼다. GitHub key, Collector admin token, Discord bot token은 없다.
- 수집·승인·research 결과만으로 Forecast를 활성화하거나 PR을 병합하지 않는다.

## 필수 Repository 설정

Variables:

```text
FORECAST_COLLECTOR_STAGING_URL
FORECAST_COLLECTOR_PRODUCTION_URL
FORECAST_COLLECTOR_URL
FORECAST_INTERACTIONS_URL
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
2. `Deploy Forecast Collector Staging`을 `router_endpoint_ready=false`로 실행한다.
3. workflow가 staging D1 migration 0008을 적용하고 Dispatcher를 disabled 상태로 배포한 뒤,
   Router와 Collector를 배포했는지 확인한다. 이 단계에서는 새 canary가 시작되지 않는다.
4. Wrangler 출력의 Router origin을 `FORECAST_INTERACTIONS_URL`에 등록한다.
5. Discord Developer Portal의 Interaction Endpoint URL을
   `${FORECAST_INTERACTIONS_URL}/discord/interactions`로 바꿔 검증을 통과시킨다.
6. `Deploy Forecast Collector Staging`을 `router_endpoint_ready=true`로 다시 실행한다.
7. activity 채널의 mutation-free Router test 버튼을 지정 approver 계정으로 누른다.
8. workflow가 Dispatcher를 활성화하고 서버 시각으로 canary v5 시작 row를 기록했는지 확인한다.

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

## Canary v5 판독

Canary는 이전 기간을 합치지 않은 8시간 고정 창이다. Collector `*/3`과 Dispatcher `1-59/3`의
예상 slot을 `canary_deployments.startedAt`에서 생성한다. 보통 각 Worker당 약 160개다.

통과 조건:

```text
window >= 8시간
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
```

2시간 이후 abandoned 비율 1% 초과, missing-slot 비율 5% 초과, invariant 오류, Router 서명·권한
smoke 실패는 조기 실패다. 일시적인 slot 1개 누락만으로는 조기 실패시키지 않는다.

## Production 승격

1. v5 report가 통과한 뒤에만 `Promote Forecast Collector`를 실행한다.
2. `cloudflare-production` environment 승인은 관리자가 직접 수행한다.
3. workflow는 production migration 0008, Router safe mode, Collector, disabled Dispatcher,
   queue/bootstrap smoke, enabled Dispatcher 순으로 진행한다.
4. 모든 smoke가 통과한 마지막 단계에서만 Router production mutation을 활성화한다.
5. 이 승격은 Forecast ID 전환, Forecast PR merge, H/p adoption을 수행하지 않는다.

## Rollback

- 이상 징후가 있으면 Dispatcher Cron만 `DISPATCH_ENABLED=false`로 재배포한다.
- Collector queue·cursor·watermark, Forecast registry, 기존 승인 Forecast는 유지한다.
- 30분 Actions watchdog은 Dispatcher 비활성 기간의 제한된 fallback이다.
- Router 오류 시 production mutation을 false로 되돌리고 Discord Endpoint는 마지막 검증된 Router
  deployment로 유지한다. Collector route를 동시에 다시 켜지 않는다.
- 실패한 canary 기간은 수정 후 canary에 재사용하지 않는다.
