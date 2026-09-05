# NIKKE 소장품 레벨업 계산기

**한국어** | [English](./README.en.md) | [日本語](./README.ja.md)

[웹에서 계산기 사용하기](https://nikkecollection.com/)

승리의 여신: 니케의 소장품·애장품 레벨업 과정에서 현재 경험치와 보유 관리 키트를 입력하면, 다음 행동과 예상 결과를 계산해 주는 비공식 웹 도구입니다. 설치 없이 브라우저에서 사용할 수 있으며 한국어, 영어, 일본어와 PC·태블릿·모바일 화면을 지원합니다.

## 주요 기능

- 등급, 레벨, 현재 경험치, 키트 재고를 반영한 다음 행동 추천
- 추천 외 후보의 SR15 도달률, 예상 키트 소모량, 재고 부담 비교
- 대성공 결과를 반영한 연속 계산과 R15에서 SR 등급으로의 교체 흐름
- Rust/WebAssembly 기반 `min-E[f]` solver와 Rust phase2 fallback
- 별도 검산 실행을 통한 추천 결과 확인
- 대성공률과 키트 사용량을 구간·키트별로 집계한 공개 통계
- 라이트·다크 테마 및 한국어·영어·일본어 UI

## 계산 방식

Solver는 먼저 SR15 도달 확률을 최대화하고, 같은 확률 범위에서는 보유 재고와 향후 획득량을 고려해 키트 부담을 줄이는 행동을 찾습니다. 기본 경로인 Rust `min-E[f]`가 메모리 또는 시간 한계로 완료되지 못하면 Rust phase2가 복구 경로로 실행됩니다.

계산 결과는 입력한 상태와 현재 구현된 게임 규칙을 바탕으로 한 확률적 추천입니다. 실제 대성공 발생 여부를 예측하거나 특정 결과를 보장하지 않습니다. Solver의 의미론과 정책 품질에 관한 측정 기록은 [연구 문서](#연구-및-기술-기록)에서 확인할 수 있습니다.

## 개인정보 및 통계

계산은 브라우저 안에서 수행됩니다. 통계 기능은 결과가 확정된 이벤트의 등급·단계·사용 키트·시도 횟수·대성공 횟수 등을 Cloudflare D1에 집계합니다. 계정·이름·이메일·고유 사용자 식별자와 원본 키트 재고는 수집하지 않습니다.

공개 `/api/stats`는 대성공·키트 사용에 관한 집계만 반환합니다. 출처 호스트, 클라이언트 환경, solver 진단과 실패 관측은 공개 응답에 포함되지 않으며 운영 점검용 비공개 버킷 집계로만 관리됩니다. 실패 관측에도 정확한 재고, IP, 사용자 식별자, 원문 오류와 스택은 저장하지 않습니다. 통계의 이벤트 수는 고유 사용자 수를 뜻하지 않습니다.

보안 문제는 공개 이슈 대신 [보안 정책](./SECURITY.md)에 안내된 비공개 신고 경로를 이용해 주세요.

## 로컬 개발

필요 환경:

- Node.js 24.x와 npm 12.x(현재 CI 검증 기준)
- [`rust-toolchain.toml`](./rust-toolchain.toml)이 고정한 Rust 1.98.0 및 `wasm32-unknown-unknown` target

```powershell
npm install
npm run dev
```

프로덕션 빌드는 Rust solver를 WebAssembly로 다시 빌드한 뒤 Vite frontend를 생성합니다.

```powershell
npm run build
```

주요 검증 명령:

```powershell
npm run typecheck
npm run lint
npm test
npm run test:workers
npm run build
npm run report:bundle
```

앱과 스크립트는 Vitest 5를 사용하고, Cloudflare Worker workspace 여섯 곳은 공식 plugin과
호환되는 Vitest 4를 사용합니다. `npm run lint`가 이 런타임 경계를 함께 검사합니다.

## 연구 및 기술 기록

- [전체 연구 문서 색인](./docs/research/README.md)
- [28일 기준 관리 키트 기대 획득량](./docs/research/kit-expected-gain.ko.md)
- [일정 기반 키트 수급 Forecast 계약](./docs/research/schedule-supply-forecast.ko.md)
- [min-E[f] H/p 공동 최적화 연구](./docs/research/min-ef-hp-study-findings.ko.md)
- [Solver 정책 품질 연구](./docs/research/solver-policy-quality-findings.ko.md)
- [Rust phase2 방법론 연구](./docs/research/phase2-methodology-findings.ko.md)
- [차세대 solver·플랫폼 연구](./docs/research/next-solver-research-findings.ko.md)
- [조건부 solver portfolio 연구](./docs/research/solver-portfolio-findings.ko.md)
- [Rust 1.98 toolchain 갱신 검증](./docs/research/rust-1.98-upgrade.ko.md)
- [앱 아이콘 원본 이미지](./docs/assets/app-icon-source.png)

실제 UI의 정본은 runtime CSS와 component입니다. 별도 디자인 명세를 중복 관리하지 않으며 visual, alignment, compatibility 테스트로 관측 가능한 레이아웃을 보호합니다.

## 라이선스

Copyright (C) 2026 just-goforward and contributors.

별도로 고지된 제3자 구성요소를 제외한 이 프로젝트는 [GNU Affero General Public License v3.0 or later](./LICENSE)로 배포됩니다. 웹 배포본 하단의 소스 링크는 해당 빌드에 사용된 Git commit을 가리킵니다. 자세한 내용은 [제3자 고지](./THIRD_PARTY_NOTICES.md)를 참고하세요.

Pretendard 계열 글꼴은 SIL Open Font License 1.1을 따르며 AGPL로 재라이선스되지 않습니다.

NIKKE 및 관련 명칭과 자산의 권리는 각 권리자에게 있습니다. 이 프로젝트는 게임 개발사 또는 퍼블리셔와 제휴하거나 그 승인을 받은 공식 서비스가 아닙니다.
