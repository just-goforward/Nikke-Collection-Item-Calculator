# Rust 1.98 toolchain 갱신 검증

검증일: 2026-08-24

기준 commit: `b3d72883b6cb6b62b8ee322603453f826e0ac5a0`

## 결론

- `[확인]` Rust 1.97.1과 1.98.0으로 같은 소스를 격리 빌드한 WASM은 모두 100,674 bytes이며 import 0개, export 100개, `target_features`가 동일하다.
- `[확인]` min-E[f] 두 fixture와 phase2 한 fixture에서 action, 성공확률, 기대 소비 vector, 비용의 binary64 bit pattern이 모두 동일하다. terminal-cache 재사용·release 수명과 WASM page growth도 동일하다.
- `[확인]` Node 31회 ABBA 캠페인 2회에서 모든 solve가 `completed`였고 compile, instantiate, cold/warm p50 비회귀 기준을 통과했다. 첫 캠페인의 일부 p95 상승은 두 번째 캠페인에서 반복되지 않았다.
- `[판정]` 제품 toolchain과 WASM을 Rust 1.98.0으로 갱신한다. solver 알고리즘과 정책 버전은 변경하지 않는다.
- `[미검증]` 이 비교는 Windows x64 Node 및 소규모 Chromium direct-ABI smoke 근거다. 실제 사용자 기기 성능 분포를 뜻하지 않는다.

## 공식 변경점 영향

Rust 1.98의 공식 발표와 상세 release notes를 현재 crate에 대조했다.

| 변경 | 프로젝트 영향과 판정 |
| --- | --- |
| `invalid_runtime_symbol_definitions`, `suspicious_runtime_symbol_definitions` lint | crate의 `#[no_mangle]` WASM export를 1.98 Clippy `-D warnings`로 검사했으며 진단이 없었다. export 이름과 종류는 후보 검증기로 별도 고정한다. |
| `c_void_returns` lint | solver에 `c_void` 반환 ABI가 없고 새 경고도 발생하지 않았다. |
| 모호한 import/glob 및 `repr(transparent)`·`transmute` 호환성 강화 | 현재 소스는 1.98 build/Clippy를 통과했으며 관련 `transmute`, `repr(transparent)`, trait-object lifetime 패턴이 없다. |
| `PartialOrd` derive fast path | solver의 정책 비교 의미론에 해당 derive/manual `Ord` 조합이 없어 영향이 없다. |
| `f32`/`f64::algebraic_*` 안정화 | 채택하지 않는다. 이 API는 대수적 재결합을 허용하므로 operand order와 binary64 bit golden을 보호하는 solver 계약에 맞지 않는다. |
| 새 문자열·정수·atomic API | 현재 hot path의 상태 표현·memo 접근을 단순화하지 않으며 성능 근거 없이 적용할 이유가 없다. |
| Cargo 1.98 | 이 dependency-free crate의 build graph나 release profile에 영향을 주는 stable Cargo 변경은 확인되지 않았다. |

공식 자료:

- <https://blog.rust-lang.org/2026/08/20/Rust-1.98.0/>
- <https://doc.rust-lang.org/releases.html#version-1980-2026-08-20>
- <https://doc.rust-lang.org/nightly/cargo/CHANGELOG.html#cargo-198-2026-08-20>

## Artifact 및 의미론 비교

| 항목 | Rust 1.97.1 | Rust 1.98.0 |
| --- | --- | --- |
| LLVM | 22.1.6 | 22.1.8 |
| SHA-256 | `ba0f3da54e01f1baedab46d6e49edf10d034e65a385e168c9f15d991817b661e` | `6d379139c065961d336d08a53ad7bf803b33acf2a14ec98d5a0a93a13ef8f4ce` |
| raw bytes | 100,674 | 100,674 |
| imports / exports | 0 / 100 | 0 / 100 |
| small page growth | 120,193,024 | 120,193,024 |
| maximum page growth | 130,875,392 | 130,875,392 |

검증한 의미론 fixture:

- min-E[f] `R0 / [60,120,900]`: first action `blue`, expected-cost bits `0x3fbf64e435ab1f1e`
- min-E[f] `SR5 / [300,300,300]`: first action `yellow`
- phase2 `R1 / [100,100,100]`: first action `purple`, state count 217,763
- 모든 fixture에서 후보별 확률·vector·cost bit pattern까지 base/candidate가 동일

## 성능 비교

환경은 Node 24.19.0, Windows x64, Ryzen 5 5600이다. 각 캠페인은 base/candidate 순서를 교차하고 각 조합을 31회 측정했다. 아래 값은 paired solve-time ratio의 median이며 1보다 작으면 1.98 후보가 빠르다.

| 시나리오 | 단계 | 캠페인 1 | 캠페인 2 |
| --- | --- | ---: | ---: |
| R0 remainder | instance cold | 0.9993 | 0.9939 |
| R0 remainder | allocation warm | 0.9950 | 0.9906 |
| SR5 balanced | instance cold | 0.9973 | 0.9961 |
| SR5 balanced | allocation warm | 0.9980 | 1.0024 |

첫 캠페인에서 R0 warm p95가 약 9.3% 높았지만 두 번째 캠페인에서는 약 1.5% 낮았다. SR5 warm p95는 첫 캠페인 약 5.3%, 두 번째 약 1.9% 높아 반복 확인 기준을 넘지 않았다. 따라서 p50 비회귀는 확인됐고, 재현 가능한 p95 퇴행 증거는 확인되지 않았다. 이는 1.98이 더 빠르다는 증명이 아니다.

## 함께 수정한 검증 경계

- 후보 validator와 browser direct-ABI benchmark가 dynamic gain 도입 전의 7-argument `solveMinEf` ABI를 사용하던 문제를 수정했다.
- 후보 validator가 min-E[f]뿐 아니라 phase2 snapshot, import/export 계약, `target_features`까지 비교하게 했다.
- terminal-cache 최적화의 3% 개선 게이트와 toolchain 갱신의 비회귀 게이트를 분리했다. 동일 benchmark에 서로 다른 채택 목적을 섞지 않는다.

이번 변경은 일정 기반 forecast의 활성화와 무관하다. staging shadow 검증이 끝나기 전까지 제품은 기존 활성 forecast를 계속 사용한다.
