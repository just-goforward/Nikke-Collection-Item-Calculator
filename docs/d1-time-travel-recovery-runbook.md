# D1 Time Travel 복구 런북

## 범위·승인·근거

이 문서는 실행 승인이 아니다. DB 복구, writer 중지·배포·재개, SQL 검증,
GitHub Actions 제어에는 정확한 대상과 비용·중단 기준을 포함한 별도 운영 승인이 필요하다.
문서 작성 과정에서는 Wrangler, SQL, 원격 조회, 복구를 실행하지 않았다.

- **공식 사실:** 아래 Cloudflare 문서의 플랫폼 계약. 승인된 계획에서 제공한
  2026-04-21 갱신 문서를 기준으로 한다.
- **저장소 사실:** `next`의 `0a76a77` 설정·스키마·운영 문서 기준이다.
  설정 파일은 실제 배포 상태나 현재 Workers Paid 가입 상태를 증명하지 않는다.
- **운영 권고:** 차단·drain·검증·재개 순서는 이 서비스의 안전한 복구를 위한 절차다.
  실제 계정과 배포 상태가 다르면 중단하고 대상 목록부터 갱신한다.

## 1. 공식 Time Travel 계약

출처:

- [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

두 문서의 기준 갱신일은 **2026-04-21**이다.

| 항목 | 공식 사실 |
| --- | --- |
| 활성화·비용 | 항상 활성화되며 추가 비용이 없다. 별도의 애플리케이션 쿼리·운영 작업까지 무료라는 뜻은 아니다. |
| Workers Paid 보존 | 최근 30일 안의 어느 분으로든 복구할 수 있다. |
| Bookmark | 특정 DB의 시점을 식별하는 복구 토큰이다. DB 이름·ID·UTC 시각과 함께 보관하며 다른 DB에 재사용하지 않는다. |
| 조회 | `wrangler d1 time-travel info <DB> [--timestamp=...]`: 현재 또는 지정 시점의 bookmark를 확인한다. |
| 복구 | `wrangler d1 time-travel restore <DB> --bookmark=...` 또는 `--timestamp=...`. 둘 중 하나를 선택한다. |
| 영향 | 같은 DB 전체를 **in-place로 덮어쓰며 진행 중 쿼리를 취소**한다. 일부 테이블 복원이나 merge가 아니다. |
| Undo | restore는 복구 직전 bookmark를 출력한다. 이전 bookmark도 계속 유효하지만 보존 기간 안에서 사용해야 한다. |
| 제한 | DB당 10분에 최대 10회 복구. clone/fork 기능이 아니다. |

쿼리 취소는 애플리케이션·Actions의 재시도나 외부 전달까지 취소하지 않는다.
따라서 플랫폼의 취소 동작에 의존하지 말고 writer를 먼저 차단·drain한다.

## 2. DB ID별 인벤토리

아래 표의 Worker 약칭은 실제 이름을 뜻한다.

- C / C-S: `collection-kit-forecast-collector` / `collection-kit-forecast-collector-staging`
- D / D-S: `collection-kit-forecast-dispatcher` / `collection-kit-forecast-dispatcher-staging`
- R / R-S: `collection-kit-forecast-interactions` / `collection-kit-forecast-interactions-staging`
- T / T-S: `collection-kit-stats` / `collection-kit-stats-staging`
- O / O-S: `collection-kit-stats-observer` / `collection-kit-stats-observer-staging`
- G: `collection-kit-usage-guard`
- S-S: `collection-kit-site-staging`
- P-S / P-L: `collection-kit-personal-data-staging` / `collection-kit-personal-data-local`

`W`는 쓰기 가능한 업무 경로를 가진 소비자이며 읽기도 수행할 수 있다.
`R`은 해당 DB의 읽기 소비자다. D1 바인딩 자체가 읽기 전용 권한을 강제한다는 뜻은 아니다.
Actions·관리 스크립트가 Worker API 또는 직접 SQL로 수행하는 쓰기도 별도로 차단한다.

| DB 이름 / ID | 환경·중요도 | 모든 바인딩 소비자와 분류 |
| --- | --- | --- |
| `collection-kit-forecast-collector` / `2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853` | 운영 / 높음 | W: C `FORECAST_DB`, D `FORECAST_DB`, R `PRODUCTION_FORECAST_DB` |
| `collection-kit-forecast-collector-staging` / `49b5dc06-37ae-4245-896c-daea98562ed8` | staging / 높음 | W: C-S `FORECAST_DB`, D-S `FORECAST_DB`, R **`STAGING_FORECAST_DB`**, R-S `STAGING_FORECAST_DB`; R: S-S **`FORECAST_DB`** |
| `collection-kit-usage-guard` / `49b7f966-f4e8-4c2d-8453-279415737054` | 운영·staging 공유 / 매우 높음 | W: G `GUARD_DB`; R: C, C-S, D, D-S, R, R-S, T, T-S, S-S의 `USAGE_GUARD_DB`, O와 O-S의 `GUARD_DB`. CI schema/quota 갱신도 writer |
| `collection-kit-stats` / `3e18385a-af83-4c67-83a0-ab889149692c` | 운영 / 높음 | W: T `DB`; R: O `STATS_DB` |
| `collection-kit-stats-staging` / `95f4029b-669a-4e1e-a192-5c094e659e33` | staging / 중간 | W: T-S `DB`; R: O-S `STATS_DB` |
| `collection-kit-stats-observer` / `9f998d5d-06e9-407a-8fbf-748f697ee25f` | 운영 / 중간 | W: O `OBSERVER_DB` |
| `collection-kit-stats-observer-staging` / `1452b096-7828-4759-8043-e48e8363a62b` | staging / 중간 | W: O-S `OBSERVER_DB` |
| `collection-kit-personal-data-staging` / `ac5ecc1c-6c6b-43e8-b5c9-82af4e25f989` | staging / 매우 높음 | W: P-S `PERSONAL_DB` |
| `collection-kit-privacy-control-staging` / `dcee0896-ee5c-4e0f-b5c8-e4632963e2e1` | staging / 삭제 권위 | W: P-S `PRIVACY_CONTROL_DB` |
| `collection-kit-public-aggregate-staging` / `343d3046-4da4-4836-ae72-d914dc9a6349` | staging / 높음 | W: P-S `PUBLIC_AGGREGATE_DB` |
| `personal-data-local` / `local-personal-only` | 로컬 placeholder / 원격 대상 아님 | W: P-L `PERSONAL_DB` |
| `privacy-control-local` / `local-privacy-only` | 로컬 placeholder / 원격 대상 아님 | W: P-L `PRIVACY_CONTROL_DB` |
| `public-aggregate-local` / `local-public-only` | 로컬 placeholder / 원격 대상 아님 | W: P-L `PUBLIC_AGGREGATE_DB` |

중요도는 운영 권고 분류다. 다음 설정을 근거로 소비자를 묶었다:

- `forecast-collector/wrangler.toml`, `forecast-dispatcher/wrangler.toml`
- `forecast-interactions/wrangler.toml`, `forecast-interactions/staging.wrangler.toml`
- `usage-guard/wrangler.toml`, `cloudflare/wrangler.toml`, `stats-observer/wrangler.toml`
- `site-worker/wrangler.toml`: staging에만 Forecast·Guard 바인딩
- `site-worker/production.wrangler.toml`: D1 바인딩 없음
- `site-worker/personal-data-staging.wrangler.json`: `env.staging`에 실제 staging ID 세 개
- `personal-data/wrangler.toml`: 의도적으로 유효하지 않은 원격 ID 세 개

운영 Router 설정도 staging Forecast DB에 쓰기 접근한다. staging 전용 Router만
중지해서는 staging 쓰기 차단이 완료되지 않는다. site staging은 Forecast 읽기 소비자다.

## 3. 실행 전 대상·복원 지점 고정

프로젝트 루트의 Windows PowerShell을 사용한다. 아래 명령은 별도 승인 후 운영자가
실행하는 예시이며, 자동 실행 스크립트가 아니다.

1. 승인 기록에 계정 ID, DB 이름·UUID, 환경, config 경로, 실행자, 시간창,
   목표 UTC 시각, 예상 데이터 손실 구간, 쿼리·요청 예산, 중단 기준을 기록한다.
2. 배포 Worker 버전·설정과 모든 writer, 실행 중 Actions, 외부 효과를 확인한다.
3. 장애 이전의 마지막 정상 상태를 독립 증거로 선택한다. 배포 직전이라는 이유만으로
   정상이라고 가정하지 않는다. timestamp는 UTC ISO-8601 `Z` 형식으로 고정한다.
4. Workers Paid 보존 기간 안인지 확인한다. 오래된 bookmark는 영구 백업이 아니다.
5. 현재 bookmark를 먼저 확보하고 승인된 보호 위치에 원문·DB ID·UTC를 보관한다.

```powershell
# Forecast staging: 이름, config, 환경을 항상 함께 명시한다.
node .\node_modules\wrangler\bin\wrangler.js d1 time-travel info collection-kit-forecast-collector-staging --config .\forecast-collector\wrangler.toml --env staging

# 복원 후보 시각의 bookmark 확인: placeholder를 승인된 UTC로 교체한다.
node .\node_modules\wrangler\bin\wrangler.js d1 time-travel info collection-kit-forecast-collector-staging --timestamp="<승인된-UTC-시각>" --config .\forecast-collector\wrangler.toml --env staging

# 운영 Forecast는 최상위 설정이다. --env production을 사용하지 않는다.
node .\node_modules\wrangler\bin\wrangler.js d1 time-travel info collection-kit-forecast-collector --config .\forecast-collector\wrangler.toml --env=
```

운영 Stats도 `--config .\cloudflare\wrangler.toml --env=`로 최상위를 명시한다.
staging Stats는 같은 config에 `--env staging`을 사용한다.
전용 staging Router config의 최상위는 `--env=`이고, 개인정보 staging JSON은
**전용 파일이어도 `--env staging`이 필요**하다. 파일 이름만으로 환경을 추정하지 않는다.
어떤 명령에서도 config·환경 생략으로 운영 기본값을 선택하지 않는다.

**대상 선택의 기준은 승인 기록의 DB 이름+UUID다.** 명령의 위치 인수 `<DB>`가
대상을 선택하며 config·env는 그 이름/바인딩 해석을 돕는다. staging 예시를 복사해서
`--config`나 `--env`만 바꿔도 위치 인수의 DB 이름은 바뀌지 않는다.
실행 전 위치 인수와 해석된 UUID가 승인 기록에 모두 일치하는지 확인한다.

## 4. DB별 writer 차단·drain

플래그 변경은 배포 승인이 필요하다. 로컬 파일 변경이나 새 버전 배포 성공만으로
기존 isolate·진행 중 요청·미확정 D1 쓰기가 종료되었다고 판단하지 않는다.
확실한 drain 증거가 없으면 복원하지 않는다.

### Forecast

- 대상 Collector: `COLLECT_ENABLED=false`, `RUNTIME_INGESTION_ENABLED=false`.
- 대상 Dispatcher: `DISPATCH_ENABLED=false`, `PUBLICATION_MODE=off`.
- Router: 대상 환경의 `STAGING_PUBLICATION_MODE=off` 또는
  `PRODUCTION_PUBLICATION_MODE=off`. 운영은 `PRODUCTION_MUTATIONS_ENABLED=false`도 확인한다.
  staging은 공용 R과 전용 R-S를 모두 처리한다.
- 플래그로 막히지 않는 admin·legacy approval·Discord·callback 진입점도 차단한다.
  `PRODUCTION_MUTATIONS_ENABLED=false`는 staging 전체 차단 스위치가 아니다.
- Collector `*/3 * * * *`, Dispatcher `1-59/3 * * * *` 예약 실행과 이미 시작한
  invocation을 중지·drain한다. 플래그로 남은 쓰기 경로까지 차단되는지 확인한다.
- proposal watchdog, adoption/manual-review, deploy/migration, callback을 포함한
  GitHub Actions의 신규 실행을 막고 진행 중 실행·재시도를 처리한다.
- staging 유지보수 중 `FORECAST_STAGING_AUTO_REDEPLOY=disabled`를 별도 승인으로 설정한다.
  이는 writer 중지 스위치가 아니며 이미 실행 중인 배포도 종료하지 않는다.
- `docs/hosting-cutover-p1-runbook.md`에 따라 이 변수는 **Usage Guard 배포·schema 적용·
  quota refresh를 중지하지 않는다**. 보호된 운영 안전 제어를 무력화하지 않는다.
- site staging의 runtime Forecast 제공을 격리하여 복원 중 pointer를 노출하지 않는다.

### Stats·Observer

통계 이벤트 쓰기 ingress, Stats 일일 cron `17 3 * * *`, 대상 Observer cron
`7,37 * * * *`, 진행 중 요청·Actions를 차단·drain한다.
Observer DB는 알림 상태를 포함하므로 복구 후 이미 보낸 알림을 다시 보낼 수 있다.
Stats는 집계 누락·중복 가능성을 독립 baseline 및 이벤트 처리 계약과 대조한다.
서로 다른 DB의 복구는 **원자적 다중 DB 복구가 아니다**.

### 공용 Usage Guard — 일반 복구·훈련에서 제외

`collection-kit-usage-guard`는 운영과 staging이 공유한다. Forecast 또는 Stats의
일상 복구에 묶어 복원하지 않으며 staging 훈련에서도 제외한다.

별도 Guard 복구 승인은 **모든 소비자의 quiescence**, Guard cron `*/15 * * * *`,
admin·CI quota-state/schema 갱신 정지, 재개 순서를 포함해야 한다.
과거 DB로 돌아가도 Cloudflare 실제 사용량·청구는 되돌아가지 않는다.
counter, snapshot, kill switch를 현재 실제 사용량과 재조정하기 전 재개하지 않는다.
과거 `normal` 복구가 현재 안전함을 뜻하지 않는다. `/health`의 effective action만으로
persisted action까지 정상이라고 단정하지 않는다.

### 개인정보 — 전용 계약 우선

`personal-data/README.md`의 **Explicit recovery entry and required quiescence**를
따른다. 범용 DB 일괄 복원이나 아래 일반 undo를 임의로 적용하지 않는다.

- **PERSONAL_DB만 복원**한다. `PRIVACY_CONTROL_DB`와 `PUBLIC_AGGREGATE_DB`는
  이 절차에서 절대 복원하지 않는다. 삭제·철회 권위를 과거로 되돌리지 않는다.
- 복원으로 삭제된 개인정보·계정·세션이 되살아날 수 있다.
- 모든 기존 버전의 일반 호출·진행 중 쓰기를 중지·drain한다.
  저장소에는 drain acknowledgement가 없다.
- 실제 quiescence 확보 후 `PUBLICATION_ENABLED=false`,
  `PRIVACY_RECONCILE_QUIESCENT=true` 유지보수 계약을 사용한다.
  후자는 운영자 assertion이지 분산 drain 증명이 아니다.
- PERSONAL migration `0009_restore_replay.sql` 및 checkpoint 호환성을 확인한다.
  필요한 migration은 별도 승인으로 적용하고 HTTP는 계속 차단한다.
- UTC `:50` lane의 tombstone replay와 privacy intent reconciliation 완료를 기다린다.
  삭제·inactivity lane은 intent를 새로 만들 수 있으므로 별도 계약에 따라 관리한다.
  모든 cron을 무조건 끄면 복구 replay도 진행되지 않는다.
- replay 시작 후 완료 전 다른 snapshot을 다시 복원하지 않는다. checkpoint를
  수동 교체하거나 계정을 임의 purge하지 않는다.
- 모든 삭제 의무·replay·reconciliation 검증 전 재개하지 않는다.
  admission 재개는 publication `blocked` 해제를 뜻하지 않는다.

## 5. 최종 bookmark 확보 및 복원

1. writer 차단·drain과 외부 효과 목록을 확인한다.
2. `time-travel info`를 다시 실행하여 **최종 pre-restore bookmark**를 확보한다.
   초기 bookmark 이후 정상 쓰기가 있을 수 있으므로 둘을 구별한다.
3. DB ID·환경·목표 bookmark·손실 구간을 재확인하고 복원 승인을 확인한다.
4. 아래 대화형 실행 제한을 확인하고 명령을 입력하기 **전에** 대상을 최종 검토한다.

**복원은 `CI`가 설정되지 않은 대화형 터미널에서 운영자가 직접 입력할 때만 허용한다.**
CI, 에이전트 shell, 스크립트, piped stdin에서는 실행하지 않는다. `--yes`를 생략하는
것만으로는 보호되지 않으며, 확인을 우회하는 `--json`도 사용하지 않는다.
명령 실행을 위한 **Enter 입력을 되돌릴 수 없는 실행 경계(point of no return)**로 취급한다.
그 전에 승인·대상·bookmark 검토를 끝내고 이후 프롬프트가 반드시 나올 것이라고 기대하지 않는다.

로컬 Wrangler **4.150.0** 소스 확인 근거:
`node_modules/wrangler/wrangler-dist/cli.js:239886`의 restore 호출은
`confirm2(..., { defaultValue: false })`를 사용하지만,
`node_modules/wrangler/wrangler-dist/cli.js:139685`의 `fallbackValue` 기본값은 `true`다.
따라서 대화형 프롬프트의 기본 응답은 No여도 비대화형/CI에서는
`Using fallback value in non-interactive context: yes`를 출력하고 확인 없이 복원으로 진행한다.
이 줄이 보이면 **이미 복원 요청이 전송된 것으로 취급**하고 재실행하지 않는다.
즉시 6절의 복원 후 검증 및 필요한 경우 7절의 승인된 Undo 판단으로 이동한다.

```powershell
# 운영자가 CI 미설정 대화형 터미널에서 직접 입력할 staging 예시. 자동화 금지.
node .\node_modules\wrangler\bin\wrangler.js d1 time-travel restore collection-kit-forecast-collector-staging --bookmark="<승인된-bookmark>" --config .\forecast-collector\wrangler.toml --env staging

# timestamp 방식은 위 명령의 대안이다. 두 명령을 연속 실행하지 않는다.
# node .\node_modules\wrangler\bin\wrangler.js d1 time-travel restore collection-kit-forecast-collector-staging --timestamp="<승인된-UTC-시각>" --config .\forecast-collector\wrangler.toml --env staging
```

복원 출력의 이전 bookmark와 완료 결과도 보관한다.
timeout·연결 단절·모호한 실패이면 **맹목적으로 재시도하지 않는다**.
실제 완료 여부와 현재 상태를 확인한 뒤 다음 조치를 승인받는다.
DB당 10분/10회 제한은 반복 시도의 허가나 안전장치가 아니다.

## 6. 격리 상태 검증 및 필수 재개 게이트

SQL·읽기 검증도 승인된 대상·예산 안에서 수행한다. 실패하면 쓰기 차단을 유지한다.

### 스키마·코드 호환성 결정

- 복구 시점의 ledger와 실제 테이블·인덱스·트리거를 대조한다.
- **이 문서의 소스 snapshot에서 Forecast migration 상한은 `0024`**다.
  영구 상한이 아니다. 실행 시 승인한 코드 revision의 migration 목록을 기준으로 한다.
- `scripts/apply-forecast-d1-migrations.ts`의 bootstrap snapshot은 21이며,
  운영은 4·5·6의 선택적 생략 규칙이 있다. 단순 최대 버전만으로 판정하지 않는다.
- **기존 DB에 `schema.sql`을 다시 실행하지 않는다.** migration helper도 읽기 전용
  검증 도구가 아니라 변경 도구다.
- 복원 시점이 migration 이전이면 운영자가 다음 중 하나를 명시적으로 승인한다:
  (a) 격리 상태에서 검토된 forward migrations 적용,
  (b) 복구 스키마와 호환되는 코드 버전으로 rollback.
  자동 migration·자동 코드 rollback은 없다. 데이터 보존·키·외부 계약도 함께 검토한다.

### 데이터·publication 검증

- 중요 테이블의 행 수·상태 분포·최신 시각을 **독립적인 목표 시점 baseline**과 비교한다.
  복원 출력이나 복원 직전 행 수를 기대값으로 삼지 않는다.
  전체 COUNT/scan 비용은 별도 예산을 승인받는다.
- `forecast_runtime_active` singleton의 environment·sequence·candidate·operation이
  activation history와 일치하는지 확인한다.
- candidate → immutable version → approval → command/review 연결과 payload hash,
  승인 환경·키 ID를 대조한다.
- `signed_pointer_json`의 domain·environment·sequence·candidateId·contentHash·
  operationId·mode가 실제 상태와 일치하는지 확인한다.
- 신뢰된 공개키로 artifact 및 pointer의 **암호학적 서명 검증**을 수행한다.
  JSON 유효성·서명 길이·DB 트리거 통과만으로 대체하지 않는다.
- 불변 승인·history 트리거는 일반 SQL 변경을 막지만 Time Travel로 사라진
  외부 승인 이력을 복원해 주지 않는다. 수동 pointer 수정·트리거 우회를 금지한다.

### 필수 재개 게이트: 되돌아가지 않은 외부 효과 조정

다음 항목을 모두 대조하고 담당자가 재개를 승인하기 전에는 writer를 켜지 않는다.

1. 이미 전달한 Discord 메시지·버튼·알림과 복원된 outbox의 pending/sending/sent 상태.
2. GitHub 실행·PR·callback과 복원된 interaction/idempotency 기록:
   DB에서 사라진 기록이 외부 작업 미실행을 뜻하지 않는다.
3. 이미 소비한 notice quota·요청 예산과 복원된 quota counter:
   과거 값으로 되돌아갔다고 외부 사용 예산이 다시 생기지 않는다.
4. lease·예약·만료 시각·진행 중 작업 소유권과 실제 실행 상태.
5. 외부에서 관측한 publication sequence·서명·키 정책과 복원 상태의 일관성.

조정에 쓰기·재전송·새 승인이 필요하면 별도 승인한다. 불명확하면 중단 상태를 유지한다.
단순 forecast 콘텐츠 rollback이 목적이면 전체 DB 복원보다 기존 승인된 publication
rollback 경로가 적절한지 먼저 판단한다.

## 7. 재개 및 잘못된 복원의 Undo

### 재개

1. 스키마/코드 결정, 데이터·서명·개인정보 검증, 외부 효과 게이트를 모두 통과한다.
2. Guard를 복원하지 않았더라도 현재 effective action과 실제 사용량을 확인한다.
3. 읽기 소비자를 먼저 재개하고 응답·pointer 무결성을 확인한다.
4. writer·cron·Actions를 승인 순서로 재개한다. 유지보수 전 설정을 복원하며
   모든 플래그를 무조건 `true` 또는 `enabled`로 바꾸지 않는다.
5. 중복 dispatch·알림·outbox, quota, lease, 오류를 승인된 관찰 예산으로 확인한다.
6. 자동 배포 소유권을 반환할 때 `FORECAST_STAGING_AUTO_REDEPLOY`의 이전 값을 복원한다.

### Undo

Undo도 DB 전체 복원이다. 5절과 동일하게 `CI` 미설정 대화형 터미널에서 운영자가
직접 입력하며 CI·에이전트·스크립트·piped stdin 실행은 금지한다.
명령 실행 Enter 입력 전에 대상 이름+UUID와 pre-restore bookmark를 최종 확인한다.
fallback `yes` 줄이 보이면 요청이 이미 전송된 것으로 취급하고 다시 실행하지 말고
6절 검증으로 이동하여 추가 복구 필요성을 판단한다.

writer 차단을 유지하고 잘못 복원한 현재 상태의 bookmark도 확보한다.
별도 승인을 받아 **최종 pre-restore bookmark**로 복원한다.
restore 출력이 제공한 이전 bookmark도 DB ID·시각과 대조하여 사용할 수 있다.

```powershell
node .\node_modules\wrangler\bin\wrangler.js d1 time-travel restore collection-kit-forecast-collector-staging --bookmark="<최종-pre-restore-bookmark>" --config .\forecast-collector\wrangler.toml --env staging
```

보존 기간·횟수 제한을 확인하고 같은 검증·외부 효과 게이트를 반복한다.
재개 이후의 새 쓰기나 외부 전달은 자동 merge되지 않는다.
개인정보 replay가 시작되었다면 완료 전 재복원 금지 계약을 우선하며 별도 판단을 받는다.

## 8. staging 복구 훈련

훈련 대상은 **Forecast staging DB `49b5dc06-37ae-4245-896c-daea98562ed8`만**이다.
별도 운영 승인 없이는 실행하지 않는다. **공용 Usage Guard는 제외**한다.
Time Travel은 clone/fork가 아니므로 기존 staging 상태와 서비스에도 영향을 준다.

훈련의 restore와 undo도 예외 없이 5절의 대화형 실행 제한을 적용한다.
운영자가 `CI` 미설정 터미널에서 직접 입력하며 자동화된 훈련 스크립트나 에이전트가
실행하지 않는다. 명령 실행 Enter를 실행 경계로 취급하고, fallback `yes`가 보이면
이미 전송된 요청으로 다루어 즉시 검증/승인된 Undo 절차로 이동한다.

1. 운영·공용 Guard에 영향이 없도록 대상·consumer·외부 전달 차단 계획을 승인받는다.
2. 독립 baseline·정상 bookmark를 확보하고 승인된 시험 변경을 수행한다.
3. 양쪽 Router를 포함한 writer·Actions를 차단하고 drain 증거를 확보한다.
4. 최종 pre-restore bookmark를 확보하고 정상 지점으로 복원한다.
5. ledger·행 수·서명·approval chain·외부 효과 게이트를 검증한다.
6. pre-restore bookmark로 undo하고 동일 검증 후 이전 설정으로 재개한다.

승인 기록에는 차단 시작, drain 확인, bookmark 확보, restore 시작·완료,
검증 완료, undo 시작·완료, 읽기·쓰기 재개 시각을 각각 기록한다.
실제 손실 구간, 서비스 중단 시간, 실패·모호한 결과와 판단 근거도 남긴다.
성공한 훈련을 운영 복구 승인으로 재사용하지 않는다.

## 9. 관련 문서·baseline 구분

- `forecast-collector/README.md`: 수집·Actions·승인 경계
- `personal-data/README.md`: 개인정보 복구의 우선 적용 계약
- `docs/hosting-cutover-p1-runbook.md`: staging 자동 배포 스위치의 한계
- `scripts/apply-forecast-d1-migrations.ts`: Forecast migration·ledger 규칙

Forecast runtime baseline은 성능·인증 baseline이지 DB 백업이 아니다.
Pages rollback artifact도 D1 백업이 아니다. 이 문서는 정기 export나 장기 보존 백업이
이미 운영 중이라고 가정하지 않는다. baseline·bookmark 보관 위치와 접근 정책은
실행 승인 기록에서 정하며 개인정보·비밀값을 일반 로그에 남기지 않는다.
