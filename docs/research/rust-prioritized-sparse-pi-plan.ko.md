# Rust 우선순위 sparse policy iteration 연구 계약

분석 기준: 2026-08-08, 커밋 `6251db3` 위의 미커밋 연구 작업

## 질문과 가설

TypeScript sparse PI는 일부 phase2 fallback 입력의 exact interactive 자원 지표를 개선했지만
phase2보다 3.85~28.58배 느렸습니다. 이번 후보는 같은 raw-stock terminal 목적과 성공확률
gate를 Rust/WASM 내부에서 계산하고, 발견된 root path mass가 큰 상태부터 정책을 개선합니다.

- [가설] 작은 min-E[f] 완료 fixture에서는 전체 eligible successor closure를 검사한
  `completed` 정책이 min-E[f]의 action, 성공확률, 비용, 기대소모 vector와 일치합니다.
- [가설] R10 fallback에서는 작은 update batch가 TypeScript/WASM 왕복과 불필요한 전상태
  재평가를 줄여 4-pass screening 시간을 크게 줄입니다.
- [가설] 우선순위는 탐색 순서만 바꿉니다. `completed`는 전체 발견 closure에서 엄격 개선이
  하나도 없을 때만 허용합니다. pass/state budget 종료는 근사 정책이며 제품 후보가 아닙니다.

우선순위 점수는 정확한 occupancy가 아니라 **현재 평가에서 발견된 최대 root-path 확률**입니다.
합류 경로의 확률을 합산하지 않으므로 품질 보증이 아니라 traversal heuristic입니다.

## 사전 고정 게이트

### 정확성

- min-E[f] 완료 fixture 4개에서 `completed`를 요구합니다.
- first action은 같아야 하고 success/cost는 `1e-12`, vector 3축은 `1e-10` 안에서 같아야
  합니다.
- probability gap은 `1e-12`를 넘을 수 없습니다.
- 기존 min-E[f] semantic bits, node-count golden, phase2 parity는 그대로 통과해야 합니다.

### 용량과 성능

- 연구 state budget은 `1,200,000`입니다. 결과 확인 후 늘리지 않습니다.
- 제품 채택 latency gate는 phase2 대비 warm p95 `max(+15%, +50ms)`입니다.
- 탐색 지속 여부를 판단하는 screening은 R10 `4 passes × 256 updates`가 phase2 대비 1.5배
  이내이고 typed failure가 없을 때만 exact interactive 단계로 진행합니다.
- 제품 WASM raw budget `115KB`를 넘으면 그대로 채택하지 않습니다.

### 품질

- `completed`가 아닌 bounded 정책은 별도 `research_tradeoff` 증거로만 평가합니다.
- exact interactive에서 성공확률은 `1e-12` 이상 낮아지면 안 됩니다.
- interactive F와 총 기대 사용량이 모두 비악화해야 제품 후보가 될 수 있습니다.
- 한 키트의 고갈확률 또는 수동 입력 기대값이 악화되면 개선과 함께 별도 trade-off로
  기록합니다.

## 격리와 중단 조건

후보는 Cargo feature `research-sparse-pi`에서만 빌드하며 `public/solver_rs.wasm`을 교체하지
않습니다. 다음 중 하나면 제품 연구를 중단합니다.

1. 작은 완료 fixture에서 min-E[f] 의미론 불일치
2. R10 exact closure가 state budget을 초과
3. R10 screening latency gate 실패
4. exact interactive 공통 품질 gate 실패
5. raw WASM budget 초과가 확인되고 성능·품질 신호가 후속 크기 최적화를 정당화하지 못함

중단 후에는 제품 runtime을 연결하지 않습니다. 재현 가능한 evaluator, fixture, typed outcome,
보고서만 보존하고 생성된 대량 JSON/WASM은 `output/` 또는 gitignored 결과 경로에 둡니다.
