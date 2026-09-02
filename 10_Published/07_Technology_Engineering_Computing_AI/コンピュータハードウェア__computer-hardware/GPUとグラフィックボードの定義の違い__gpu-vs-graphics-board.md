---
project: "Evidence Based Everything"
title: "GPUとグラフィックボードの定義の違い"
status: published
draft: false
publish_ready: true
review_status: passed
article_type: reference
created: 2026-09-02
updated: 2026-09-02
last_verified: 2026-09-02
freshness_ttl: "90 days"
question: "GPUとグラフィックボードの定義の違いについて"
question_type: mixed
claim_types: [definitional, comparative, technical, historical, procedural]
category_id: "07"
category_name: "技術・工学・コンピューティング・AI"
category_path: "10_Published/07_Technology_Engineering_Computing_AI"
subfield_name: "コンピュータハードウェア"
subfield_path: "10_Published/07_Technology_Engineering_Computing_AI/コンピュータハードウェア__computer-hardware"
moc: "[[MOC - コンピュータハードウェア]]"
domain_profile: technology_engineering
evidence_standard: "official documentation, specifications, reproducible examples, benchmarks"
confidence: high
confidence_reason: "GPUの定義と統合・ディスクリート形態、graphics cardとの区別をメーカー公式資料が直接説明しているため。"
has_infographic: true
infographic_path: "50_Assets/Infographics/gpu-vs-graphics-board_infographic.png"
source_count: 4
claim_count: 5
references_style: "numbered with URL and Accessed date"
tags: [GPU, グラフィックボード, コンピュータハードウェア]
---

![[50_Assets/Infographics/gpu-vs-graphics-board_infographic.png]]
*GPUは演算を担うチップ、グラフィックボードはGPUと周辺部品を載せた基板、という包含関係で捉える。[1][2][3]*

# 概要

GPU（Graphics Processing Unit）は、主に画像・映像処理を高速化するプロセッサです。一方、グラフィックボード（graphics card / video card）は、GPUを含む複数の部品を一枚の拡張基板にまとめた製品です。[1][2] したがって、両者は同義ではなく、「GPUは部品・機能単位、グラフィックボードは製品・基板単位」と考えると混乱しません。

## この記事の見取り図

1. GPUとグラフィックボードの定義を分ける。
2. 統合GPUとディスクリートGPUを比較する。
3. 購入・接続・性能評価での用語の使い分けを確認する。
4. 日常語が厳密な定義を曖昧にする場面と限界を整理する。

## 定義と全体像

### GPUとは何か

GPUは、グラフィックス処理を起点として発展した専用プロセッサです。多数のデータを並列に処理しやすい性質を持つため、現在はゲームや映像だけでなく、機械学習、動画編集、科学計算などにも利用されます。[1][2] ただしGPUは「映像を映す装置全体」ではなく、計算・処理を担う中核です。

### グラフィックボードとは何か

グラフィックボードは、GPUを搭載し、コンピュータへ接続するための拡張基板です。製品には典型的にGPU、グラフィックスメモリ（VRAM）、電源回路、冷却機構、映像出力端子、基板や接続端子などが組み合わされます。[2][3] これらの構成は製品ごとに異なり、すべてが同じ仕様とは限りません。

## 歴史的背景・古典的理解

初期のGPUは、リアルタイム3D描画を高速化する固定機能ハードウェアとして登場し、その後、プログラム可能な処理へ発展しました。[1] NVIDIAは1999年にGeForce 256を「GPU」として市場投入したと記録しています。[4] この時期以降、単なる「ビデオアクセラレータ」から、独立した演算資源としてGPUを捉える呼称が普及しました。

## 現在の標準的理解

GPUには大きく、CPUやSoCに組み込まれた統合GPU（iGPU）と、プロセッサから分離されたディスクリートGPU（dGPU）があります。[2][3] 統合GPUは一般にシステムメモリを共有し、省電力・小型化に有利です。ディスクリートGPUは専用メモリを持つ構成が多く、電力と発熱が増える代わりに、高負荷のグラフィックス処理に向きます。[3]

ここで重要なのは、統合GPUには独立したグラフィックボードが存在しない場合があることです。逆に、デスクトップ用のディスクリート型では、GPUがグラフィックボード上に搭載されます。[2]

## 詳細説明

| 用語 | 指すもの | 典型的な位置 | 主な役割 |
|---|---|---|---|
| GPU | グラフィックス処理プロセッサ | CPU内蔵または別チップ | 並列計算・描画 |
| グラフィックボード | GPUを含む拡張基板・製品 | PCI Expressなどに接続 | GPUを動かし、電力供給・冷却・映像出力まで担う |
| 統合GPU | CPU等に組み込まれたGPU | CPU/SoC内 | 省電力な描画・メディア処理 |
| ディスクリートGPU | プロセッサから分離したGPU | 独立チップまたはグラフィックボード | 高性能な描画・並列処理 |

### 具体例で考える

ノートPCの「内蔵GPU」はGPUですが、独立したグラフィックボードを搭載しているとは限りません。[2] デスクトップPCに増設するGeForceやRadeonのカードは、GPUだけでなく、VRAM、冷却ファン、電源回路、映像出力を含むグラフィックボードです。製品名やシリーズ名はメーカー・世代で変わるため、比較するときはGPUの型番だけでなく、VRAM容量、消費電力、冷却、出力端子なども確認します。

## 応用・実践上の含意

- 「GPUがあるか」は、統合GPUを含めて処理チップの有無を問う表現です。
- 「グラフィックボードを増設するか」は、独立した基板製品を取り付けるかを問う表現です。
- ゲームや3D制作では、GPU性能だけでなくVRAM、冷却、電源容量、ケース寸法、接続端子との適合を確認します。
- CPU内蔵GPUを使う場合、メモリをCPUと共有する構成があるため、システム全体のメモリ設計も性能に関係します。[3]

## 限界・論争点・未解決事項

「GPU」と「グラフィックカード」は日常会話や製品広告で交換可能に使われることがあります。実際、メーカー資料でもディスクリートGPUを「dedicated graphics card」と説明する例があります。[2][3] そのため、会話の場では相手がチップを指しているのか、カード全体を指しているのかを文脈で確認する必要があります。

また、統合GPU、SoC内のGPU、外付けGPU、サーバー向けアクセラレータなど、実装形態は多様です。「グラフィックボードには必ず専用VRAMや補助電源がある」といった断定は避けるべきです。最終的な性能や互換性は個別製品の公式仕様で確認してください。

## まとめ

GPUはグラフィックス処理を担うプロセッサであり、グラフィックボードはGPUと周辺部品を載せた拡張基板です。GPUはCPUやSoCに内蔵されることも、独立したグラフィックボードに搭載されることもあります。[1][2][3] 「GPU＝中核チップ」「グラフィックボード＝それを含む製品」と覚えるのが最も実用的です。

## 参考ソース

1. NVIDIA, “1.1. Introduction — CUDA Programming Guide”, 2026, Accessed 2026-09-02. https://docs.nvidia.com/cuda/cuda-programming-guide/01-introduction/introduction.html
2. Intel, “What Is a GPU?”, 公開日不詳, Accessed 2026-09-02. https://www.intel.com/content/www/us/en/products/docs/processors/what-is-a-gpu.html
3. Intel, “What Is the Difference Between Integrated Graphics and Discrete Graphics?”, Reviewed 2024-09-04, Accessed 2026-09-02. https://www.intel.com/content/www/us/en/support/articles/000057824/graphics.html
4. NVIDIA, “NVIDIA Corporate Timeline”, 公開日不詳, Accessed 2026-09-02. https://www.nvidia.com/content/timeline/time_99.html

## 更新履歴

- 2026-09-02: 新規作成。GPU、グラフィックボード、統合GPU、ディスクリートGPUの定義を公式資料で整理。

## 更新日付

2026-09-02
