# 재계산 장애 전용 Worker

## 최초 설치: 소유자 1회 예약 → 해당 Worker Editor 배포

**검토·병합한 새 보호 `main`의 source 검증이 성공하기 전에는 실행하지 않는다.** 이전 설치 workflow를 호출하지 않는다. 현재 GitHub 소유자 권한은 Cloudflare 생성 권한의 증명이 아니다. 기존 collector-stop/uploader, OAuth 연결, Site 발행기 자격은 재사용하지 않는다. 비밀값·토큰·키 파일·응답 본문을 채팅, 명령 인수, 로그, 이슈, Actions 입력에 넣지 않는다.

1. 새 SHA의 깨끗한 checkout에서 `.nvmrc` / 고정 pnpm / frozen lock / `--ignore-scripts`로 workflow `prepare`와 동일한 `inert` dry-run 번들을 독립 생성한다. `cloudflare-site-production` **환경 변수** `INCIDENT_REVIEWED_MAIN`과 `INCIDENT_MODULE_SHA256`에 검토한 전체 SHA와 `worker.js` SHA-256을 지정한다. 읽기 환경은 기존 `cloudflare-site-production`, 새 승인·Editor 환경은 `incident-private-install`이다. **둘 다** 배포 브랜치는 `main` 하나, required reviewer는 본인 하나, 단독 소유자의 self review 허용, admin bypass 불허다. 전용 변경 창 동안 계정의 Worker·route·domain·권한·namespace와 `main`을 다른 경로로 변경하지 않는다. 이 검사는 여러 API의 원자적 트랜잭션이 아니다.
2. 아래 권한을 Cloudflare 대시보드에서 구분한다. 현재 소유자가 어떤 토큰·권한을 실제로 보유했는지는 확인되지 않았다. `node scripts/ci/incident-owner.mjs enroll-graph`가 **계정 소유 읽기 토큰**(stdin)의 ID와 실제 정책을 확인한 후에만 보호 환경에 `CF_INCIDENT_GRAPH_READ`와 ID를 등록한다. 정책 조회용 자격은 별도 로컬 FD 3으로만 준다. 권한·리소스 형식이 확인되지 않으면 중단한다.
3. `gh workflow run incident-inert-install.yml --ref main -f source_sha="$(git rev-parse HEAD)"`. 그래프 읽기 단계를 승인한다. 담당 환경이 `incident-private-install`로 바뀌어 대기하면 **웹에서 그 첫 gate를 승인하지 말고** `node scripts/ci/incident-owner.mjs reserve RUN_ID`에 로컬 생성 자격을 stdin으로 공급한다. 이 명령만 비공개 이름 신규 예약을 수행한다. 보호 실행/시도 1·현재 main·검토 모듈·GitHub 서명된 부재 증명(60분)·현재 이름 부재를 확인한다. 반환·재조회한 불변 ID를 기록할 뿐 버전이나 트래픽은 생성하지 않는다.
4. 출력된 **그 ID 하나에만** 계정 소유 `Individual Workers Editor`를 지정한다. `node scripts/ci/incident-owner.mjs authorize RUN_ID`에 Editor를 stdin, 정책 조회 자격을 FD 3으로 준다. helper가 정책·token ID·대상의 불변 ID와 이름·실제 빈 상태를 재확인하고, Editor만 전용 환경 secret에 넣은 뒤 같은 실행의 승인 API에 예약 결과를 연결한다. 수동 JSON/UUID 복사, 다른 기존 Worker 인수, 안 보이는 권한을 계정 편집자로 대체하는 방법은 없다. 이후 같은 run에서 추가 환경 승인이 요구되면 **같은 SHA·run**인지 확인하고 승인한다. 읽기 job이 비공개 예약 영수증을 GitHub OIDC로 서명한 뒤 Editor job만 UUID에 첫 버전을 설치한다. 서명된 `incident-installed-RUN_ID-1`과 최종 읽기 검증 성공이 완료 조건이다. 로컬 영수증은 `~/.incident-private-install/RUN_ID/`에 보존한다.

토큰은 소유자 장치의 secret manager나 접근 제한 파일에서 파이프로 공급한다. 예: `node scripts/ci/incident-owner.mjs authorize "$RUN_ID" < "$editor_file" 3< "$policy_reader_file"` (변수는 **값이 아니라 비공개 파일 경로**). 세 명령 모두 FD 3으로 정책 조회 자격을 받는다. 셸 추적·CLI debug를 끄고, 토큰 발급·회수는 대시보드 소유자 경계에 둔다.

|경계|필요 권한과 제한|
|---|---|
|소유자 장치, 신규 예약 한 번|helper는 계정 소유 토큰의 실제 정책이 이 계정의 `Workers Scripts Write` 하나인 경우만 허용한다. **계정 수준 권한이며 provider가 create-only로 제한한 토큰이 아니다.** helper만 고정 계정/이름의 `POST /workers/workers` 하나를 허용한다. GitHub에 보관 금지. 실제 소유 여부는 미확인이다.|
|소유자 장치, 정책 조회|해당 계정의 `Account API Tokens Read`로 permission groups와 해당 token ID의 정책을 조회한다. 이 자격은 GitHub에 등록하지 않는다. 설치·토큰 생성·관리 쓰기 권한을 대신 요청하지 않는다.|
|보호된 그래프 reader|계정 `Workers Scripts Read`(모든 활성 binding·preview·custom domain), `Pages Read`, `D1 Read`, 이 계정의 전체 zone 목록을 볼 `Zone Read`, 검토한 zone 하나의 `Workers Routes Read`. 새 zone/Pages, 불명확한 페이지, 읽기 거부는 중단이다. 개별 Worker Editor는 이 계정 그래프를 증명할 수 없다.|
|보호된 Editor|해당 UUID 하나에 `Individual Workers Editor`만. 생성·타 Worker·D1 직접 접근·route 쓰기·계정 Admin 없음. 인증 실패 시 범위 확대 금지.|

[Create Worker](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/create/) 요청 자체에 `subdomain.enabled=false`와 `previews_enabled=false`를 함께 보낸다. 먼저 공개로 만들고 나중에 닫는 경로는 없다. 제공자가 이를 무시하거나 빈 Worker의 상태·비노출을 증명하지 못하면, 이미 빈 예약이 생겼을 수 있으므로 **설치하지 않고 조사**한다. 버전·배포·secret 이름·cron·route·custom domain·preview·다른 리소스의 참조와 `419204` 충돌을 점검한다. 배포 뒤에도 핀된 모듈/바인딩·배포 버전 하나·비공개 상태를 다시 읽는다. [Workers 역할과 scope](https://developers.cloudflare.com/workers/authorization/workers/).

설치와 분리된 로컬 **읽기 전용** 사전 검사: `set +x` 상태에서 `INCIDENT_GRAPH_TOKEN_ID`를 이미 승인된 reader의 비밀이 아닌 ID로 지정하고 `node scripts/ci/incident-graph-preflight.mjs < "$reader_file"`을 실행한다. `$reader_file`은 소유자 장치에서만 접근 가능한 기존 토큰 파일(0600)의 경로다. secret manager의 stdout을 직접 파이프해도 된다. 토큰을 인수·환경 변수·채팅에 넣거나 Actions에서 꺼내지 않는다. ID와 active 상태를 먼저 대조하고, 실제 `graph()` 전체를 GET으로만 읽는다. 성공 출력은 일치 여부와 횟수뿐이며 부재/설치 영수증이 아니다. 이 명령은 secret 등록·승인·배포·재시도를 하지 않는다.

그래프 GET은 `success:true`, 결과 존재, 명시적인 오류 없음(`errors:[], messages:배열` 또는 `errors:null, messages:null`)을 검사한다. Pages·zone·[Worker 목록](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/list/)·필터된 domain은 한 페이지 전체의 행 수와 합계가 일치해야 한다. domain이 비어 있을 때 실제 `per_page:0`도 허용한다. route는 페이지 정보 없는 배열이다. Worker마다 배포 **이력 전체가 아닌 최신 한 건**(page/per_page/count 모두 1, total_pages=total_count)을 확인하고 그 배포에 포함된 모든 버전 ID와 binding을 검사한다. 누락·오류·모호한 페이지는 중단한다. POST 응답 규칙은 바뀌지 않는다.

409·403·timeout·응답 유실·부분 성공·만료·승인 불일치는 다른 자격으로 재시도하거나 PUT/삭제하지 않는다. 원래 run과 로컬 시도 표시를 보존하고 소유자가 읽기만으로 대조한다. 성공/중단 후 사용한 단기 자격을 회수하고 전용 환경 secret을 정리한다(공용 secret은 건드리지 않는다). 이 절차는 D1 쓰기·키 등록·Discord canary·공개 전환을 승인하지 않는다. `schema.sql`은 별도 승인으로 빈 전용 D1에만 적용한다.

### 예외: run `45149576123`가 남긴 빈 예약 한 건

**이 문서나 소스 병합은 실행 동의가 아니다.** 기본 `reservation=allocate`는 이름이 이미 있으면 계속 중단한다. 복구 대상은 `bd4b7c3527c14626935139b0924e1249` 하나다. 교체된 같은 이름, 다른 UUID, 다른 태그·생성 시각은 허용하지 않는다. 원 실행의 `attempt`는 보존하고 `created`를 만들지 않는다. 원 실행의 재시도·승인, `reserve`, bootstrap 토큰 재발급은 금지한다.

|확인 단계|무엇을 증명하는가|
|---|---|
|보존한 `absent-45149576123-1.json`|`gh attestation verify`로 원 workflow·SHA·run·attempt 1·GitHub 호스팅 서명을 확인한다. 바이트 해시가 원 예약 태그의 해시다. 이것은 당시 **생성 전 부재**의 출처이지 현재 권한이나 생성 후 상태의 서명이 아니다.|
|현재 provider 조회|승인된 reader ID, 계정 전체 Worker·최신 배포에 걸린 버전과 namespace, D1·Pages·zone·route·domain을 검증한다. 대상 이름과 ID 양쪽에서 정확한 태그, 생성/최종 수정 시각 `2026-11-23T10:01:30.589292Z`, 미배포, 두 비공개 플래그, logpush·observability·tail·incoming reference를 대조한다. 별도 subdomain·cron·Preview·**전체** 버전과 배포 목록을 확인한다.|
|새 서명과 소유자 승인|새 `main`의 attempt 1·모듈·원 증명·그래프 지문·시각을 묶은 `exact-private-empty`만 유효하다(60분 미만). owner가 이 증명의 해시와 정확한 대상·Editor ID를 승인해야 한다. 설치 직전에 현재 main·run·승인·시한·Editor 상태를 다시 검사한다. 여러 API의 원자적 snapshot은 아니다. 보호된 변경 창은 검증 종료까지 유지한다.|

**Secret 증거의 범위:** [Worker secret은 바인딩](https://developers.cloudflare.com/workers/configuration/secrets/)이고 [바인딩은 버전에 속한다](https://developers.cloudflare.com/changelog/post/2025-09-03-new-workers-api/). [Version URL alias도 버전을 업로드할 때 생성한다](https://developers.cloudflare.com/workers/configuration/previews/). 이 예약의 인증된 UUID 목록에 실제로 버전이 **0개**이고 preview·배포도 0개이므로, 이 Worker에 연결된 버전 secret·alias가 없음을 알 수 있다. 계정의 Secrets Store가 비었다는 뜻이 아니다. 이것과 독립적으로 classic `/secrets`의 양성 목록은 거부한다. 이 정확한 미배포 예약에만 관찰된 `404/10007`의 정확한 오류 형태를 허용한다. 404 자체나 GET audit의 200만으로 빈 상태를 증명하지 않는다. 다른 API/ID/오류/배포 후에는 적용하지 않는다.

**설치 전, 기존 자격만으로 하는 소유자 로컬 검사.** 검토한 깨끗한 checkout 루트에서 `.nvmrc`의 Node와 기존 소유자 `gh` 세션을 사용한다. 아래 셸 변수는 **값이 아니라 0600 비공개 파일 경로**다. 토큰을 입력 인수·환경 변수·로그에 넣지 않는다. 새 토큰 발급, secret 등록, gate 승인, run ID는 필요하지 않다.

```sh
set +x
node scripts/ci/incident-owner.mjs preflight-recovery \
  < "$editor_file" 3< "$policy_reader_file" 4< "$reader_file"
```

|주체|반드시 이 자격으로 읽는 것|
|---|---|
|FD 0: 기존 계정 소유 Editor|active token ID. 정책 대조 후 대상의 불변 ID·이름으로 각각 직접 조회해 두 응답 모두 정확한 ID·이름, 역사적 태그·시각·privacy·참조를 요구한다. 같은 Worker의 subdomain·cron·버전·배포·classic secret 이름을 읽는다. 계정 Worker 목록은 요청하지 않으며 graph reader의 성공으로 어느 항목도 대신하지 않는다.|
|FD 3: 기존 정책 reader|같은 계정의 permission-group 카탈로그와 **FD 0에서 검증한 token ID**의 active 정책. 단 하나의 allow·단 하나의 `Individual Workers Editor`, 리소스는 `{"com.cloudflare.api.account.<계정>":{"com.cloudflare.edge.worker.script.<불변 ID>":"*"}}`와 구조까지 같아야 한다. `*`는 정확한 ID 아래의 값일 뿐 Worker 선택자가 아니다.|
|FD 4: 이미 등록된 graph reader|보호 환경의 비밀 아닌 token ID와 대조. 전체 계정 그래프·예약 상태 및 **해당 UUID preview 목록 전체가 비었음**을 독립 검증한다. Editor 또는 쓰기 자격으로 대체하지 않는다.|

`f038ca2`의 소유자 검사에서는 개별 Editor로 계정 [List Workers](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/list/)가 403이었다. 목록 가시성은 권한 정책이 아니다. FD 3으로 정확한 단일 grant를 입증하고, FD 0으로 [Get Worker](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/get/)와 대상 상태를 입증한다. 계정 전체 목록의 **완전성**은 FD 4에서만 입증한다. Cloudflare [OpenAPI](https://github.com/cloudflare/api-schemas)는 대상 GET·버전 생성에 개별 Editor를 열거하지만, UUID의 preview **목록**에는 열거하지 않는다. 따라서 preview **플래그**는 양쪽에서, 목록은 기존 graph reader에서 검사한다. 문서상 역할 지원은 실제 GET이나 쓰기 성공의 증거가 아니다.

**출력 판독:** `matrix`의 고정 단계별 `ok`는 해당 검사만 통과했다는 뜻이다. `http-403` 등은 해당 GET의 HTTP 상태, `transport`는 연결 실패, `invalid`는 응답이나 검증 조건 불일치, `not-run`은 선행 증거가 없어 실행하지 못했다는 뜻이다. 반복되는 다른 Worker의 배포·버전은 두 단계로 묶고 각각 첫 실패를 보존한다. 독립 GET은 첫 거부 뒤에도 한 번씩 조사한다. `editorPolicyAndState`와 `graphAndPreviews` 모두 true이고 종료 코드가 0이어야 사전 검사가 끝난다. 하나라도 실패하면 **승인·설치 금지**다. GET 수나 일부 `ok`는 영수증이 아니다.

**대상 403 진단(소유자만):** 위 `preflight-recovery` 한 번의 `matrix`를 사용한다. `editor.verify`·`management.permission-groups`·`token-detail`·`exact-policy`로 FD와 정책 대조를 먼저 구분한다. `editor.reserved-id`/`reserved-name`은 `/workers/workers/{불변 ID 또는 이름}`, `editor.versions`는 `/workers/workers/{불변 ID}/versions?per_page=100`, 나머지 `editor.subdomain`·`schedules`·`deployments`·`secrets`는 `/workers/scripts/{예약 이름}/` 아래의 해당 GET이다(모두 고정 계정). 같은 단계의 graph 결과와 비교하면 해당 Editor만 거부됐는지 구분할 수 있다. 원인까지 단정하지 않는다. 소유자가 발급 계정·정확한 대상·토큰 상태/조건 및 해당 endpoint의 역할 지원을 대조한다. 필요하면 **단계명·상태만** 전달한다. 토큰, token ID, 헤더, URL, 응답 본문, debug dump는 공유하지 않는다. graph 자격으로 Editor 검사를 대신하거나, 범위를 넓히거나, POST로 권한을 시험하지 않는다.

이 명령은 시도 표시·승인·영수증·secret·배포를 만들지 않는다. 배포 뒤에야 생기는 버전 ID의 모듈 GET 및 업로드 권한은 예측 검증하지 않는다. 기존 복구 run `45158456449`의 서명(만료 `2026-11-23T11:44:23.737Z`)을 재사용하지 않는다. 병합 뒤에는 새 보호 SHA·새 run attempt 1·새 서명과 별도 승인이 필요하다.

**소유자의 순서와 결정점:**

1. 소스 PR을 독립 검토한다. 운영 승인 전에, 검토한 checkout 루트에서 기존에 등록한 graph reader만 사용하여 `set +x` 상태로 `INCIDENT_GRAPH_TOKEN_ID="$reader_id" node scripts/ci/incident-graph-preflight.mjs reconcile-45149576123 < "$reader_file"`을 실행한다. `$reader_id`는 비밀이 아닌 ID이고, helper는 보호 환경 변수와 대조한다. `gh`에는 서명과 변수의 읽기 권한만 필요하다. 성공하면 지문과 GET 횟수만 출력한다. 로컬 토큰을 가져오거나 읽어 주도록 타인에게 요청하지 않는다. 이 검사로 승인·증명서·마커·배포가 생기지 않는다.
2. **읽기 전용 대조를 별도로 선택한 경우에만:** 검토본을 병합하고 새 보호 main의 source 검증과 독립 재생성한 inert 모듈 핀을 확인한다. 원 실행은 승인하지 말고 종료될 때까지 기다린다. 공용 concurrency 그룹을 점유한다면 취소 여부도 소유자가 별도로 정한다. 기존 reader를 재등록하지 않는다. 보호 변수 `INCIDENT_REVIEWED_MAIN`은 새 전체 SHA, `INCIDENT_MODULE_SHA256`은 원래와 동일한 검토 번들 해시여야 한다. 기본 브랜치의 새 dispatch: `gh workflow run incident-inert-install.yml --ref main -f source_sha="$(git rev-parse HEAD)" -f reservation=reconcile-45149576123`. **새 ID / attempt 1 / 새 SHA / 복구 모드**를 확인하고 `cloudflare-site-production`의 그래프 읽기만 승인한다. 서명된 `preflight.json`이 없거나 검사가 어긋나면 여기서 중단한다. 이 단계에는 Editor나 생성 권한이 없다.
3. **해당 inert 모듈 설치까지 별도로 동의했을 때만:** `incident-private-install` owner gate에서 웹 버튼을 누르지 않는다. 이 UUID 한 개에만 `Individual Workers Editor`를 준비한다. 새 깨끗한 main checkout에서 `node scripts/ci/incident-owner.mjs authorize-recovery "$NEW_RUN_ID" < "$editor_file" 3< "$policy_reader_file" 4< "$reader_file"`을 한 번 사용한다. FD 3은 기존 정책 reader, FD 4는 기존 graph reader다. 원 `attempt`와 원 서명, 새 서명, 살아 있는 전체 그래프 지문, Editor 정책·대상·빈 상태를 대조한다. 이 명령은 **새** run에 1회 승인 시도를 기록하고 Editor를 전용 GitHub 환경에 등록한 뒤 그 실행의 gate를 승인한다. 단순 조회가 아니다. 별도 새 승인 없이는 실행하지 않는다.
4. 이후 새 run의 환경 승인이 표시될 때마다 같은 SHA·run·단계인지 확인한다. 직전 `reserved` job은 등록된 graph reader로 전체 그래프·같은 UUID의 빈 상태·preview 0개를 다시 검증해야 `reserved.json`을 서명한다. `install`은 이 서명·소유자 승인·유효 시한을 대조하고, **별도** Editor의 active token ID가 영수증의 Editor ID인지, 대상 상세와 빈 상태가 그대로인지 확인한다. `checkAuthority`가 GitHub의 현재 main·run·승인 영수증을 마지막으로 대조한 뒤 그 UUID의 `versions?deploy=true`에만 POST한다. Editor는 생성된 버전 ID의 `?include=modules`까지 직접 재조회한다. `verify`는 다시 graph reader로 같은 UUID의 preview 0개, 전체 그래프, 실제 모듈·바인딩·100% 단일 배포·비공개 상태를 확인해야 설치 완료를 서명한다. 단계 사이에 변경될 수 있으므로 변경 창은 끝까지 유지한다. 성공 전후 모두 Discord 키 등록·DM·cron·route·Site 공개 전환은 이 절차 밖이다.

**중단 또는 대안:** 출처·privacy·secret·페이지 완전성·서명·권한 중 하나라도 독립 확인할 수 없거나, 만료·부분 성공·응답 유실이면 그대로 보존한다. 마커 편집·범위 확대·재시도·자동 삭제는 하지 않는다. 소유자는 (a) 빈 상태 유지 또는 (b) 먼저 읽기로 정확한 대상과 삭제 영향을 확인한 뒤 **별도 명시 동의**로 그 빈 ID만 삭제하고, 부재를 새로 증명해 기본 신규 생성 절차를 검토할 수 있다. 삭제와 재생성은 이번 복구가 아니며 새 UUID에서 classic secret 목록이 여전히 404라면 기본 경로 역시 중단한다.

### 별도 canary 및 공개 단계

관리자가 기존 승인 계정의 Discord snowflake를 `ADMIN_ID`, 소유한 봇 토큰을 `BOT_TOKEN`으로 **새 Worker에만** 비공개 등록한다(Cloudflare Worker Settings → Variables and Secrets → Secret). 기존 secret 추출·회전 금지. 메시지 수락을 위해 이 계정에서 봇 DM을 허용한다. 값·스크린샷·Discord 응답을 증적에 담지 않는다.

부분 등록 시 inert 상태를 유지하고 secret 목록에서 **이름·Secret 형식만** 확인한다. 빠진 이름만 등록하고 기존 값을 표시·교체하지 않는다. 값의 정확성은 목록만으로 확인할 수 없다. 두 이름이 모두 있으면 기존 경로·cron 비활성 상태를 다시 확인한 후 보호된 canary 단계로 전환한다. `operator-private-canary` 키는 보존 기간 내 동일하여 INSERT를 반복해도 새 알림은 생기지 않는다. 이 canary는 1회만 시행하고 장기 보존 만료 후 재삽입하지 않는다. 수락 여부가 불명확하면 관리자 inbox로 확인하고 재전송하지 않는다.

#### `45184118767` 다음의 단 한 번의 비공개 canary (새 승인 필요)

원 run의 `sealed_retry / blocked / attempts=1`과 소유자의 DM 미수신이 확인되었다. 원 run·행·journal은 종료된 증거다. **이 PR 검토·병합은 새 실행, DM, 자격 발급, 공개 전환 승인이 아니다. 지금 할 일은 소스와 필수 CI를 독립 검토하는 것뿐이다.** 다음 절차는 소유자가 나중에 새 시험 메시지 한 건 및 해당 비공개 변경 창을 명시적으로 승인하기로 선택한 경우에만 사용한다. 수신 여부가 바뀌거나 모호하면 중단한다.

전용 D1의 기존 스키마 SHA-256 `b7caa79093856b09aaaa7440153c8049211a4731026e9b1dfd1743524693d6fa`는 바뀌지 않는다. 허용하는 최초 상태는 원 journal 시간창의 고정 fingerprint·서비스 빌드·`canary/private` incident 한 건, 같은 UTC day·빌드·reason·stage의 `blocked/1`, `next−seen≥3600` 통지 한 건뿐이다. 빈 DB도 거절한다. 새 통지는 **공개 빌드가 아닌** `sealed-successor.ts`의 고정 시험용 build 키를 사용하므로 같은 날에도 PK와 Discord nonce가 다르다. 이 키는 run 인수가 아니며 매번 만들지 않는다. 새 incident/trigger 대신 새 통지를 단일 SQL로 `claimed/1` 삽입하며, 성공한 isolate만 그 행을 발송한다. 이후에는 날짜·창·permit을 바꿔도 두 번째 삽입이 불가능하다. 전체 큐 drain, 보존 기한 대기, 기존 행 편집·삭제·재큐, 수동 INSERT, 설치 workflow 재사용은 금지한다.

1. 독립 검토와 병합 후 새 보호 main의 source 검증이 성공해야 한다. 소유자는 전체 작업 동안 다른 제어면·DB 변경을 금지한다. 여러 API에 걸친 검사는 원자적 CAS가 아니다. `.nvmrc`·고정 pnpm·frozen `--ignore-scripts`로 준비한 깨끗한 checkout에서, 자격 없이 아래처럼 **만료가 컴파일된** 모듈을 먼저 만들고 해시를 독립 확인한다. 같은 고정 UTC 만료로 재현할 수 있어야 한다. `end`는 현재부터 최대 1시간 후, 실행 시점에는 최소 10분이 남아 있어야 한다.

   ```sh
   set +x
   export INCIDENT_CANARY_END=$(($(date +%s)+3600))
   bundle=$(mktemp -d)
   bash scripts/ci/bundle-private-canary.sh "$bundle"
   hash=$(shasum -a 256 "$bundle/private-canary.js" | cut -d' ' -f1)
   gh workflow run incident-private-canary.yml --ref main \
     -f source_sha="$(git rev-parse HEAD)" -f module_sha256="$hash" -f end_epoch="$INCIDENT_CANARY_END"
   ```

2. **새 run / attempt 1**에만 `incident-private-install` 승인 화면에서 대상 SHA·모듈 해시·만료를 대조한다. 원 DM 미수신을 확인했고 새 DM 딱 한 건을 승인할 때만 다음 승인 코멘트를 정확히 쓴다: `nonreceipt:45184118767; authorize-one-new-dm:<새 run ID>:<새 보호 main 전체 SHA>`. 꺾쇠 부분은 실제 값으로 바꾼다. 단순 승인 버튼이나 옛 코멘트로는 실행할 수 없다. Actions는 Cloudflare 자격 없이 새 run·attempt·선행 run·고정 새 슬롯·SHA·바이트 해시·만료에 묶인 permit만 서명한다. 실제 실행은 소유자 장치에서만 한다. 단기 계정 소유 `Individual Workers Editor`(오직 `bd4b7c3527c14626935139b0924e1249`), 기존 정책 읽기와 등록된 그래프 읽기 자격이 필요하다. 폐기한 설치 Editor·계정 전체 쓰기·사이트 OAuth/발행기·D1 쓰기 토큰은 사용하지 않는다. 이 절차가 토큰을 발급하거나 GitHub secret을 수정하지 않는다.
   Editor의 발급→만료는 24시간 이내, 만료는 canary 창 종료보다 최소 10분 뒤여야 한다.

   ```sh
   node scripts/ci/incident-private-canary.mjs execute "$RUN_ID" \
     < "$fresh_editor_file" 3< "$policy_reader_file" 4< "$registered_graph_reader_file"
   ```

   변수에는 0600 파일 **경로만** 넣는다. helper는 기존 네 버전과 `원 inert → 실패 canary → 복구된 inert`의 최신 배포 이력, 비공개 상태, 물리 카탈로그 및 primary의 봉인된 두 행을 검증한다. 한 항목이라도 다르면 중단한다. `deploy=false`로 고정 donor `4b57a6dd-edf4-4465-9220-1da8a5aa9bcf`의 두 이름만 상속한다. [Workers 버전 API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create/)로 새 모듈·설정·바인딩을 확인한다. 비공개 배포 및 cron 직전에도 gate·봉인·창·대상을 재확인한다. HTTP 진입점은 없다. 경로는 새 통지 하나만 처리하고 이전 통지는 갱신하지 않는다. 이 절차가 중단되면 제3의 슬롯이 없으며 자동 재발송도 없다.

3. 영수증은 UTC·모듈 해시·상태·시도 횟수만 공유한다. terminal 또는 제한시간에 도달하면 자기 배포 ID와 cron이 맞을 때만 cron을 비우고 원래 비밀 없는 inert 버전을 복구한다. donor 버전/secret/기록을 삭제하지 않는다. `sent`도 실제 수신은 아니므로 관리자가 DM함을 별도로 확인한다. `pending`·`claimed`·`uncertain`·`blocked` 또는 응답 유실 때에는 다시 실행·INSERT·재큐하지 않는다. 수신/비수신 여부만 공유하고 ID·본문·토큰을 제출하지 않는다. `pending`/`claimed`가 남았다면 공개 발송기로 넘기지 않는다.

4. 장치 중단 시 `~/.incident-private-canary/$RUN_ID/journal.jsonl`을 편집하지 않는다. 확인된 자기 deployment 기록이 있을 때만 같은 checkout·FD로 `execute` 대신 `restore`를 사용한다. 이는 발송·삽입·cron 설정을 시작하지 않는다. 제어면이 다르거나 배포 응답이 유실되어 ID가 없으면 자동 덮어쓰기 없이 읽기로만 대조한다. cron 철회 전까지 원래 Worker를 다른 경로로 활성화하지 않는다. 영구 장애여도 만료된 canary 모듈은 새 시도를 하지 않는다. 복구 확인 후 단기 Editor를 회수한다. 공개 경로·루트 승격은 별도 승인이다.

`sent` 및 관리자의 실제 DM 수신을 둘 다 확인한 뒤에만 `public` 정확 경로를 승인·등록한다. canary 실패/미확인은 서비스 준비 완료가 아니다. 운영자 canary는 브라우저에서 만들 수 없다. 승인 경로에서 전달할 증적은 phase, codeHash, UTC, 상태, 관리자 수신 확인뿐이다. `claimed`가 오래되면 `uncertain`으로 격리한다. `uncertain`은 실제 발송됐을 수 있으므로 자동/수동 재큐하지 않는다. `blocked`는 secret/수신권한/빌드 및 API 거절을 비공개로 조사한다.

`blocked / attempts=1`만으로 토큰·수신 설정 오류를 단정하지 않는다. 관리자는 이미 사용 중인 Discord 클라이언트의 **예정된 봇** DM함과 메시지 요청에서 해당 UTC 창의 도착 여부만 확인한다. 토큰 표시·재설정, 시험 메시지, 화면 캡처·ID·본문 제출은 필요 없다. 기존 run/행은 종료 상태로 보존한다.
`ADMIN_ID` 출처도 미확인이면 관리자가 등록 당시 선택한 항목이 **본인 프로필의 사용자 ID**였는지만 비공개로 확인한다. 채널·서버·봇 애플리케이션 ID와는 다르다. 기존 등록 출처가 없으면 미확인으로 남기며 값을 꺼내거나 교체하지 않는다.

별도로 승인된 전용 D1 primary **읽기만** 가능한 경우 다음 고정 SELECT에 검토된 원래 서비스 빌드를 바인딩한다. 기존 설치/복구 helper를 이 목적으로 실행하지 않는다. 원시 시각·ID·자격·응답 본문은 반환하지 않는다.

```sql
SELECT CASE WHEN count(*)<>1 THEN 'unclassified'
            WHEN max(n.next)=0 THEN 'direct_block'
            WHEN max(n.next-i.seen)>=3600 THEN 'sealed_retry'
            ELSE 'unclassified' END AS branch
FROM incidents i JOIN notifications n ON n.day=i.seen/86400 AND n.build=i.build
  AND n.reason=i.reason AND n.stage=i.stage
WHERE i.fingerprint='operator-private-canary' AND i.build=?
  AND i.reason='canary' AND i.stage='private' AND n.state='blocked' AND n.attempts=1;
```

`direct_block`은 발송기의 즉시 거절(입력, 채널 응답의 수신자 검증, 재시도 대상이 아닌 HTTP 거절 등), `sealed_retry`는 재시도 예약을 1회 canary가 종결한 경우다. 후자는 채널 단계 예외·응답 읽기/JSON 오류·429/5xx와 메시지 단계의 명시적 429를 구분하지 못한다. `unclassified`도 재실행 사유가 아니다. 이 결과는 HTTP 상태나 DM 수신 증명이 아니다.

브라우저는 인증 없이 호출하므로 이 신호는 사용자 신원이나 진짜 장애의 증명이 아니다. Origin은 인증이 아니다. 전역 일일 신규 240건, 위치별 분당 60요청, 빌드·이유·단계당 UTC 하루 1통, cron당 1통이다. 과부하 시 429로 누락될 수 있다. 난수 시도 ID의 SHA-256만 저장한다. 사용자 ID/IP, URL, 입력, 예외문, stack은 저장하지 않는다. 5분 cron에서 사건은 30일, UTC 날짜별 발송 기록은 30~31일 후 삭제한다(중단 시 재개 후 삭제). Cloudflare 계정의 로그 수집·push 및 D1 백업 보존 정책은 별도 확인한다. 롤백 시 경로를 먼저 철회한다. 장기 비활성화 시 보존 기간 종료 후 전용 DB 폐기까지 담당자를 지정한다.
