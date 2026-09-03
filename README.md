# Evidence Based Slopedia

Evidence Based Slopedia（EBS）は、Evidence-Basedで高品質な「AI slop」を量産する、半分ネタで半分本気の知識サイト／編纂システムである。雑に大量生成するのではなく、ソース、引用、反証、限界、更新履歴を通して、読める・検証できる記事へ仕上げる。

このリポジトリは、記事の原稿・Evidence・自動生成パイプライン・Discord Bot・静的サイトビルドをまとめたEBSの運用ルートである。Obsidianは編集・監査用のバックエンドとして利用できるが、最終的な読者向け成果物は静的サイトとして`dist/`に生成される。

## 目的

EBSの目的は、ユーザーが与えた問いを起点に、ソースに基づいた、読み応えがあり、更新可能で、必要なら笑えるpublish-ready記事を継続的に作ることである。

publish記事は、教科書的・参考書的・レビュー的であり、歴史的背景、現代の標準的理解、実践・応用・限界・論争点、番号付き引用、URL付き参考ソース、日本語インフォグラフィック、更新履歴、更新日付を備える。

## 自走ワークフロー

EBS関連タスクを実行するCodexは、`.agents/skills/`の定義に従って、調査・執筆・監査・公開準備まで自走する。安全性、合法性、プライバシー、破壊的ファイル操作、重大な範囲不明だけは確認対象とする。

## ディレクトリ構造

```text
Evidence-Based-Everything/
├─ AGENTS.md
├─ README.md
├─ 00_Index/
├─ 10_Published/
├─ 20_EvidencePackets/
├─ 30_Sources/
├─ 40_Claims/
├─ 50_Assets/
├─ 60_MOCs/
├─ 70_Logs/
├─ _working/
├─ _archive/
├─ config/
├─ scripts/
└─ .agents/
   └─ skills/
```

## 主な領域

- `00_Index/`: EBEの入口、全体MOC、Style Guide、Citation Policy、Source Policy、Infographic Policy、Update Policy、Taxonomy Policy、Confidence Scale、Skill Mapを置く。
- `10_Published/`: Publish Gateを通過した最終記事だけを置く。記事は必ず小分野ディレクトリ内に保存する。
- `20_EvidencePackets/`: publish済み記事に紐づく最終Evidence Packetを置く。draftや探索メモは置かない。
- `30_Sources/`: publish済み記事を支える最終source noteを置く。候補ソースや仮registryは `_working/` に置く。
- `40_Claims/`: publish済み記事を監査するための最終claim noteまたはclaim tableを置く。仮抽出は `_working/claim_tables/` に置く。
- `50_Assets/`: 画像、インフォグラフィック、図表、添付ファイルを置く。
- `60_MOCs/`: 全体MOC、記事一覧、ソース一覧、claim一覧、最近更新された記事の索引を置く。
- `70_Logs/`: publish、citation audit、quality audit、infographic generation、taxonomy、updateなどのイベントログを置く。
- `_working/`: draft、temporary source note、source registry、claim table、evidence packet draft、infographic brief、search log、review reportなど、publish前の作業成果物を置く。

## 中間生成物の扱い

EBEの成果物はライフサイクルで分ける。`_working/` は未公開・暫定・失敗Gate・作業中の唯一の置き場であり、`20_EvidencePackets/`、`30_Sources/`、`40_Claims/` はPublish Gate通過後に昇格した耐久証跡だけを置く。`70_Logs/` は作業成果物ではなく、監査・生成・分類・更新などのイベント記録を置く。

正規定義は `00_Index/EBE - Artifact Lifecycle Policy.md` と `.agents/skills/EBE-SHARED-CONTRACT.md` にある。

## Publish Gate

`10_Published/` に置けるのはPublish Gateを通過した記事だけである。主な条件は、published frontmatter、引用番号、URL付き参考ソース、日本語インフォグラフィック、歴史的背景、現代理解、限界、更新履歴、MOC更新である。

## Skills

正規のSkills配置は `.agents/skills/` である。トップレベルの `skills/` は作成しない。

共通契約は `.agents/skills/EBE-SHARED-CONTRACT.md` に集約されている。各 `SKILL.md` はこの共有契約を継承し、個別の役割・入出力・ワークフロー・禁止事項だけを定義する。EBEタスクではまず `ebe-orchestrator` と共有契約を読み、必要な専門Skillへ進む。

## Discord Bot Automation

The bot's deployment verification requires `EBS_PAGES_PUBLIC_URL` in
`automation/discord_bot/.env`. Set it to the actual public site URL, including
the Pages project path. This is configuration, not source code, so a domain
change only requires updating `.env` and restarting the bot. See
`automation/discord_bot/README.md` for temporary and permanent Windows startup
settings, including `ComSpec`/`SystemRoot` required by non-interactive worker
processes.

責務分離とvalidationの配置は [`docs/ARCHITECTURE-AUDIT.md`](docs/ARCHITECTURE-AUDIT.md) にまとめている。

このリポジトリには、DiscordのSlash CommandからEBS記事生成・一括記事生成・運用コマンドを実行するBot実装が含まれている。

```text
Discord /article
  -> Botがjobをqueueへ登録
  -> Codexが隔離されたGit worktreeでEBS workflowを実行
  -> Publish Gateを通過したjobだけmainへmerge/commit/push
  -> static buildでdist/を生成
  -> GitHub Pages等の静的ホスティングへdeploy
```

主なコマンドは次の通り。

- `/article query:"..." mode:new`: 1本の記事作成または更新をキューに入れる。
- `/multi_article query:"英文法を網羅" count:15`: テーマを分解し、複数の記事タイトル案を作って記事jobをまとめてキューに入れる。
- `/codex query:"..."`: 管理者専用。VaultルートでCodex CLIを直接実行する。通常の記事publish flowとは別で、worktree作成や自動pushはしない。
- `/daily-news`: 管理者専用。日次ニュース記事をまとめてキューに入れる。
- `/moc-maintenance`: 管理者専用。公開記事や日次記事のMOCを再構成する。
- `/image_maintenance`: 管理者専用。公開記事や日次記事の画像パスを点検・修復する。記事生成後にも画像パス検査が走り、壊れた画像参照が残るjobはpublishされない。
- `/job-status job_id:"..."`: jobの状態・worktree・エラー・commitを確認する。
- `/job-list`: 最新50件までのjobを表示する。
- `/worker-list`: 実行中workerを表示する。
- `/job-cancel job_id:"..."`: queued/running jobをキャンセルする。queued jobはworkerに渡らない。
- `/job-retry job_id:"..."`: failed、failed_review_required、cancelled jobを再キュー投入する。
- `/job-cleanup older_than_days:7 dry_run:true`: 古い終了済みjobのworktree、runtime log、JobStore履歴を一覧化または削除する。succeeded、failed、failed_review_required、cancelledが対象で、queued/runningは残す。
- `/queue-pause` / `/queue-resume`: 新しいqueued jobの開始を停止・再開する。
- `/auto-status`: 自律生成の状態、候補、上限、queueを表示する。
- `/auto-pause` / `/auto-resume`: 自律生成の定期実行を停止・再開する。
- `/auto-run`: 管理者専用。自律生成schedulerを1 tickだけdry-run実行する。
- `/git-status`: Vault repositoryの状態を表示する。
- `/git-debug action:status|all`: 管理者専用のGit診断・同期コマンド。
- `/bot-health`: Bot、queue、worker、CPU、memoryの状態を表示する。

Bot本体は `automation/discord_bot/` にある。詳しいセットアップは `automation/discord_bot/README.md` を参照する。

### 公開記事の扱い

`10_Published/` は公開可能な最終記事だけを置く領域である。公開に向かない記事、個人プロフィール性が強い記事、ギャンブル・投機・センシティブテーマの記事は、必要に応じて削除または非公開領域へ退避し、MOC・証跡・画像・ログも整合するように更新する。

### 静的サイトとして公開する

EBSの読者向けサイトは、MarkdownやVaultを直接配信せず、ビルドで生成した`dist/`を静的ホスティングへ配置する。

```powershell
cd automation/discord_bot
npm run ebs -- rebuild --json
```

`dist/`にはトップページ、記事ページ、検索用JSON、RSS、sitemap、CSSなどの配信可能なファイルが生成される。公開される画像はWebPに正規化され、原本のPNG/JPEGは公開記事領域に残さない。GitHub Pages、Cloudflare Pages、Netlify、Vercelなど、静的ファイルを配信できるサービスを想定する。

GitHub Pagesへ配置する場合は、Pages用リポジトリを別ディレクトリにcloneし、`.env`で`EBS_GITHUB_PAGES_DIR`を指定する。deploy処理が`dist/`を同期し、Pages用repositoryの差分確認、commit、pushまで行う。

```powershell
npm run ebs -- deploy --dry-run --json
npm run ebs -- deploy --json
```

差分がない場合はno-opとして正常終了する。remoteとbranchは`EBS_PAGES_GIT_REMOTE`（既定値`origin`）、`EBS_PAGES_GIT_BRANCH`（既定値`main`）で変更できる。Pages用repositoryの`.git`は同期処理で保持される。本リポジトリはGitHub Actionsを使わず、常駐サーバーPCから直接deployする。

### サーバーPCのディレクトリ構造

Botを常駐させる場合、Vault本体、worker worktree、Botのruntime state、Pages公開用repositoryを分離する。

```text
C:\EBS\
├─ Evidence-Based-Slopedia\        # EBE_VAULT_ROOT（source/Vault repository）
├─ Evidence-Based-Slopedia-Pages\ # EBS_GITHUB_PAGES_DIR（任意）
├─ worktrees\                      # EBE_WORKTREE_ROOT
└─ discord_bot-runtime\            # EBE_BOT_RUNTIME_DIR
   ├─ data\                        # jobs.jsonなど
   ├─ autonomous\                  # 自律候補registry
   └─ logs\                        # job runtime log
```

```env
EBE_VAULT_ROOT=C:\EBS\Evidence-Based-Slopedia
EBE_WORKTREE_ROOT=C:\EBS\worktrees
EBS_GITHUB_PAGES_DIR=C:\EBS\Evidence-Based-Slopedia-Pages
EBE_BOT_RUNTIME_DIR=C:\EBS\discord_bot-runtime
EBE_BOT_DATA_DIR=C:\EBS\discord_bot-runtime\data
EBE_BOT_LOG_DIR=C:\EBS\discord_bot-runtime\logs
```

`EBS_PAGES_PUBLIC_URL` belongs only in the local Bot `.env`; do not commit it.
Keep `jobs.json` and logs in the external runtime directory rather than in the
Vault checkout. See `automation/discord_bot/README.md` for Windows startup
details.

`EBE_WORKTREE_ROOT`とruntime directoryはVaultの配下に置かない。Pages deployでは公開repository内の`.git`を保持し、`dist/`同期後に差分がある場合だけcommit/pushする。

### ソースと公開物の分離

- source repository: 記事原稿、Evidence、Bot、設定、生成コードを管理する。
- static site: `dist/`だけをホスティングへ渡す。
- secrets: GitHub Secrets、`.env`、ローカル認証情報として管理し、Gitに入れない。

### 公開記事リポジトリ（任意）

公開記事を蓄積するrepositoryと、ビルド済み静的サイトを配信するPages repositoryは別用途である。Pages repositoryを使う場合は、常駐Botのdeploy処理が`dist/`を同期し、`.git`を保持したまま差分がある場合だけcommit/pushする。GitHub Actionsは必須ではなく、現行のPages deployでは使用しない。

記事ソースの管理repository、公開記事repository、ビルド済みPages repositoryを分ける場合は、それぞれの同期処理を混同しないこと。公開用repositoryへは、認証情報や`_working/`、runtime state、ログを含めない。

### Obsidianで読む

PCでは、このリポジトリをObsidian Vaultとして開けばよい。

スマートフォンやタブレットで読む場合は、次のどちらかを使う。

1. Git連携でprivate repositoryをpullする。
2. Obsidian Syncなど、利用者自身の同期手段でVaultを同期する。

Git連携を使う場合、モバイル側は基本的に閲覧・pull専用にすると衝突が少ない。記事生成とpushは常駐Botを動かすマシンに集約する。

## License

This project is licensed under the MIT License. See `LICENSE`.
