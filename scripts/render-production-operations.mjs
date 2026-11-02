import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { outcomeContractRows } from "./production-operating-catalog.mjs";
import { workers, databases, unresolved, buildValues, operationSections, conditionalSecrets, unmanagedProfiles, analytics, decisionPublicConfiguration, publicationActivationInputs, publicationEvidenceGate, decisionMetadataInstallationContract, requiredUnconfiguredBindings, tokenRoles, externalInputs, runtimeConsumers, workerReadiness } from "./production-operating-catalog.mjs";

const scalar = value => JSON.stringify(value);
function table(name, value, array = false) {
  return `${array ? "[[" : "["}${name}${array ? "]]" : "]"}\n` +
    Object.entries(value).map(([key, item]) => `${key} = ${
      item && typeof item === "object" && !Array.isArray(item)
        ? `{ ${Object.entries(item).map(([k, v]) => `${k} = ${scalar(v)}`).join(", ")} }`
        : scalar(item)}`).join("\n") + "\n";
}
export function renderToml(config) {
  let text = "# Generated from scripts/production-operating-catalog.mjs; do not edit.\n";
  const entries = Object.entries(config);
  const structured = value => value && typeof value === "object" &&
    (!Array.isArray(value) || (value[0] && typeof value[0] === "object"));
  for (const [key, value] of [
    ...entries.filter(([, value]) => !structured(value)),
    ...entries.filter(([, value]) => structured(value)),
  ]) {
    if (Array.isArray(value) && value[0] && typeof value[0] === "object")
      for (const item of value) text += "\n" + table(key, item, true);
    else if (value && typeof value === "object" && !Array.isArray(value))
      text += "\n" + table(key, value);
    else text += `${key} = ${scalar(value)}\n`;
  }
  return text;
}
const rows = (headers, data) => [
  `| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`,
  ...data.map(row => `| ${row.map(value => String(value).replaceAll("|", "\\|")).join(" | ")} |`),
].join("\n");
export function renderOperations() {
  return "# 운영 구성·권한·입력·검증 절차\n\n` scripts/production-operating-catalog.mjs `에서 생성한다. 생성 문서를 직접 편집하지 않는다.\n\n" +
    "이번 OFF 출시에서 Observer Diagnostics 전환과 Operator profile은 제외한다. 아래 해당 두 구성은 미포함 구현과 별도 승인이 필요한 미래 제안이며 현재 배포 가능한 profile로 취급하지 않는다. 생성·일치 검사는 두 설정 파일을 변경하거나 요구하지 않으며, 고정 후보는 기존 HEAD의 Observer 설정·구현을 함께 보존한다.\n\n" +
    operationSections.map(([title, paragraphs]) => `## ${title}\n\n${paragraphs.join("\n\n")}\n`).join("\n") +
    "\n## A 입력표 — Worker·바인딩·경로·Cron\n\n" +
    rows(["Worker", "설정 원본→생성 경로", "D1·서비스·자산 바인딩", "경로", "Cron / CPU ms", "상태"],
      workers.map(w => [w.config.name, `${w.source} → ${w.path}`,
        [...(w.config.d1_databases ?? []).map(d => `${d.binding}=${d.database_name} (${d.database_id})`),
          ...(w.config.services ?? []).map(s => `${s.binding}=${s.service}#${s.entrypoint ?? "default"}`),
          ...(w.config.assets ? [`${w.config.assets.binding}=${w.config.assets.directory}`] : [])].join("; "),
        w.config.routes === undefined ? "선언 없음; 원격 미확인" : JSON.stringify(w.config.routes),
        `${JSON.stringify(w.config.triggers?.crons ?? [])} / ${w.config.limits?.cpu_ms ?? "명시 없음"}`, w.releaseDeferred ? w.status : workerReadiness[w.key]])) +
    "\n\n### 원래 운영 D1 4개\n\n" + rows(["이름", "ID", "출처"], Object.values(databases).map(d => [d.name, d.id, d.source])) +
    "\n\n## B 입력표 — 권한·범위·시점·보관\n\n" +
    rows(["역할", "최소 권한/검증 상태", "자격 증명 권한 범위", "승인 작업 대상·시점", "보관 위치", "금지·주의"], tokenRoles) +
    "\n\n## C 통합 입력표 — GH·런타임·Secret·빌드\n\n" +
    rows(["실제 이름", "유형", "보유자/위치", "값 또는 미해결", "상태", "필드 출처", "소비 함수/진입점"], operatingInputRows()) +
    "\n\n### 신규 outcome·capability 계약과 소스 증거\n\n" +
    rows(["버전/역할", "동작/이름", "schema/경계", "실제 소비 함수/원본", "상태/검증"], outcomeContractRows) +
    "\n\n### 추가 바인딩과 정책 코드 간극\n\n" +
    rows(["입력/계약", "상태", "소비자"], [
      ["FORECAST_RATE_LIMITER", "미해결: 승인된 운영 namespace/rate 필요", "site-worker/src/forecast.ts:createForecastEndpoint"],
      [decisionMetadataInstallationContract.generatedPath, "연결 구현됨; undefined로 안전 차단. 실제 acquire/mapping 정책은 CODEGAP",
        "cloudflare/src/production-worker.ts → createProductionStatsWorker → createProductionDecisionResolver"],
      ["asOf/projection 및 expectedSupply", "CODEGAP: 허용 client view 전체 bands 불변성 또는 승인된 공통 projection/계약 변경 필요",
        "cloudflare/src/decision-analytics-publication.ts:createProductionDecisionResolver; src/analytics/decisionAcquisition.ts"],
    ]) +
    "\n\n### 실제 게시 증거 미해결\n\n" +
    rows(["필드", "값/요건"], [
      ["engineBuildHash", publicationEvidenceGate.engineBuildHash], ["wasmHash", publicationEvidenceGate.wasmHash],
      ["cadenceVersion", publicationEvidenceGate.cadenceVersion],
      ["레지스트리", publicationEvidenceGate.coverageSource],
      ["차단 상태", `${publicationEvidenceGate.admissionStatus} / ${publicationEvidenceGate.publicationStatus}`],
      ["필수 원본", "전체 해시·WASM·cadence에 결합된 원래 panel과 sealed receipt; fixture 대체 불가"],
    ]) +
    "\n\n### 비관리·퇴역 검토 설정\n\n" + unmanagedProfiles.map(path => `- \`${path}\` — 비관리; 운영 후보의 별도 원본이 아님.`).join("\n") +
    "\n\n### 원래 M2 출처와 테이블\n\n" +
    [analytics.primaryContract, analytics.primaryIndex, analytics.source, analytics.storeSource, analytics.maintenanceSource, analytics.sqlProposal]
      .map(path => `- \`${path}\``).join("\n") +
    "\n\n기존 Stats DB의 테이블(원격 적용 증거 아님): " + analytics.tables.map(name => `\`${name}\``).join(", ") +
    "\n\n## 0002 공식 FILE 경로 — 로컬 준비만 완료\n\n" +
    [
      "대상은 `cloudflare/decision-analytics/0002_stats_public_read_models.proposed.sql` 원문 13,969 bytes, LF, SHA-256 `df5394e74a3553516673fccd042e2a6b9bd07481aac44e8216aa62c5ae97e6de`와 Stats DB `3e18385a-af83-4c67-83a0-ab889149692c`다. `scripts/d1-file-import.mjs`는 한 번 읽어 고정한 bytes를 전송 대상으로 유지한다. 원문 분할·wrapper·ledger·SQL 정책 변경은 하지 않는다.",
      "FILE 소스는 `scripts/d1-file-import.mjs`, `scripts/d1-file-import-https.mjs`, `scripts/d1-file-import-state.mjs`; 합성 시험은 각각의 `.test.mjs`다. FILE용 실제 인증 공급과 HTTP 전송 binding은 미연결이며, import adapter는 명시적으로 주입한 요청·Agent 구현 없이는 사용할 수 없다. 별도의 고정 DB 읽기 factory는 실제 node:https에 연결되지만 아직 실행하지 않았다. 합성 주입의 출처는 호출자의 책임이고 synthetic 표시는 OS sandbox가 아니다. CurrentUser DPAPI·현재 사용자 ACL·배타 OS lock·영속 예산을 사용하고, 기존 기록은 새 INIT 없이 보존된 작업의 관측만 허용한다. API 완료는 `complete_pending_postcheck`이며 `postverified:false`다. UNKNOWN·timeout·클라이언트 종료는 서버 취소나 rollback 완료가 아니다.",
      "인증 callback은 목적·대상·provider ID·만료·승인 참조를 명시하며, 승인 descriptor는 실제 권한의 증명이 아니다. 첫 await 전에 승인 필드·중첩 binding·provider 선택을 복사·고정하므로 외부 객체 변경으로 만료나 대상을 대체할 수 없다. 공급원 자동 탐색·로그인·갱신·fallback은 없다. 승인 만료는 공급 전과 dispatch 직전에 검사하고, 유효 기한은 기존 작업 기한·최초 승인 만료·요청 시작 후 30초 중 가장 이른 시점이다. timeout/abort는 클라이언트 요청·응답을 정리하며, 동기 취소 후 반환된 Agent 등 자원도 해제하고 다음 timer·dispatch를 시작하지 않는다. header 16KiB·body 64KiB의 byte 한도를 초과하면 거절하고 retry·redirect하지 않는다. API 인증은 PUT에 전달하지 않는다. 영속 예약 횟수와 adapter 호출·dispatch 횟수는 별개이며, `actualRequestsThisRun`은 adapter 계수의 차이만 사용하고 계수가 없거나 무효하면 `null`이다. 합성 시험은 실제 TLS·proxy 억제·DNS·서버 수신·wire 요청 수를 증명하지 않는다.",
      "합성 원로그: adapter 53/53 `C:/Users/PC/.mixdog/data/scratch/file-r4-r5-tests-8lhghdxb/adapter-after-fix.log`; 실행기 95/95 `C:/Users/PC/.mixdog/data/scratch/file-r4-r5-tests-8lhghdxb/runner-after-fix.log`. 같은 폴더의 `r4-baseline.log`, `r5-baseline.log`는 동기 취소 자원 누수와 mutable 승인 만료 연장의 수정 전 실패를 보존한다. 이전 계수 오류의 87/88 원로그는 `C:/Users/PC/.mixdog/data/scratch/file-https-tests-c5ecd2rt/https-runner.log`에 남긴다. 보호 기록 11/11은 source가 바뀌지 않은 `C:/Users/PC/.mixdog/data/scratch/s.edb1c28281601c4c/d1-state-9bxpuiwd/focused-fix2.log`를 재사용한다. 초기 모순 응답 실패는 `C:/Users/PC/.mixdog/data/scratch/file-runner-tests-6_llwssa/file-runner-pre-fix-terminal.log`, 보호 기록 시험 보조 코드 오류는 보호 기록 폴더의 `focused.log`, `focused-fix1.log`에 보존한다. Node hook은 native helper의 OS 수준 egress 차단이 아니며, 악성 동일 사용자에 의한 전체 기록 rollback이나 실제 정전 내구성은 검증하지 않았다. 기존 SQL native100·로컬Wrangler9·helper26은 각 기존 범위만 재사용하며 원격 원자성·재개 증거로 확대하지 않는다.",
      "저장된 공식 근거의 FILE 문구는 “to ensure large imports are atomic operations, never leaving your database in a halfway state”로 파일 import 기능에 관한 것이다(https://blog.cloudflare.com/building-d1-a-global-database/). 별도 API 문구 “Imports block the D1 for their duration.”는 준비·사후 조회까지의 차단이나 정확한 in-flight 직렬화 경계를 증명하지 않는다. 새 실행기와 실제 운영 경로에 대한 최종 적용성은 미확정이다.",
      "사후 확인에는 별도 승인이 필요하다. schema/helper 확인은 14개 label(테이블 3·trigger 10의 전체 정의와 helper 부재), 기존 relation-postcheck는 고정 1행으로 계획한다. DDL 정의별 UTF-8 분석 한도는 8,192 bytes이며, 초과·잘림·누락은 거절한다. 비교에는 SQLite catalog 표현의 정규화만 허용하고 전체 정의를 고정 SQL과 대조한다. 정수 counter와 동시점 원본/요약의 양방향 정합성을 요구하며, 테이블 존재나 빈 artifact 테이블만으로 통과시키지 않는다. 관계 일치 flag만으로 과거 행 보존을 독립적으로 증명하지 못하며, 고정된 additive SQL·원자적 적용·지원 writer 가정의 근거도 필요하다. 입력 sentinel·DDL 분석 한도는 실제 전송량·물리 읽기·비용 상한이 아니다. 이번에는 사후 조회를 실행하지 않았다.",
      "운영 전 미완료: 실제 인증 공급·권한, 원자성·동시 쓰기 차단의 최종 적용성, writer/cleanup 통제·재개 조건, 변경 전 보호된 복구 기준, 실제 계정·DB 상태·비용 승인, 원격 시간·횟수·사후 조회 예산, UNKNOWN 확인 책임자·후속 승인. writer 중지·Time Travel·자동 재실행·계정 전체 조회·새 token·운영 설정 변경은 묶지 않는다. 이 로컬 준비는 raw 계산건/forecast 연구 DB 전체의 구현·익명화·수집 활성화 완료가 아니다.",
    ].join("\n\n") +
    "\n\n## 실행 후보·읽기 확인·출시 의존관계\n\n" +
    "이 절의 로컬 근거는 실제 배포·수집 활성화 승인이 아니다. 미커밋 파일 전체를 후보로 승인하지 않는다. 계정은 `15be33fd20ea78eb3d60b719be831148`(32-hex), 지정 DB는 `3e18385a-af83-4c67-83a0-ab889149692c`다. 기존 인증은 ‘Mixdog 설정의 Cloudflare 연결’이며 도구 호출에는 사용 가능하지만 로컬 node:https의 credential 공급원으로 확인된 것은 아니다. 선택한 로컬 방식에 별도 인증이 필요했고, 사용자는 이후 단기 계정 D1 Read token을 로컬 비표시 입력으로 공급해 `fields=uuid,name` GET 최대1회에 쓰는 변경을 승인했다. token의 계정 수준 읽기 권한과 프로그램의 지정DB·GET1회 제한은 별개다. Global API Key·쓰기·배포·DNS·token 생성 권한을 묶지 않고 추가 verify·retry·endpoint 탐색을 하지 않는다. MCP 인증 추출·OAuth/브라우저/.env 탐색·Guard/배포 secret 재사용·내부 패치 없이 진행하며 MCP 조회를 로컬 HTTPS PASS로 대체하지 않는다.\n\n" +
    "**현재 종료는 B — 지정 DB 실제 HTTPS metadata 읽기 성공**이다. 사용자가 검토된 동일 명령을 직접 실행한 후 비밀 없는 `run-f5kjM8`의 execution/result/journal과 parent receipt를 확인했다. 승인된 계정·DB·GET path와 예상 uuid/name `collection-kit-stats`가 일치하고 예약·adapter 호출·dispatch·확인 응답이 각각 1이다. client PID22548은 종료됐으며 sqlAccessed:false·credentialPersisted:false, 승인된 source/runtime hash가 일치한다. 근거는 `C:/Users/PC/.mixdog/data/scratch/s.edb1c28281601c4c/d1-read-stdin-c9x9pn8l/parent-receipt.json` 및 `run-f5kjM8/read-journal.jsonl`, `execution.json`, `result.json`이다. 독립 Reviewer가 해당 기록만 확인해 B를 수용했다. GET1 예산은 소진됐으며 추가 verify·조회·retry를 하지 않는다. 실제 입력·서버 부여 권한의 범위·token 폐기를 별도 API로 검증한 것은 아니다. 폐기와 클립보드 정리는 사용자 handoff 완료 보고이며 token 원문을 읽거나 기록하지 않았다. 이 성공은 FILE write·PUT·SQL 원자성·schema·복구·writer/cleanup·사이트 배포 준비를 입증하지 않는다.\n\n" +
    "**최초 C — 실행 전 실패 이력은 보존한다.** 에이전트가 일반 Windows PowerShell `-NoProfile -File`로 시작한 최초 시도는 OS 실행 정책이 script load를 거부했다. 오류는 ‘이 시스템에서 스크립트를 실행할 수 없으므로 … 파일을 로드할 수 없습니다.’, `FullyQualifiedErrorId: UnauthorizedAccess`, terminal 1 cursor `1793502658791000` → `1793502658791919`였다. 그 최초 시도는 입력창·provider·Node API client·GET 모두 0으로 끝났고 HTTP/TLS/DB 실패는 아니었다. 에이전트는 정책 변경·Bypass·elevation·encoded-command 우회·자동 재실행을 하지 않았다. 이후 사용자 수동 실행 환경의 정책 설정을 조회하거나 변경하지 않았으며, 현재 성공과 최초 거부를 합치거나 이력을 지우지 않는다.\n\n" +
    "입력 경로는 PowerShell `Read-Host -AsSecureString` → 환경을 제한한 Node의 private stdin pipe였다. 비밀은 argv·환경변수·Git·일반 로그·receipt에 쓰지 않고 실행 메모리로 공급하며 JS/string의 완전한 zeroization은 보장하지 않는다. scratch `C:/Users/PC/.mixdog/data/scratch/s.edb1c28281601c4c/d1-read-stdin-c9x9pn8l/bridge.ps1` SHA-256은 `1e09c7dc19749ccb263e06e8565f38c184c0274b3c82b2efbb814ec927eb4ae5`, `bridge.mjs`는 `3f6ab05547268f6fc0d757855cdaca9396482f6a45158f02cde3411d5fccacf7`다. 결과 기록에는 입력 후 client window30초·고정 GET·원문 module bytes 복사/검증·배타 marker·비밀 없는 journal이 결속된다. client 종료는 token 폐기나 서버 취소와 다르며 같은 bridge를 다시 실행하지 않는다. FILE 쓰기 권한·DB 적용·배포·수집 활성화·복원·commit·push는 이번 승인에 포함되지 않는다.\n\n" +
    "발급 절차 참고: https://dash.cloudflare.com/profile/api-tokens/ 의 My Profile → API Tokens → Create Token → Create Custom Token에서 Account → D1 → Read만 선택하고 Include → Specific account로 위 계정 하나를 고른다. TTL은 짧게 설정하고 결과·실패·중단 직후 token을 폐기한다. Global API Key·Edit/Write·DNS·Workers 배포·token 관리 권한은 추가하지 않는다. 발급 화면의 예제 verify/curl은 이번 승인에 포함되지 않는다. 이번 token 사용은 종료됐으므로 새 token을 발급·입력하거나 기존 명령을 다시 실행할 필요가 없다. 공식 근거: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ ; 지정 DB metadata GET의 D1 Read 허용: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/ .\n\n" +
    "수용된 기준 후보의 SHA-256은 아래와 같다. 53·95건은 각각 당시 adapter·실행기 전체 파일 결과이며, 변경 없는 보호 저장소 11건은 별도 근거다. 과거 55·92건과 합산하지 않는다. 읽기 준비의 후속 diff와 영향 시험은 별도로 연결하고, 과거 결과를 변경된 전체 후보의 새 PASS로 이월하지 않는다.\n\n" +
    rows(["수용된 기준 파일", "SHA-256"], [
      ["scripts/d1-file-import.mjs", "c2d2fac895e1e9cd66661459b1f997024d8787a80be354d091f4caba89b49eae"],
      ["scripts/d1-file-import-https.mjs", "0f38ac867c2310b3dd70c3f78c9b6076ca575cfba228e70203efe7720e51623a"],
      ["scripts/d1-file-import-state.mjs", "c50053942cd82c3d605bce15cbb554d49c2198781b0d10a84c7f8ce24577eec2"],
      ["scripts/d1-file-import.test.mjs", "24ba07019196a06e362fd23cfa484d991886c4d7488bd15758741b7413a68724"],
      ["scripts/d1-file-import-https.test.mjs", "0e0e2cdf3edde4f7a049a407b6be52f5c73f30709ee64c5e0a58df0594698fb7"],
      ["scripts/d1-file-import-state.test.mjs", "4656ad35af0fb33315c7282a8db05aefd8e6748359f1428d481272eef3b7b0e3"],
    ]) +
    "\n\n원로그의 before/after source hash는 일치한다. 이후 scratch `run.py`에 문서 확인 mode가 추가되어 현재 wrapper hash는 당시 시험 기록과 다르며, 이를 source 변경이나 전체 환경의 새 검증으로 표현하지 않는다. 실제 실행 의존성은 고정 Node 26.13.0과 Node built-in, 보호 저장소의 Windows PowerShell `-NoProfile -NonInteractive`·.NET CurrentUser DPAPI·ACL이다. Node 실행 파일 SHA-256은 `14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5`다. OS helper source는 저장소 module hash에 결속되지만 PowerShell/.NET 전체 환경의 별도 봉인은 확인하지 않았다. Wrangler 4.151.3은 기존 SQL 리허설 도구이지 작은 실행기의 런타임 의존성이 아니다.\n\n" +
    "이번 읽기 준비 후보는 `scripts/d1-file-import-https.mjs` SHA-256 `9db6083f7afdc183cfc53acf3b4aadd70baad46c4afcc4013f12db68b19c4ade`, `scripts/d1-db-read-check.mjs` SHA-256 `5552370a54a82c32e8b83aa7299e03b202f6d783caca7cea6c5b018a8da0f63f`, `scripts/d1-db-read-check.test.mjs` SHA-256 `78ef21026cc328da0454cb2609c92508ff022d3445ccff704c95e63a26eec01c`다. 새 고정 읽기 영향 시험 55/55(공유 HTTPS의 좁은 POST/PUT 확인 4건 포함)는 `C:/Users/PC/.mixdog/data/scratch/d1-read-tests-mpkfzhdn/read-after-owner-fix.log`에 있다. 같은 폴더의 `fixed-read-initial.log`는 source 정리·metrics 결함과 시험 보조 코드 오류의 최초 43/51 결과를 보존한다. 이는 과거 실행기 55건과 다른 새 시험이며 기존 53/95/11을 재실행하거나 합산한 것이 아니다. 공유 adapter source의 후속 diff에 대한 근거일 뿐, 과거 53건을 새 source 전체의 실행 결과로 이월하지 않는다.\n\n" +
    "읽기 경로는 `runD1DatabaseReadCheck`와 `createD1DatabaseReadTransport`로 제한한다. 정확한 HTTPS origin·명시 계정·고정 DB·GET·`?fields=uuid,name`만 허용하고 예상 uuid와 collection-kit-stats를 확인한다. 실제 node:https 구현은 import와 공유하되 읽기 permission·최대1회 예약·기록을 migration 상태와 분리한다. fresh exclusive·fsync 읽기 journal에는 비밀 없는 대상·승인 참조·시각·계수·분류만 남기고 기존 파일 재사용은 거절한다. 인증 공급·승인·기한 검증 전에는 실제 요청하지 않는다. 성공은 제한 내 실제 응답의 수신·대상 확인·결과 기록까지 완료한 경우에만 해당한다. 예약·adapter 호출·dispatch·확인 응답을 각각 기록하며 계수 불명은 null이다. 401/403·대상 불일치·TLS/연결·응답 한도·기록 실패를 구분하고 실패 후 retry·다른 endpoint 탐색을 하지 않는다. FILE write 권한·PUT·SQL 원자성/복구·writer/cleanup·사이트 배포 준비는 이 읽기로 증명하지 못한다.\n\n" +
    rows(["기능 / 상태", "실제 소비 코드·endpoint", "Worker·DB·최소 schema", "설정·OFF 및 남는 작업", "호환·복구·출시 조건"], [
      ["Site / 조건부 준비", "src/hooks/useCalculatorApp.ts; site-worker/src/worker.ts; /api/stats, /api/outcome-summary, /api/events", "기존 collection-kit-site-production → collection-kit-stats의 named Ingest/PublicStats capability", "forecast/raw OFF 가능하나 named 통계 조회는 계속 실행. 명시적 build/check/deploy:site-production-off 경로 사용", "bundled/OFF artifact의 실제 빌드·고정 SHA·구성 검증과 별도 배포 승인 필요. 기존 STATS fallback과 capability profile의 v3 410은 별도 계약; 파일 번호로 퇴역을 결정하지 않음"],
      ["신규 solver / 로컬 근거", "useServiceCertifiedSolver → serviceCertifiedAdapter → browserClient/workerHandler; Calculate 시 lazy 생성", "브라우저 dedicated Worker·고정 WASM/ABI. Forecast D1·Discord는 bundled 계산의 필수 조건 아님", "VITE_SERVICE_CERTIFIED_SOLVER 선택. App boot는 solver Worker·forecast 조회를 시작하지 않음; dispose/idle 해제 유지", "기존 고정 WASM 검증을 사용하며 Rust rebuild는 명시 작업. signed online forecast와 현재 engine sealed publication 증거는 별도 gate. 구 runtime URL·WASM alias 보존"],
      ["운영 forecast / 별도 미완료", "/api/forecast/version, /api/forecast; collector /health·인증 /admin/*; dispatcher scheduled; /discord/interactions", "기존 collector/dispatcher/interactions + Forecast 2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853·Guard 49b7f966-f4e8-4c2d-8453-279415737054; runtime publication v5 schema", "Site enabled에는 DB·Guard·rate limiter·공개 신뢰키 필요. collection/dispatch/publication/cleanup은 독립 flag. collector health도 Guard 사용; dispatcher fetch는 404", "production/staging caller 분리·binding/name·Cron·CPU budget 정렬 필요. 후보 빈 Cron·CPU300을 과거 운영 빈 Cron·CPU50 관찰과 혼동하지 않음. 외부 caller 미확인. signed OFF와 sequence0 초기화는 다름"],
      ["기존 통계 / DB0002 미적용", "PublicStats → stats-read.ts; /api/stats; Diagnostics.readObservations; schema-health.ts", "기존 collection-kit-stats, Stats D1·Guard. named compact reader는 stats_public_totals/game_day(0002); diagnostics/health는 기존 원본 schema", "raw OFF여도 public 통계·diagnostics·legacy schema health는 독립 실행. health는 0002/0003 attestation 아님. 초기 handler 구성은 DB migration을 실행하지 않음", "기존 default HTTP reader는 원본 aggregate 사용. cutover=true면 그 HTTP interface 비활성. Stats CPU10·17 3 Cron을 보존하며 별도 DB 적용/사후 확인 필요"],
      ["결과 신고 / 신규 raw 기본 OFF", "Ingest /api/events, /api/decision-outcomes; PublicStats /api/outcome-summary; outcome-handler.ts/event-submission.ts", "기존 events schema; outcome_summary/outcome_effects 등은 Stats0003. 0002만으로 outcome-summary 준비 안 됨", "새 v4 /api/decision-outcomes만 OUTCOME_FACTS_ENABLED·STATS_CAPABILITY_CUTOVER가 모두 true여야 저장하고 OFF면 storage 전 404. 기존 /api/events는 raw OFF여도 기존 검증·보안·quota 조건 아래 저장 가능. outcome-summary는 OFF와 독립 조회; cutover=true의 기존 kit_result는 outcome_effects도 확인", "queue 미수락 legacy 보존·전송 후 불명 ACK fallback 금지 정책 유지. raw OFF는 기존 통계 수집 전체의 OFF가 아님. flags OFF만으로 named profile의 schema 필요가 사라지지 않음. 0003 독립 승인·호환 consumer 필요"],
      ["신규 raw 통계 / 수집 비활성", "OutcomeRawFacts; outcome-store/facts/raw-reader/publication; stats-admin operator gateway", "Stats0003 영구 facts·uniqueness·effects·요약, 0002 artifact archive. Forecast는 공개 공급의 authoritative 원본", "보유량·선택/권고 method·실제 recommendedUses·명시 outcome/attemptCount·공개 supplyReference 계약. reader budgets+Guard 및 Access/JWT/operator 승인 필요; OPERATOR_ENABLED=false는 raw RPC 전 503", "outcome-only 영구 facts 유지. 적합한 별도 노출 분모 없이는 신고 분포를 강화 선택률로 표현하지 않으며, 무응답을 미강화·WAIT로 채우지 않는다. 이를 보완하려고 새 사용자 ID·장기 추적·추가 수집을 넣지 않는다. 무응답 제외·random UUID·개인 입력/outbox RAM-only 유지. projection은 exact rational pieces/공개 interval이며 누락을 임의 미래 공급으로 채우지 않음. 후속은 unknown 횟수의 제한된 once-only 보완; 사실/uniqueness 영구, patch control24h·receipt14일. 전체 연구 DB 완료로 확대하지 않음"],
      ["cleanup·복구 / 별도 통제", "Stats scheduled → rate-limit.ts; outcome maintenance; collector minute57 cleanup; Site /api/_ci/stats-health", "Stats receipts event_ids/stats_rejection_event_ids + Guard; private raw reader는 별도 capability. Site probe는 고정 /api/health만 전달", "ingest OFF는 maintenance OFF가 아님. Stats 기존 17 3 Cron·Guard */15 보존. raw maintenance는 자체 flag/schema4/budget; collector cleanup도 자체 flag·Guard·invocation 필요", "기존 known UPSERT+receipt cleanup만 전제하고 외부 직접 writer는 운영 제한 가정. 실제 중지·공유 Guard OFF·Time Travel 자동 호출 없음. rollback은 승인된 code/공개 pointer/보존 자산 경로로 검토"],
    ]) +
    "\n\n### OFF 배포 경로와 남은 승인 단위\n\n" +
    "`npm run build:site-production-off -- <approved-full-SHA>`는 깨끗한 고정 후보에서 신규 solver ON·forecast bundled·online trust 비움을 고정하고 새 `dist/`를 생성한다. 고정 WASM·engine freshness·기존 bundled packaging·보존 자산·disabled catalog·artifact SHA를 검증하며 기존 산출물 덮어쓰기를 거절한다. `npm run check:site-production-off -- <approved-full-SHA>`가 같은 artifact를 확인하고, 별도 승인된 `npm run deploy:site-production-off -- <approved-full-SHA>`는 기존 collection-kit-site-production과 named collection-kit-stats profile을 사용한다. `.vite/local-operational-profile.json`의 `deploymentApproved:false`는 유지하며 artifact 검증을 배포 승인으로 바꾸지 않는다. 기존 online build·deployment gate는 완화하지 않고 제외된 online-builder 변경을 이 후보의 구현으로 간주하지 않는다. `npm run build:operations`의 별도 로컬 `dist-service-bundled/`를 배포 산출물로 자동 승격하지 않는다. Site ASSETS·Stats bindings와 named /api/stats의0002, outcome-summary의0003, 기존 /api/events 의존성은 OFF에서도 유지한다. 실제 DB 적용·인증·복구·시간/요청/비용 예산 및 Backend→Site 순서의 배포 승인은 아직 미완료다.\n\n" +
    rows(["미완료 조건 / 실제 소비", "필요한 값·근거", "승인 단위"], [
      ["decisionMetadataInstallation → createProductionStatsWorker", "cloudflare/src/generated/decision-production-installation.ts는 undefined; 실제 승인된 설치 구성 필요", "backend의 한정 module 구현·통합 검증"],
      ["createProductionDecisionResolver acquire / expectedSupply mapping", "인증된 contentHash·runtimeSnapshotHash·asOf acquisition과 frontend 공급량 의미에 맞는 mapping", "Front/Backend 공유 정책 승인; bands·단위·window 임의 생성 금지"],
      ["serviceCertifiedAdapter / retainVerifiedAcquisition / resolver", "frontend 계산 asOf와 server projection 대응 근거", "동등성 검증 또는 명시적 계약 변경 승인"],
      ["candidateCoverageError / prepareArtifactApproval", "현재 engine별 원래 sealed panel/receipt·production trust·publication key 승인", "실제 증거 검증·게시 승인; 과거 engine·synthetic으로 대체 금지"],
      ["Ingest / PublicStats", "Stats0002·0003 각각의 원문·선행 schema·사후 확인", "기존 Stats D1의 독립 파일 적용 승인"],
      ["Forecast applyMigrations / createForecastEndpoint / createInteractionWorker", "별도 migration cohort/ledger·production 키·binding·limiter·staging caller 전환", "Forecast DB·키 등록·연결·발행 각각의 승인"],
      ["kitResultAggregateStatement / cleanupExpiredStatistics / runStatisticsCleanupJobs", "실행 시점 writer/caller/cleanup baseline·보호된 복구 기준·UNKNOWN 책임자는 미확정", "필요 대상만 한정 조회·조정·재개 조건 승인"],
    ]) +
    "\n\n### migration 구분과 다음 적용계획 — 아직 실행 승인 아님\n\n" +
    "Stats0002는 위 고정 원문이며 이번 workflow에서는 미적용이다(운영 상태 재조회 아님). Stats0003는 `cloudflare/decision-analytics/0003_outcome_facts.proposed.sql`, 10,233 bytes, SHA-256 `5ad0f107744d608b2956b38862952e6a9962fa603d6908f3d2be689d288668c0`다. 영구 결과 facts/effects·중복 방지·요약/운영 제어를 추가하고 0002의 outcome_public_artifacts를 선행조건으로 한다. 동일 hash의 과거 로컬 적용·late-failure rollback은 `C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793450787820_04c84add7b414658928f786508c1a04e/wrangler-local-migration-literal-lookup.log`에 있으며 실제 운영 준비 증명은 아니다. 0002 뒤 자동 연속 적용하지 않고 historical raw를 재구성하지 않는다.\n\n" +
    "Forecast의 `forecast-collector/migrations/0005_discord_staging_adoptions.sql` 및 `0011`–`0034`는 다른 DB·ledger/checkpoint 작업이다. helper는 0005 선행 schema와 0011의 중복 revision 조건을 확인하며 0034는 publication dependency closure를 재구성한다. 기존 수용된 선행조건·로컬 검증은 역사적 범위만 재사용하고 재실행하지 않았다. 정확한 승인 cohort·실제 적용 이력은 운영 전 별도 확인하며 code rollback 때 schema/history를 삭제하거나 v5 비호환 구 앱에 publication을 노출하지 않는다.\n\n" +
    "다음 실제 적용안은 Stats0002 단독이다. 선행 source는 cloudflare/schema.sql의 event_aggregates/event_aggregates_game_day(각 8열 PK·integer counter)이며 bootstrap은 실행하지 않는다. 별도 승인 사전 조회는 bounded catalog 1회(257 sentinel·DDL별 8,192-byte 분석 한도)와 기존 self-validating Q2 1회(고정 2행·source별 10,001 sentinel)로 제안한다. 알려진 단조 UPSERT와 14일 receipt cleanup의 담당·외부 writer 제한·재개 조건을 기록하되 새 blanket fence는 요구하지 않는다. 변경 전 보호된 복구 기준은 아직 미완료이며, 필요 시 지정 Stats DB의 현재 bookmark GET 최대 1회를 별도 승인받는다. 실행 상태 기록은 DB backup이 아니다.\n\n" +
    "적용 예산 제안은 INIT≤1·PUT≤1·INGEST≤1·POLL≤12, 작업600초와 최초 승인 만료·요청30초 중 이른 제한이며 실제 HTTP retry/redirect/인증·사후 확인을 포함한 최종 wire 예산 승인은 별도다. 논리 성공 작업량 2L+3C≤50,000은 물리 과금 상한이 아니다. 비용 판단에 필요할 경우에만 요금제 확인 최대1회와 해당 quota 기간 D1 read/write/storage 집계 최대1회를 별도 범위·권한으로 제안한다. 사후 조회는 위 metadata14 label 1회+relation flag1행 1회이며 실제 실행하지 않았다. API complete와 postverified를 분리한다. 원본 보존은 고정 additive SQL·원자적 적용·지원 writer와 관계 검증을 함께 근거로 삼는다.\n\n" +
    "UNKNOWN 확인 책임자는 **미지정**이며 지정 전 적용할 수 없다. 시작 응답/작업 ID 유실·한도 소진·프로세스 종료는 자동 재실행이나 복원으로 처리하지 않는다. 보호 기록과 terminal status·대상 schema 정의를 좁은 별도 승인으로 확인한 후 후속 조치를 결정한다. Time Travel은 이후 정상 쓰기를 덮어쓸 수 있으므로 변경 전 기준·적용 결과·이후 쓰기를 구분한 복구 승인이 필요하다. 이번 읽기 확인 승인은 이 적용계획·writer 중지·publication·배포·키 등록·복원을 승인하지 않는다." +
    "\n\n## 미해결 승인·값·검증\n\n" + rows(["필드", "상태"], Object.keys(unresolved).map(key => [key, "미해결 — 값·승인·원격 검증을 만들어 채우지 않음"])) + "\n";
}
export function operatingInputRows() {
  const result = externalInputs.map(([name, type, holder, value, consumer, source, status]) =>
    [name, type, holder, value, status ?? "미등록/미해결 또는 조건부", source ?? consumer.split(":")[0], consumer]);
  for (const w of workers) {
    for (const [name, value] of Object.entries(w.config.vars ?? {}))
      result.push([name, "Worker Variable", w.config.name, value === "" ? "빈 값" : value,
        value === "" || value === "unset" ? "미해결; 활성화 근거 아님" : "로컬 설정; 원격 미확인",
        `${w.source} → catalog workers.${w.key}.config.vars.${name}`, runtimeConsumers[w.key]]);
    for (const name of w.config.secrets?.required ?? [])
      result.push([name, "Worker Secret", w.config.name, "비밀 값 미열람", "required 이름만 확인; 원격 등록 미확인",
        `${w.source} → catalog workers.${w.key}.config.secrets`, runtimeConsumers[w.key]]);
  }
  for (const [name, source, status] of conditionalSecrets)
    result.push([name, "조건부 Worker Secret", source.startsWith("stats-observer") ? "Observer 알림 기능" : "Router 게시 기능",
      "실제 비밀 값 없음/미확인", "기능 사용 시 코드상 필수; required 선언과 별개", source,
      source.startsWith("stats-observer") ? `${source}:deliverAlert` : `${source}:publicationKeyAvailable`]);
  for (const [name] of publicationActivationInputs)
    result.push([name, "Worker Variable", "Router 게시 설정", "미해결", "실제 소비자 신뢰와 일치 필요",
      "forecast-interactions/src/worker.ts", "publicationKeyAvailable"]);
  for (const [name, value] of analytics.environment.filter(([name]) => !workers.find(w => w.key === "stats").config.vars[name]))
    result.push([name, "Worker Variable", "Stats", value.startsWith("UNCONFIGURED") ? "미해결 — 실제 승인/예산 필요" : value,
      name === "DECISION_ANALYTICS_PUBLICATION_CONTENT_HASH" ? "정적 호환 lane 전용; 운영 dynamic 신뢰 대체 금지" : "미설정; 안전 차단",
      name.includes("MAINTENANCE_ROWS") ? "cloudflare/src/decision-analytics-maintenance.ts" : "cloudflare/src/decision-analytics-handler.ts",
      name.includes("MAINTENANCE_ROWS") ? "maintenanceRows/runDecisionAnalyticsMaintenance" : "analyticsConfig/handleDecisionAnalytics"]);
  for (const [name, value, source] of buildValues)
    result.push([name, "공개 빌드 환경", "검증된 Site 빌드", value === "unresolved" ? "미해결" : value === "production (gated)" ? "production (별도 승인 필요)" : value,
      "공개값만; 실제 신뢰 승인 별도", source, "productionServiceEnvironment/productionForecastBuildEnv/forecastRuntimeBuildPlugin"]);
  for (const prefix of ["SITE", "STATS"]) for (const suffix of ["DEPLOY_WORKER", "DEPLOY_HOSTNAME", "DEPLOY_ACCOUNT_ID"])
    result.push([`${prefix}_${suffix}`, "배포 확인 변수", "수동 배포 환경", "정확한 승인 대상과 일치 필요", "일치하지 않으면 배포 전 차단",
      "scripts/deploy-site.ts", "deploy"]);
  result.push(["GITHUB_SHA / 명시 SHA 인수", "공개 빌드·배포 값", "검토된 후보", "승인된 전체40자리", "receipt/현재 HEAD/깨끗한 작업 트리 확인",
    "scripts/ci/run-checked-command.mjs; vite.config.ts", "childEnvironment; __APP_REVISION__; deploy"]);
  for (const [name, value] of Object.entries(decisionPublicConfiguration))
    result.push([name, "생성 공개 catalog 필드", "public/decision-production-catalog.json",
      value === null ? "미해결" : JSON.stringify(value), "실제 producer/sitekey 미승인으로 disabled",
      `catalog decisionPublicConfiguration.${name}`, "src/analytics/decisionBootstrap.ts:initializeDecisionProduction; createProductionDecision"]);
  result.push(["publications", "생성 공개 catalog 필드", "public/decision-production-catalog.json", "[]",
    "항상 비어 있음; unsigned mapping 금지", "scripts/render-production-operations.mjs",
    "renderDecisionProductionCatalog; initializeDecisionProduction"]);
  return result;
}
export function renderDecisionProductionCatalog(configuration = decisionPublicConfiguration) {
  const tuple = value => value && typeof value.producerVersion === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.producerVersion) &&
    typeof value.producerCodeHash === "string" && /^[a-f0-9]{64}$/.test(value.producerCodeHash);
  if (configuration.enabled !== true)
    return JSON.stringify({ enabled: false,
      producer: { producerVersion: "", producerCodeHash: "" },
      allowedProducers: [], turnstileSiteKey: "", publications: [] }, null, 2) + "\n";
  const { producer, allowedProducers, turnstileSiteKey } = configuration;
  if (!tuple(producer) || !Array.isArray(allowedProducers) ||
      allowedProducers.length < 1 || allowedProducers.length > 2 ||
      !allowedProducers.every(tuple) ||
      new Set(allowedProducers.map(value => value.producerVersion)).size !== allowedProducers.length ||
      !allowedProducers.some(value => value.producerVersion === producer.producerVersion &&
        value.producerCodeHash === producer.producerCodeHash) ||
      typeof turnstileSiteKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(turnstileSiteKey))
    throw new Error("Decision production inputs unresolved; collection cannot be enabled");
  const publicTuple = value => ({
    producerVersion: value.producerVersion, producerCodeHash: value.producerCodeHash,
  });
  return JSON.stringify({
    enabled: true, producer: publicTuple(producer), allowedProducers: allowedProducers.map(publicTuple),
    turnstileSiteKey, publications: [],
  }, null, 2) + "\n";
}
export function renderedProductionFiles() {
  return new Map([...workers.filter(w => !w.releaseDeferred).map(w => {
    let text = renderToml(w.config);
    if (w.preserveUnmanagedStaging) {
      const existing = readFileSync(w.path, "utf8").replaceAll("\r\n", "\n");
      const start = existing.indexOf("\n[env.staging]\n");
      if (start < 0) throw new Error("Expected existing unmanaged observer staging section");
      text += existing.slice(start);
    }
    return [w.path, text];
  }), ["docs/production-operations.md", renderOperations()],
    ["public/decision-production-catalog.json", renderDecisionProductionCatalog()],
    [decisionMetadataInstallationContract.generatedPath, renderDecisionMetadataInstallation()]]);
}
export function renderDecisionMetadataInstallation() {
  if (decisionMetadataInstallationContract.currentValue !== undefined)
    throw new Error("CODEGAP: actual acquisition/mapping policy module requires reviewed implementation");
  return "// Generated from scripts/production-operating-catalog.mjs; do not edit.\n" +
    'import type { DecisionMetadataInstallation } from "../decision-analytics-publication.ts";\n\n' +
    "// CODEGAP: actual acquisition projection and shared mapping policy are not approved.\n" +
    "// No static compatibility fallback or unsigned public mapping is installed.\n" +
    "export const decisionMetadataInstallation: DecisionMetadataInstallation | undefined = undefined;\n";
}
// --write materializes generated artifacts only, never the editable catalog.
if (process.argv[1]?.endsWith("render-production-operations.mjs")) {
  const files = renderedProductionFiles();
  if (process.argv[2] === "--write") {
    for (const [path, text] of files) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  } else if (process.argv[2] === "--check") {
    for (const [path, expected] of files)
      if (readFileSync(path, "utf8").replaceAll("\r\n", "\n") !== expected)
        throw new Error(`Generated production artifact differs: ${path}`);
  } else {
    const text = files.get(process.argv[2]);
    if (text === undefined) throw new Error("Expected --check, --write or an exact generated artifact path");
    process.stdout.write(text);
  }
}
