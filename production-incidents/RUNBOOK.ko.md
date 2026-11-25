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

### 성공한 두 번째 시험 뒤: 공개 발송기 버전 하나만 비활성 업로드

**소스 PR 검토·병합 및 병합 SHA의 보호 `main` push CI가 성공하기 전에는 실행하지 않는다.** PR 측 CI만으로는 부족하다. 이 절차는 소유자 장치에서만 실행하며 워크플로 실행·환경 승인·변수/secret 변경이 필요 없다. 공개용 버전을 만드는 것과 공개하는 것은 다르다. 허용하는 쓰기는 고정 UUID의 `POST …/versions?deploy=false` 한 번뿐이다. 배포, preview URL, route, cron, D1 쿼리, DM, Site 변경은 없다.

FD 수명 수정은 `c5166082294a10fcee82b32eef62e3bf86a9ba1e`를 첫 부모로 둔 보호 `main`의 소스 병합만 허용한다. 깨끗한 checkout에서 이 런북과 helper·오프라인 테스트, 세 파일만 달라야 한다. 이 기준은 과거 successor 서명이나 공개 번들의 소스 핀을 대체하지 않는다.

|확인할 근거|증명하는 것 / 증명하지 않는 것|
|---|---|
|GitHub-hosted attempt 1의 서명 검증|설치 `45171435589`의 `installed.json`은 inert 바이트·버전·폐기한 Editor를, `45197180403`의 `permit.json`은 선행 run `45184118767` 및 고정 successor 바이트를 결속한다. 과거 서명은 이번 쓰기 승인이나 공개 모듈의 서명이 아니다.|
|소유자의 원 장치에 보존된 `~/.incident-private-canary/45197180403/journal.jsonl`|`sent/1`·inert 복구의 **서명되지 않은** 당시 기록. 이것만으로 실제 DM 수신, 실시간 DB 상태, 복구 배포 UUID를 추정하지 않는다.|
|Cloudflare 읽기|기존 버전은 정확히 5개: inert `07805124-2b22-4311-84a5-261c13ee355b`, partial `73c7259d-8ed6-4386-9220-c673b0ede7ea`, donor `4b57a6dd-edf4-4465-9220-1da8a5aa9bcf`, 실패 `a888efe4-145f-42ca-8378-5660f46f3b93`, successor `a7a44718-3df0-4516-a3fa-ebced4038b9f`. 5개 배포 이력 전체를 고정한다. 최신은 `b87e67ae-d1c2-455a-b7c9-e33126c91e57`의 inert 100%, 직전은 `de7ca80b-dd35-47e3-a218-4cee7b05890c`의 successor 100%다.|
|공개 번들|`3677b9bd19669172b82afea497b996234cc19c2d`의 공개 프로필(`entry/worker.ts` → `worker.js`)에서 재현한 SHA-256 `924bc0aa4ddb4c37351b4551c2d55696c5d0c50e14bef355d605a4af4109ed17`. 해시·배포 UUID를 실행 인수로 받지 않는다. 새 **비활성** 버전에만 `PUBLIC_INGRESS=1`, 원 `serviceBuild`, 전용 D1/ratelimit 및 고정 donor에서 상속한 `ADMIN_ID`·`BOT_TOKEN`을 담는다. 활성 inert는 `PUBLIC_INGRESS=0`, secret 없음이다.|

`wrangler versions upload`는 즉시 배포하지 않더라도 대체 명령이 아니다. 고정 Wrangler 4.166.0의 버전 업로드는 `keepSecrets: true`로 이전 버전의 secret을 보존하며 `retryOnAPIFailure`로 POST한다. 그 동작은 이 donor 버전 하나에서 두 이름만 상속한다는 계약이나 재전송 금지를 보장하지 않는다. `--secrets-file`로 값을 재입력하지 않는다. helper는 [Worker Version API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create/) JSON의 각 `inherit.version_id`를 고정한다. 새 버전을 원래 바이트·실제 binding·빈 `urls`로 재조회하고, 기존 5개 + 새 ID 1개, 5개 배포 이력/활성 inert 100%, cron·preview·route·domain·참조의 비노출 상태와 전체 그래프 불변을 다시 확인한다.

**승인된 경우의 소유자 명령** (한 장치·한 계정·다른 제어면 작업이 없는 전용 변경 창). 먼저 해당 PR만 병합된 정확한 보호 main checkout을 사용한다. `.nvmrc` Node 및 고정 pnpm/frozen `--ignore-scripts` 의존성이 필요하다. 아래 빌드는 자격을 공급하지 않는 로컬 dry-run이다. 번들과 임시 구성은 분리하고 helper 전에 구성을 지운다.

```sh
set -eu
set +x
umask 077
test "$(node -p 'process.versions.node')" = "$(cat .nvmrc)"
bundle=$(mktemp -d)
(
  cd production-incidents
  cfg=$(mktemp "$PWD/.public-upload-XXXXXXXX")
  trap 'rm -f "$cfg" "$cfg.json"' EXIT
  build=$(node --input-type=module -e 'import {serviceBuild} from "./sealed-successor.ts"; console.log(serviceBuild)')
  node config.mjs public 9a516350-d7d8-4a77-9cce-45d669fd3502 419204 "$build" > "$cfg.json"
  env -i PATH="$PATH" HOME="$bundle" WRANGLER_SEND_METRICS=false \
    node ../node_modules/wrangler/bin/wrangler.js deploy --dry-run --config "$cfg.json" --outdir "$bundle/public"
)
printf '%s  %s\n' 924bc0aa4ddb4c37351b4551c2d55696c5d0c50e14bef355d605a4af4109ed17 \
  "$bundle/public/worker.js" | shasum -a 256 --check
```

그 후에만 기존 `gh` 소유자 세션과 아래 FD를 사용한다. 셸 변수에는 소유자만 읽을 수 있는 **파일 경로**만 지정한다. 이 도구는 자격을 발급·교체·추출하지 않는다. FD 0은 정확한 Worker UUID만의 계정 소유 `Individual Workers Editor`(발급→만료 24시간 이하, 승인 창 종료까지 유효, 설치 Editor 금지), FD 3은 이 계정의 `Account API Tokens Read` 정책 reader, FD 4는 `cloudflare-site-production`에 등록된 graph reader다. 정책 조회/graph 자격은 GET에만, Editor는 자체 ID·단일 Worker 상태 GET과 단 한 번의 POST에만 쓰인다. Editor 자체는 provider 차원에서 upload-only가 아니므로 다른 도구에 전달하지 않는다.

helper는 정상 FD 0 입력을 EOF까지 읽되 동기 자식 프로세스가 사용하는 표준 FD를 닫지 않는다. 동기 Git/`gh` 호출은 이 입력을 자식에게 전달하지 않으며, 별도 리더 FD 3·4는 내용을 읽은 뒤 닫는다.

```sh
until_epoch=$(($(date +%s)+1800))
node scripts/ci/incident-owner-upload-only.mjs "$bundle/public/worker.js" "$until_epoch" \
  < "$fresh_editor_file" 3< "$policy_reader_file" 4< "$registered_graph_reader_file"
```

완료는 `inactive-upload-verified`만 인정한다. 기록은 원 장치 OS 계정 홈의 `~/.incident-owner-upload-only/bd4b7c3527c14626935139b0924e1249.json`(POST **전** 배타적 생성·동기화)과 응답 ID의 `.ack`다. 실패·유실·무응답·CI/서명 만료·불일치 시 재실행, 다른 장치/계정, 마커 삭제, 구 canary/배포 도구로 보정하지 않는다. **Cloudflare의 여러 GET과 POST 사이 원자적 잠금은 없다.** 같은 reader로 버전 전체·deployments·배포 비율·cron·preview·그래프만 대조하며, `.ack`나 목록에서 보이는 새 ID만으로 성공 판정하지 않는다. 저장된 비밀값이나 D1 행을 열어 대조하지 않는다. 실제 활성화·공개·발송은 별도 의사결정이다.

### 레이아웃 U: 완료된 비활성 업로드 (재실행 금지)

서명된 보호 main `5649b7f942c1892100a40b782f9716015d89fdc5`에서 레이아웃 빌드 `2bfe30a171be2e58243bcf3c6b05961c3b031a1d4ddbc114e650a928605c90d0`용 버전 `e0fd1e38-5f7b-4777-9d96-681c6bb45038` 하나를 비활성으로 검증했다. `3ffefebc-3a91-424c-b8d0-b4d5aa0a0218`은 `24d65a82…` 전용 전임자다. 아래 1–5는 그 업로드의 출처·통제에 대한 기록이며 재승인·재실행 절차가 아니다.

1. `1b73c733283f3cecaaaee782fe897281493be631`의 직계 자식인 단일 서명 squash만 검토한다. `checkRecoveryCheckout`의 전체 경로 목록과 실제 diff(제품 두 파일, enrollment, incident 및 release 검사·문서)를 확인한다. 보호 main의 정확한 SHA·enrollment 소스 검토와 같은 attempt의 CI가 필요하다. 비공개 QA·제품 packet, 운영 인증이나 업로드는 이 커밋의 산출물이 아니다.
2. 원 장치의 이전 marker/ACK와 U의 intent/ACK/verified 원본을 모두 읽어 고정 해시와 대조한다. 설치·성공 및 실패 canary·배포 이력도 그대로 보존한다. 새 scope에는 `layout-successor-inactive-upload-v1`, U의 원본 세 해시, 위 단일 빌드, 기존 공개 모듈 `924bc0aa…`, 비밀 제외 바인딩 SHA-256 `8db7effc4f4f7f0bf97c536e4960f642692806689c83a871dd4f1b870ef383bd`, 고정 donor/inert와 이번 창·자격 ID가 들어간다.
3. 별도 읽기 권한으로만 `node scripts/ci/incident-mobile-successor.mjs --review-scope "$until_epoch" "$editor_id" 4< "$registered_graph_reader_file"`을 사용한다. 소유자의 변경되지 않은 정확한 커밋 댓글과 독립 서명 검토가 각각 필요하다. U에서 사용한 변수가 아니라 보호 환경의 `INCIDENT_LAYOUT_OWNER_COMMENT_ID`, `INCIDENT_LAYOUT_TECH_REVIEW`, `INCIDENT_LAYOUT_TECH_REVIEW_KEY`를 쓴다. 댓글 형식은 아래와 같되 새 scope·서명의 digest여야 한다. 같은 SHA의 녹색 CI도 운영 승인이 아니다.
4. 승인된 배타 창에서만 같은 CLI에 `"$bundle/public/worker.js" "$until_epoch"`를 주고, 기존 FD 0/3/4 방식으로 U 완료 후 발행한 새 단일 Worker Editor와 별도 reader들을 전달한다. 허용되는 POST는 `versions?deploy=false` 한 번뿐이다. 원 장치 고정 슬롯 `~/.incident-owner-upload-only/successor-of-3ffefebc-3a91-424c-b8d0-b4d5aa0a0218/`을 배타 생성하고 intent를 먼저 동기화한다. 오류·무응답이어도 슬롯 삭제, 다른 장치 재시도, 목록에서 ACK 추정은 금지한다.
5. 원래 7개 버전·5개 deployment·inert 단독 100%·기존 3개 route·빈 cron/preview/domain을 확인한다. ACK 이후에는 새 UUID의 모듈, 바인딩 및 비밀 **이름**과 정확히 8개 버전, 변경되지 않은 그래프와 inert 트래픽까지 확인해야 `verified.json`을 만든다. secret 값·D1·발송·Site에는 쓰지 않는다. `activationAuthorized:false`는 영구 보존한다. 실제 새 intent/ACK/verified 원본 해시·UUID에 결속하는 별도 코드 검토와 의사결정 전에는 incident 활성화와 모든 Site 전환을 계속 차단한다.

### 과거 증거: 단계 U 모바일 재시도 후보 (재실행 금지)

아래 U 절차는 원본 영수증의 출처를 설명하는 역사 기록이다. 명령·함수·파일 목록은 당시 소스(`b84443033056b28a5f23594f90c4171863015e57`) 기준이며, 현재 같은 이름의 CLI는 위 레이아웃 후보 전용이다. 과거 명령을 현재 checkout에서 실행하지 않는다.

기존 공개 모듈의 SHA-256은 같아도 `INCIDENT_BUILD`는 버전별 바인딩이다. `00323557-9e9f-470f-b491-3906316f5d69`는 이전 단일 빌드만 받는다. 새 단일 빌드는 `24d65a8263bf42e0205f4ee49c5451344c7c35c4c645cb849c4e88a47bb55f83`이다. 이전 inert/donor·private canary의 빌드, SQL, 마커와 ACK는 보존한다. U는 Site의 모든 공개 방향 및 legacy/OFF/rebuild 우회를 차단한다. U에는 incident 활성화·롤백 기능이 없다. PR #90이나 테스트 결과는 업로드 승인이 아니다.

1. 아래 절차로 서명된 실제 병합 SHA와 그 SHA의 U/기존 소스 CI를 확인한다. 원 장치의 기존 0600 마커와 ACK를 `readPredecessor`로 **읽기만** 해 원본 두 해시를 확인한다. 원본이나 역사적 서명 artifact를 잃었으면 대체물을 만들지 않는다. 원점은 여섯 version, 다섯 deployment, inert 100%, cron/preview/domain 없음, 기존 route 세 개다. 다른 쓰기 주체를 전부 배제한 실제 변경 창이 필요하다.
2. 독립 기술 검토자(자동 검토 가능)는 원본 SHA, 정확한 모듈과 단일 빌드·설정, 기존/신규 버전 경계, 실패/재시도 금지, 테스트를 확인한다. `uploadScope(head,until,privateGraph(reader),editorId,readerId)`의 SHA-256(UTF-8 JSON.stringify)과 소스 SHA를 담은 독립 Ed25519 서명 검토 기록을 보관한다. 여기서 privateGraph(reader)는 await한 해시다. 보호 환경 전용 `INCIDENT_U_TECH_REVIEW_KEY`는 JWK x의 base64url, `INCIDENT_U_TECH_REVIEW`는 원본 statement 문자열과 base64 signature다. 필수 statement 필드와 타입은 `checkApproval`을 따른다. 다른 주체나 CI가 소유자 결정을 생성하면 안 된다.
3. 별도 승인 때만 소유자가 해당 실제 병합 커밋에 수정되지 않은 댓글 `APPROVE INACTIVE UPLOAD ONLY <scopeSha256> <reviewEnvelopeSha256>`을 직접 기록하고 그 ID를 보호 환경 전용 `INCIDENT_U_OWNER_COMMENT_ID`로 등록한다. 같은 이름의 repo/org fallback을 두지 않는다. 검토는 두 번째 인간의 동의가 아니며, 이 댓글은 만료 전 해당 Editor/reader·graph·UUID·모듈·바인딩 하나에 대해서만 유효하다. 스스로 승인하거나 예제/이전 결정을 재생하지 않는다.
4. 승인 후에만 원 장치의 `node scripts/ci/incident-mobile-successor.mjs <exact-public-worker.js> <until-epoch-seconds>`에 기존과 같은 FD 0/3/4를 전달한다. route 쓰기 토큰 불필요. `successor-of-00323557-9e9f-470f-b491-3906316f5d69/`는 매 실행마다 새로 고르는 경로가 아니라 첫 승인에서만 배타적으로 생성되는 슬롯이다. POST 전 intent를 동기화한다. 허용 요청은 한 Worker의 `versions?deploy=false` 하나뿐이고, 기존 donor의 두 secret은 이름으로 상속한다. secret 값을 읽거나 D1/Discord/배포/스케줄/route에 쓰지 않는다.
5. ACK는 새 UUID 식별일 뿐이다. 정확한 일곱 version, 새 바인딩·모듈, 불변 배포/cron/route/graph까지 확인한 뒤에만 `verified.json`이 생긴다. 누락·부분 실패·만료 시 슬롯을 지우거나 ID를 추정하지 않고 읽기만 한다. verified도 활성화 권한이 아니다. **단계 A**는 해당 원본 ACK/verified 해시·정확 UUID·새 단일 빌드·실제 생산자에 결속한 별도 소스·검토·승인 후에만 고려한다. 과거 제품/분석 실패나 EU 미측정은 해소되지 않았다.

**소스 검증 복구 (운영 승인 아님).** #92의 서명된 squash `b0a15d1c74dc4e4773887913c28c02c2bd28e7d7`에는 수동 소스 검증이 없다. 이 SHA의 push run이나 check suite가 뒤늦게 나타나면 먼저 조사하고 기존 push를 사용한다. 빈 커밋·직접 main push·PR artifact로 복구하지 않는다. 복구 PR은 이 SHA의 직계 자식인 **별도 승인된 서명 squash 한 건**을 전제로 한다. 다른 변경을 섞거나 main이 먼저 이동하면 U를 진행하지 않는다. 기존 장치의 마커·ACK·역사적 SHA는 다시 발행하지 않는다.

1. 병합 후 실제 보호 main과 서명, 병합 PR, 단일 부모 및 `checkRecoveryCheckout`의 7개 파일 차이를 검토한다. 독립 검토자가 새 main의 `site-worker/production-root-release-v1.json` 원본을 확인한 뒤에만 권한 있는 담당자가 `ROOT_PAIR_SOURCE_APPROVAL_SHA256`를 `sha256(UTF8(JSON.stringify(["production-root-source-review-v1", repositoryFullName, actualMainSHA, sha256(originalEnrollmentBytes)])))`로 다시 등록한다. enrollment가 같아도 SHA가 달라 #92의 pin은 유효하지 않다. PR head·테스트 merge SHA로 미리 등록하지 않는다. 이 소스 pin은 보호 환경의 U 검토/승인 변수가 아니다.
2. 해당 SHA의 `site-source-verify.yml` main push가 있으면 이를 사용한다. pin보다 앞서 실패했다면 **그 run의 모든 job**을 재실행한다. push 자체가 없을 때만 별도 승인된 담당자가 GitHub Actions의 **Site source verification (no publication)**에서 **main**을 선택해 입력 없이 실행한다. 이 경로는 GitHub API가 확인한 서명된 보호 main만 새로 checkout한다. PR 산출물, 다른 ref·workflow·SHA 또는 서로 다른 attempt의 job을 합산하지 않는다.
3. 한 attempt에서 `Site source prerequisites`(U 오프라인 검사·정확한 소스 pin), `Production root source (no publication)`(격리된 빌드), `Site source verification`이 모두 성공한 경우만 인정한다. U는 다시 현재 보호 tip과 병합·서명을 확인한다. 녹색이어도 읽기 scope·기술 검토·소유자 결정·inactive upload는 각각 별개다. 기존 설치/승격의 push 전용 조건은 바뀌지 않는다.

**다른 브랜치.** #90(활성화)과 #91(로컬 진단)의 기존 head·체크·증거는 새 main 검증이 아니다. 이 PR에 합치거나 자동 rebase/merge하지 않는다. 각각 나중에 새 기준점에서 별도 검토한다. 특히 #90은 실제 U `verified.json`과 새 UUID 없이는 재개하지 않는다.

**원본 보존 시한.** `private-canary-permit-45197180403-1`(ID `14829496001`)의 만료는 **2026-11-30 14:47:11 UTC**다. `incident-installed-45171435589-1`(ID `14819607495`)은 2026-12-23 12:41:46 UTC 만료다. 만료는 새 permit·canary·DM 발행 사유가 아니다. 만료 전에 `umask 077`을 적용한 전용 디렉터리에 **원본 archive**, 그 멤버, GitHub attestation bundle 및 별도 신뢰경로의 Sigstore trust root를 보존한다. 재실행 결과나 `gh attestation verify --format json` 출력만 보존해서는 안 된다.

|원본 멤버|GitHub ZIP SHA-256|멤버 SHA-256|
|---|---|---|
|`installed.json`|`eb97f1acdf229368a2c06479d3a7fce1d188200715948dc04e5473e28dd6846a`|`3417671dfd921563e3bbba6233b677064d59b49ad951937d90546aab54ae213f`|
|`permit.json`|`9280cb5f532add7e29a83c7b3d5dfce5f8283b6feec0d03e078e87a262e7c80c`|`10c7e0fa04028cba69076b28f078dfd6089ebaea53d3e592adba7b65dbec3069`|

`gh api "repos/$repo/actions/artifacts/$id/zip"`의 원본 바이트를 ID별로 저장하고 위 ZIP 해시 확인 후에만 `unzip -p "$id.zip" "$member"`로 지정한 단일 멤버를 꺼낸다. 같은 디렉터리에서 `gh attestation download "$member" --repo "$repo"`로 `sha256:<멤버 해시>.jsonl`을 보존한다. `gh attestation trusted-root`로 신뢰된 기본 TUF 저장소에서 얻은 `trusted_root.jsonl`의 핀은 `65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c`이다. 별도 관리하는 비공개 백업에 복제하고 원래 journal은 보존한다. 공개 PR·로그에 원본 자격 자료를 첨부하지 않는다.

복구 시 `INCIDENT_U_RETAINED_PROOF_DIR`에 소유자 전용 디렉터리의 **절대 실경로**를 준다. 도구는 원본 subject·bundle·trust root 해시와 `gh attestation verify --bundle … --custom-trusted-root …`의 서명, 실제 저장소·소유자 ID, workflow·SHA·main ref·호스팅 runner·run/attempt 1을 모두 확인한다. 이 선택이 실패하면 온라인 fallback은 없다. 환경 변수를 주지 않으면 기존 온라인 검증이 필수다. 오프라인 옵션은 역사적 파일 획득에만 쓰인다. 현재 main·환경·권한·승인·실시간 그래프와 시계 검사는 그대로다.

**승인 전 읽기 전용 scope.** 위 main/역사/소스 확인과 별도 읽기 권한이 있을 때 `node scripts/ci/incident-mobile-successor.mjs --review-scope "$until_epoch" "$editor_id" 4< "$registered_graph_reader_file"`을 사용한다. `editor_id`는 32자리 공개 식별자이며 토큰 문자열이 아니다. FD 0/3은 쓰지 않는다. scope와 digest, `uploadAuthorized:false`만 반환하며 승인·장부·업로드는 만들지 않는다. 실제 업로드에서는 요청자의 Editor를 별도 검증하고 새로 관측한 scope에만 승인 서명을 대조한다.

### 과거 증거: Undo 단계 U (완료, 재실행 금지)

`scripts/ci/incident-undo-stage-u.mjs`는 레이아웃 `layoutU`의 정확한 원본 intent/ACK/verified 및 이전 장부를 선행 조건으로 삼는다. #99 제품 수정·생성된 서비스 identity·등록 계약·새 오프라인 게이트를 **한 번의 검토된 squash**로 기존 보호 main `c552ebfc…`에 적용한 경우만 검토한다. 실제 서명 보호 main SHA, 그 SHA의 성공 push/source jobs, 원래 게시자 키 및 배포를 확인한 별도 `ROOT_PAIR_SOURCE_APPROVAL_SHA256`이 필요하다. PR/로컬 SHA나 수동 run으로 대체하지 않는다.

새 서비스 `670227ca951c6390ec4bfc94705f645378720de51edab254bafa3e5ec3a5f951`는 이전과 같은 정확한 receiver 모듈이더라도 `INCIDENT_BUILD`가 달라 기존 비활성 UUID를 쓸 수 없다. 합의된 독점 창과 읽기 자격으로 원래 장치의 `--review-scope`를 사용하면 FD 4만 읽고 `uploadAuthorized:false`를 반환한다. 실제 한 번의 비활성 업로드에는 별도로 등록된 `INCIDENT_UNDO_OWNER_COMMENT_ID`, `INCIDENT_UNDO_TECH_REVIEW`, `INCIDENT_UNDO_TECH_REVIEW_KEY`, FD 0/3/4의 범위가 좁은 자격이 필요하다. 예전 Editor나 정책 승인·서명은 재사용하지 않는다. 이 절은 해당 자격을 발급하거나 업로드를 요청하지 않는다.

고정 슬롯 `successor-of-e0fd1e38-5f7b-4777-9d96-681c6bb45038`의 원본 intent/ACK/verified로 `aa8a110e-05ac-48c6-811e-fad5f510c307`의 비활성을 확인했다. `activationAuthorized:false`는 그대로다. ACK 불명확·충돌·창 만료 시에도 장부를 보존하며, 이 슬롯은 재실행하지 않는다. 원본과 정확한 등록 소스를 확인한 뒤에만 새 비공개 QA를 별도로 검토할 수 있다. QA 시작 자체에 활성화는 필요 없다.

### 단계 A 소스 검토: Undo 버전 전용 (활성화·Site 전환 미승인)

이 절차는 업로드하지 않는다. 설치·업로드 영수증과 canary `sent/1`, 관리자의 별도 **DM 도착 확인**은 선행 근거이며 새 DM 시도나 쓰기 허가가 아니다. 루트 solver 승격이나 `/preview/` 변경은 포함하지 않는다.

**비활성 영수증은 운영 승인이 아니다.** `checkedSource`는 `4901bb0bdf786907e84321fe9b27a766e119724d`의 단일 직계 squash, 검토한 아홉 경로만 바뀐 깨끗한 checkout을 요구한다. 공개 전 개인정보 검토, 실제 서명된 보호 main과 그 SHA의 성공한 push CI, 같은 SHA의 보호 `prepare-root-pair`, 독립 기술 검토와 운영자 방향별 서명은 별개다. 로컬 tree·PR SHA나 U 승인으로 이 조건을 대체하지 않는다. [루트 검토](../docs/root-rum-witness.md)는 기존 edge 주입과 EU 제외를 유지한다.

- **원본:** 고정 장치에서 최초 마커/ACK, 과거 모바일·레이아웃 U 원본, 성공 canary 장부 및 Undo intent/ACK/verified 원본을 검증한다. Undo 원본 SHA-256은 각각 `80cc2f6a46fdf263ab150fc57a8270c8fe7e47f4ee42071511e643fe65806888`, `df219c89e08e1209ee4e4b44be836baa30ebc2c9e94b581a477b15f06e9be8df`, `4566619b31adbca899e614673faa98b5633dd2e974808185d6b2bc48cc594c28`이다. `readUndoU`는 원래 레이아웃 영수증, 승인 범위 해시와 시간 순서를 대조한다. 원본과 `activationAuthorized:false`는 바꾸지 않는다. 업로드 또는 A 장부가 누락·부분 기록·충돌하면 새 슬롯을 만들거나 목록에서 성공을 추정하지 않는다.
- **대상과 기준선:** Undo UUID만 배포 대상으로 허용한다. 아홉 버전, 다섯 배포, inert 단독 100%(`b87e67ae-d1c2-455a-b7c9-e33126c91e57`), 빈 cron/preview/domain, 기존 세 route와 Undo U 완료 시점의 비공개 그래프를 재확인한다. 전임자들의 바인딩과 새 버전의 `924bc0aa…` 모듈·공개 바인딩 `7c8a14ca…`·두 secret 이름을 각각 확인한다. 두 시험 상태(`blocked/1`, `sent/1`) 외 행이 없음을 primary SELECT로 확인하고 `배포(100%) → */5 * * * * → 정확한 route 신규 생성` 순서만 허용한다. `arm` 전 outbox를 재확인한다. 번들·비밀·D1을 바꾸거나 시험 사건/DM을 발생시키지 않는다.
  두 쓰기 토큰은 Undo U 검증 이후 새로 발행해야 한다. U Editor 재사용은 금지다. 과거 A 장부가 있더라도 같은 고정 경로를 지우거나 재사용하지 않는다.
- **허용 경로:** 등록된 [Workers Route](https://developers.cloudflare.com/workers/configuration/routing/routes/) 패턴은 `nikkecollection.com/api/recalculation-incident`(와일드카드 없음) 하나뿐이다. 이 패턴 자체는 scheme을 제한하지 않는다. 고정 모듈은 URL 전체가 `https://nikkecollection.com/api/recalculation-incident`와 일치하지 않으면 DB/limiter 사용 전에 404다. helper는 실제 HTTP GET의 404 또는 정확 HTTPS로의 리디렉션, 개방 후 HTTPS GET의 405/no-store를 확인한다. 동일 zone의 나머지 route ID·패턴·Worker·fail policy를 확인하고, 루트와 `/preview/` 모두 100% deployment/version 및 실제 HTML 바이트 SHA-256을 전후 대조한다. Site 소유권이나 HTML을 변경하지 않는다.

**자격 경계:** FD 0(`Individual Workers Editor`, UUID `bd4b7c3527c14626935139b0924e1249` 한 개), FD 3(이 계정의 `Account API Tokens Read`), FD 4(기등록 graph reader), **FD 5(별도 계정 소유 토큰, Zone → Workers Routes → Edit/API 이름 `Workers Routes Write`, zone `2ed78e90cd4834066e079282aea4acb2` 하나)**. 네 ID가 모두 달라야 하며 두 쓰기 토큰은 발급→만료 24시간 이하·승인 창을 포함해야 한다. 폐기한 설치 Editor 금지. [route 생성](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/create/)·[route 삭제](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/delete/)의 OpenAPI 쓰기 그룹은 `Workers Routes Write`다. [Workers 권한 안내](https://developers.cloudflare.com/workers/authorization/workers/)는 연결 설정 시 Worker Editor 접근도 설명한다. 경로별 토큰 권한은 없으므로 단일 zone 안의 다른 route도 provider 차원에서는 쓸 수 있다. helper 안에서는 POST 대상/내용 및 DELETE 소유 ID를 고정한다. 계정 전체 Editor/Admin·DNS·zone 설정·혼합 권한·사용자 OAuth로 대체하지 않는다. 별도 토큰으로 거절되면 승인이 끝난 것이 아니다. 범위 확대 없이 중단한다.
**단일 운영자 정책:** 아래 명령 자체는 승인이 아니다. [서명·리허설 계약](../docs/root-rum-witness.md#single-operator-review-record-signature-and-rehearsal)에 따라 실제 병합 SHA와 같은 두 seal·리허설을 독립적으로 기술 검토하고, 운영자 본인이 방향별로 정확한 창/그래프/장부 및 handoff 해시를 승인해야 한다. 활성화와 역순 복구는 별개의 서명이다. `ROOT_SWITCH_SIGNERS`, `ROOT_TECHNICAL_REVIEW`, `ROOT_OWNER_DECISION`은 보호 환경에서 읽으며 이전 방향의 결정이나 PR 의견은 재사용할 수 없다. 읽기 전용 `reconcile`에는 쓰기 결정을 요구하지 않는다. 두 번째 인간이 승인했다는 뜻이 아니다.


```sh
# 별도 운영 승인 및 단독 변경 창에서만. 변수 값은 0600 파일 경로(토큰 문자열 아님).
set +x
umask 077
until_epoch=$(($(date +%s)+1800))
node scripts/ci/incident-owner-activate.mjs activate "$until_epoch" "$intended_prepare_pair_run_id" \
  < "$fresh_editor_file" 3< "$policy_reader_file" 4< "$registered_graph_reader_file" 5< "$zone_routes_file"
```

`exact-incident-active`는 제어면·무부작용 GET·두 문서 대조가 끝났다는 뜻이다. 첫 cron 실행, DM 실수신, 모든 POP에의 전파를 뜻하지 않는다([cron 전파는 최대 약 15분](https://developers.cloudflare.com/workers/configuration/cron-triggers/)). 임의 시간 뒤에 검증이 실패해도 명령을 반복하지 않는다. 로컬 `~/.incident-owner-activation-bd4b7c3527c14626935139b0924e1249/`는 이 버전의 영구 1회 장부다. 파일을 수정·삭제하거나 다른 장치/계정에서 재시도하지 않는다. 각 쓰기 직전 배타적 numbered intent를 디스크에 동기화하며, 응답 ID/cron 생성·수정 시각을 저장하고 live GET으로 별도 검증한다. 중복·소유자 변경·split·낯선 route/cron/DB 상태에서 제출하지 않는다. Cloudflare API 사이 원자적 CAS는 없으므로 **다른 경로에서 제어면을 바꾸지 않는 창**이 필수다.

**롤백 순서:** 루트가 활성화 직전과 완전히 같으면 기존 `rollback "$until_epoch"`를 사용한다. 그렇지 않으면 네 route를 유지한다. forward에서는 별도 승인한 `root-restore-rollback`으로 복구한다. 동작하지 않는 forward 계산은 실행하지 않지만 원래 제어면·배포·seal·preview를 증명하며, 복구한 rollback의 원본 및 브라우저 바이트·실제 계산은 생략하지 않는다. bridge만 설치한 경우에는 별도 서명의 읽기 전용 `root-abandon-bridge`로 같은 handoff의 정확한 bridge deployment/version과 실제 rollback 상태를 재검증한다. 쓰기나 강제 forward 없이 `BRIDGE_ABANDONED`를 만든다. `ROLLBACK_ACTIVE` 또는 이 별도 종료 영수증을 확보한 뒤 `rollback "$until_epoch" "$root_exit_run_id"`를 사용한다. `BRIDGE_READY` 그 자체, 쓰기 ACK, HTML 해시만으로는 철회하지 않는다.

보호 main에 남은 같은 서명 소스, 소유자·환경 승인, exact run/attempt/job, 불변 artifact ID·서버 archive digest를 검사한다. 활성화 장부에는 선택한 prepare handoff SHA-256과 rollback manifest를 고정한다. 복구 artifact는 같은 handoff·SHA의 terminal state여야 하고, live Site의 **검증된 deployment/version**(복원은 새 ID, bridge 종료는 같은 bridge ID), 모듈·control digest·rollback annotation, 원래 문서 바이트와 그대로인 preview가 일치해야 route를 철회한다. 만료/소실된 artifact나 읽기 권한 오류는 승인이 아니다. 성공한 자기 쓰기의 역순은 `정확한 route ID 삭제 → 같은 deployment와 생성/수정 시각의 자기 cron만 비우기 → 기존 inert 버전 100% 재배포`다. 새 복구 deployment ACK 및 실제 이력을 확인한다. 명시적 route 인증 거절(403/10000, 새 route 없음) 후에는 앞서 확인된 cron·배포만 철회한다. D1 기록·secret은 건드리지 않는다.

**전파와 읽기 전용 조정:** 창 만료는 각 배타적 intent 직전에 검사한다. ACK 뒤 목표 상태가 아직 보이지 않으면 즉시 및 1·3·7초 대기 후, 최대 네 번 읽기만 한다(개별 요청 제한 별도). 전파가 더 늦으면 쓰기를 반복하지 않는다. 이후 `node scripts/ci/incident-owner-activate.mjs reconcile "$until_epoch" 4< "$registered_graph_reader_file"`로 장부와 live 상태를 다시 대조한다. 다른 Site 복구 deployment라면 마지막에 `"$root_restore_run_id"` 인수를 추가한다. 이 모드는 FD 0·3·5/쓰기 권한 없이 동작하고 기록도 변경하지 않는다. 누락 ACK·중간 충돌은 이 명령으로도 소유권을 추정하지 않는다. `read-only-reconciled`는 관측된 제어면/HTTP 상태이지 전역 cron 발송 증명이 아니다.

**장기 보관:** 새 보호 실행의 terminal `state.json`은 별도 `attest-root-state` 작업에서 GitHub 서명을 받는다. 보관자는 성공 직후 원본 byte를 0700 소유자 단독 디렉터리에 보관하고, 그 디렉터리에서 `gh attestation download state.json --repo just-goforward/Nikke-Collection-Item-Calculator`로 받은 digest 명의 파일을 `state.sigstore.jsonl`로 보관한다(두 파일 모두 0600, 심볼릭/하드 링크 금지). Actions artifact가 만료되어도 `ROOT_RESTORE_ARCHIVE`를 그 디렉터리로 명시하면 restore run 인수와 함께 재사용한다. 대체 경로는 자동으로 시도하지 않는다. 원래 서명 workflow/보호 SHA/main/호스팅 runner/repo·owner ID/run·attempt, 성공한 보호 job·환경 승인, 장부의 handoff·manifest와 **현재** Site 및 소유한 정확한 route/cron/Worker를 확인한다. 저장된 서명은 과거 결과의 진위만 증명한다. 장부·서명·현재 소유권 중 하나라도 없어졌다면 삭제 금지. Site의 읽기 전용 사후 검증은 [별도 절차](../docs/candidate-toolchain.md#after-an-acknowledged-write)를 따른다.
