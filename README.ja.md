# NIKKE コレクションアイテム レベルアップ計算機

[한국어](./README.md) | [English](./README.en.md) | **日本語**

[計算機を開く](https://just-goforward.github.io/Nikke-Collection-Item-Calculator/)

『勝利の女神：NIKKE』のコレクションアイテム・宝もの育成を支援する非公式ブラウザツールです。現在の等級、レベル、EXP、メンテナンスキットの所持数を入力すると、次の推奨行動と予想結果を計算します。韓国語・英語・日本語に対応し、PC・タブレット・モバイルで利用できます。

## 主な機能

- 等級、レベル、現在EXP、キット在庫に基づく次の行動の推奨
- SR15到達率、予想キット消費量、在庫負担による候補比較
- 大成功結果を反映した連続計算とR15からSR等級への交換フロー
- Rust/WebAssembly製`min-E[f]` solverとRust phase2 fallback
- 推奨結果を確認する独立した検算処理
- 利用環境とsolver使用状況に関する公開集計統計
- ライト・ダークテーマ、および韓国語・英語・日本語UI

## 計算方法

Solverは最初にSR15への到達確率を最大化し、同じ確率範囲では現在の在庫と今後の期待獲得量を考慮して、キット負担を抑える行動を探索します。通常はRust `min-E[f]`を使用し、メモリまたは時間制限内に完了できない場合はRust phase2を復旧経路として使用します。

結果は入力された状態と現行実装のゲームルールに基づく確率的な推奨です。大成功の発生や特定の結果を保証するものではありません。Solverの意味論と方針品質の測定記録は[研究・技術資料](#研究技術資料)を参照してください。

## プライバシーと統計

計算はブラウザ内で実行されます。統計機能はサービスとsolverの動作確認に必要な限定的な集計イベントをCloudflare D1へ記録します。アカウント、氏名、メールアドレス、キット在庫の生データは収集しません。イベント件数はユニークユーザー数を意味しません。

セキュリティ上の問題は公開Issueではなく、[セキュリティポリシー](./SECURITY.md)に記載された非公開の報告窓口を利用してください。

## ローカル開発

必要な環境:

- 最新のNode.jsとnpm
- `wasm32-unknown-unknown` targetを追加したRust toolchain

```powershell
npm install
npm run dev
```

本番ビルドではRust solverをWebAssemblyへ再ビルドした後、Vite frontendを生成します。

```powershell
npm run build
```

主な検証コマンド:

```powershell
npm run typecheck
npm run lint
npm test
npm run test:worker
npm run build
npm run report:bundle
```

## 研究・技術資料

- [28日基準のメンテナンスキット期待獲得量（韓国語）](./docs/research/kit-expected-gain.ko.md)
- [min-E[f] H/p共同最適化研究（韓国語）](./docs/research/min-ef-hp-study-findings.ko.md)
- [Solver方針品質研究（英語）](./docs/research/solver-policy-quality-findings.md)
- [Rust phase2方法論研究（英語）](./docs/research/phase2-methodology-findings.md)
- [次世代solver・プラットフォーム研究（英語）](./docs/research/next-solver-research-findings.md)
- [条件付きsolver portfolio研究（英語）](./docs/research/solver-portfolio-findings.md)
- [アプリアイコンの原本画像](./docs/assets/app-icon-source.png)

実際のUIではruntime CSSとcomponentが正本です。デザイン値を別の文章仕様として重複管理せず、visual・alignment・compatibilityテストで観測可能なレイアウトを保護します。

## ライセンス

Copyright (C) 2026 just-goforward and contributors.

別途明記された第三者コンポーネントを除き、本プロジェクトは[GNU Affero General Public License v3.0 or later](./LICENSE)で配布されます。公開サイトはビルドに使用したGit commitへのソースリンクを表示し、ネットワーク利用者が対応するソースを取得できるようにしています。詳細は[第三者通知](./THIRD_PARTY_NOTICES.md)を参照してください。

PretendardフォントファミリーはSIL Open Font License 1.1に従い、AGPLへ再ライセンスされません。

NIKKEおよび関連する名称・素材の権利は各権利者に帰属します。本プロジェクトはゲームの開発元またはパブリッシャーと提携しておらず、承認を受けた公式サービスでもありません。
