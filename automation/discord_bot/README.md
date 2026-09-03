# EBS Discord Bot

## Runtime configuration and Windows startup

Copy `.env.example` to `.env` and keep `.env` local; it contains credentials and
machine-specific paths. `EBS_PAGES_PUBLIC_URL` is required for deployment
verification when auto-deploy is enabled. It must be the public URL that serves
the Pages repository, including its project path, for example:

```env
EBS_PAGES_PUBLIC_URL=https://your-account.github.io/your-pages-repository/
```

Changing domains does not require a code change: update this value and restart
the bot. `.env` is loaded from `automation/discord_bot`, so starting the bot
from another working directory without setting `EBS_BOT_ROOT`/paths can load a
different configuration than expected.

For a temporary Windows session, set the variables before starting Node:

```bat
set EBS_PAGES_PUBLIC_URL=https://your-account.github.io/your-pages-repository/
set ComSpec=C:\Windows\System32\cmd.exe
set COMSPEC=C:\Windows\System32\cmd.exe
set SystemRoot=C:\Windows
npm start
```

For permanent operation, store `EBS_PAGES_PUBLIC_URL` in the bot `.env` and
configure the Task Scheduler/service launcher to start in this directory.
The launcher must provide the standard Windows shell variables above because
non-interactive tasks may not inherit them. After source or configuration
changes, run `npm run build` and restart the bot; `npm start` executes `dist/`,
not TypeScript source directly. Never commit `.env` or credentials.

Evidence Based Slopedia（EBS）をDiscordから操作するためのBotである。DiscordのSlash Commandから記事生成、複数記事の一括キュー投入、日次ニュース作成、MOC整備、Git状態確認、VaultルートでのCodex実行を行える。

## できること

```text
Discord command
  -> Botがjobをqueueへ登録
  -> Codex CLIがEBS workflowを実行
  -> 成功した記事jobだけをEBS repositoryへmerge/push
  -> Discordへ開始・成功・失敗を通知
```

通常の記事生成では、Botは外部Git worktreeを作り、そこでCodexを実行する。成功したjobだけをprivate repositoryへ反映するため、失敗した記事やPublish Gate未通過の記事がそのまま公開領域へ入ることを避けやすい。

## 主なコマンド

- `/article query:"..." mode:new`
  - 1本の記事作成をキューに入れる。
  - `mode:update` を指定すると既存記事更新用の依頼として扱う。

- `/multi_article query:"英文法を網羅" count:15`
  - 1つの大きなテーマを複数の記事タイトル案に分解し、指定本数分の通常記事jobをまとめてキューに入れる。
  - `count` は `2` から `25`。
  - 例: `英文法を網羅` と `15` を指定すると、英文法を体系的に扱う15本の記事jobを作る。

- `/codex query:"..."`
  - 管理者専用。
  - `EBE_VAULT_ROOT` 直下でCodex CLIを直接実行する。
  - worktree作成、Publish Gate、commit、pushは自動では行わない。
  - 自由度が高いぶん危険度も高いため、`DISCORD_ADMIN_USER_IDS` のユーザーだけが使える。
  - Deprecated management escape hatch: do not use `/codex` as the canonical EBS management path.

- `/daily-news date:"2026-05-02"`
  - 管理者専用。
  - 指定日の10分野分の日次ニュースjobをキューに入れる。
  - `date` を省略するとJSTの当日を使う。

- `/daily_forecast date:"2026-05-02"`
  - 管理者専用。
  - 指定日の5種類分のForecasting jobをキューに入れる。
  - `date` を省略するとJSTの当日を使う。

- `/moc-maintenance scope:all`
  - 管理者専用。
  - encyclopedia metadataから`generated/moc/`を決定論的に再構成する。LLMは使用しない。
  - `scope` は `all`または`published`。`daily`はDaily identity移行までreview-only。

- `/image_maintenance scope:all`
  - 管理者専用。
  - 公開記事・日次記事の画像パスを点検・修復する。
  - `scope` は `all`、`published`、`daily`。
  - `/article`、`/daily-news`、`/image_maintenance` のjobはcommit/push前に画像パス検査を通し、未解決の画像参照が残る場合はpublishを止める。

- `/job-status job_id:"..."`
  - jobの状態、worktree、エラー、commitなどを確認する。

- `/job-list`
  - 最新50件までのjobを表示する。

- `/job-cancel job_id:"..."`
  - 管理者専用。
  - queuedまたはrunningのjobをキャンセルする。

- `/job-retry job_id:"..."`
  - 管理者専用。
  - failed、failed_review_required、cancelledのjobを再キュー投入する。

- `/worker-list`
  - 実行中workerを表示する。

- `/queue-pause` / `/queue-resume`
  - 管理者専用。
  - 新しいqueued jobの開始を停止・再開する。

- `/git-status`
  - Vault repositoryのgit statusを表示する。

- `/git-debug action:status`
  - 管理者専用。
  - git状態を詳しく確認する。

- `/git-debug action:all`
  - 管理者専用。
  - main vaultでadd/commit/pushを実行するデバッグ用コマンド。通常運用では多用しない。

- `/job-cleanup older_than_days:7 dry_run:true`
  - 管理者専用。
  - 古い終了済みjobのworktree、runtime log、JobStore履歴を一覧化または削除する。
  - 対象は`succeeded`、`failed`、`failed_review_required`、`cancelled`。`queued`と`running`は削除しない。

- `/auto-status`
  - 自律生成の状態、候補、queue、上限を表示する。

- `/auto-pause` / `/auto-resume`
  - 自律生成の定期実行を停止・再開する。

- `/auto-run`
  - 管理者専用。自律生成schedulerを1 tickだけdry-run実行する。

- `/bot-health`
  - キュー、worker、resource guard、CPU、memoryの状態を表示する。

## 権限と安全設計

- `.env` はGitに入れない。
- Discord token、GitHub token、Codex認証情報をrepositoryに入れない。
- `data/`、`logs/`、`node_modules/`、`dist/` はローカル専用。
- worker worktreeはVault repositoryの外に作る。
- `/codex`、`/daily-news`、`/daily_forecast`、`/moc-maintenance`、`/image_maintenance`、`/job-cancel`、`/job-retry`、`/queue-pause`、`/queue-resume`、`/git-debug`、`/job-cleanup` は管理者向け。
- 管理者は `.env` の `DISCORD_ADMIN_USER_IDS` にDiscord user IDをカンマ区切りで設定する。

## EBS Phase 3 CLI

`automation/discord_bot/`から実行する。

```powershell
npm run ebs -- reconcile --json
npm run ebs -- index rebuild --all --json
npm run ebs -- build --json
npm run ebs -- doctor --json
npm run ebs -- doctor --fix --json
npm run ebs -- rebuild --json

# Phase 4 autonomous controls
npm run ebs -- auto status --json
npm run ebs -- auto pause --json
npm run ebs -- auto resume --json
npm run ebs -- auto run-once --dry-run --json
npm run ebs -- auto candidates --json
npm run ebs -- auto candidates --status rejected --json
npm run ebs -- auto retry <candidate-id> --json
npm run ebs -- scheduler tick --dry-run --json
```

`rebuild`はreconciliation、全index/MOC再構築、atomic static build、global validationを順に実行する。公開画像はWebPへ正規化され、公開用`dist/`にPNG/JPEGを残さない。`generated/`と`dist/`は削除可能な派生成果物であり、`canonical/`と既存記事Markdownから再生成される。

## ディレクトリ構造

```text
Evidence-Based-Everything/
  automation/
    discord_bot/
      .env.example
      README.md
      package.json
      scripts/
      src/
      data/          # local only
      logs/          # local only
      node_modules/  # local only
```

worktree rootはVaultの外に置く。

常駐サーバーでは、Vault、worker worktree、runtime state、Pages repositoryを分ける。

```text
C:\EBS\
├─ Evidence-Based-Slopedia\        # EBE_VAULT_ROOT
├─ Evidence-Based-Slopedia-Pages\ # EBS_GITHUB_PAGES_DIR（任意）
├─ worktrees\                      # EBE_WORKTREE_ROOT
└─ discord_bot-runtime\            # EBE_BOT_RUNTIME_DIR
   ├─ data\                        # jobs.jsonなど
   ├─ autonomous\                  # 自律候補registry
   └─ logs\                        # job runtime log
```

runtime stateをVault内に置かないことが重要である。

```text
良い例:
  C:\ebe-worktrees
  D:\ebe-worktrees

悪い例:
  Evidence-Based-Everything\worktrees
```

## 必要なもの

1. Git
2. Node.js 20以上
3. Codex CLI
4. private vault repositoryへclone/pushできるGit認証
5. Discord applicationとbot token

確認コマンド:

```powershell
git --version
node -v
npm -v
codex --version
```

## Discord Application設定

Discord Developer PortalでBotを作る。

1. New Applicationを作成する。
2. Botページでtokenを作成し、`DISCORD_TOKEN` に入れる。
3. General InformationのApplication IDを `DISCORD_CLIENT_ID` に入れる。
4. Discord server IDを `DISCORD_GUILD_IDS` に入れる。複数サーバーはカンマ区切りで指定する。
5. 管理者にするDiscord user IDを `DISCORD_ADMIN_USER_IDS` に入れる。
6. Botを次のscopeでサーバーへ招待する。

```text
bot
applications.commands
```

## .env設定

`automation/discord_bot/.env.example` を `.env` にコピーする。

```powershell
cd .\automation\discord_bot
Copy-Item .env.example .env
notepad .env
```

最小設定例:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_IDS=
DISCORD_ADMIN_USER_IDS=

EBE_VAULT_ROOT=C:\path\to\Evidence-Based-Everything
EBE_WORKTREE_ROOT=C:\ebe-worktrees

EBE_MAX_WORKERS=4
EBE_MAX_PUBLISHERS=1

CODEX_DEFAULT_MODEL=gpt-5.5
CODEX_DEFAULT_REASONING_EFFORT=low
CODEX_COMMAND_TEMPLATE=codex exec --model {model} -c model_reasoning_effort={effort} --cd {cwd} --dangerously-bypass-approvals-and-sandbox -

GIT_REMOTE=origin
GIT_BRANCH=main
GIT_COMMIT_MESSAGE=article update
GIT_BOT_USER_NAME=ebe-discord-bot
GIT_BOT_USER_EMAIL=ebe-discord-bot@example.invalid

# Optional Pages repository checkout. deploy syncs dist and pushes only when changed.
EBS_GITHUB_PAGES_DIR=C:\\ebs\\your-pages-repository
EBS_PAGES_GIT_REMOTE=origin
EBS_PAGES_GIT_BRANCH=main
EBS_PAGES_GIT_COMMIT_MESSAGE=deploy: update site
EBS_PAGES_GIT_USER_NAME=ebs-pages-deployer
EBS_PAGES_GIT_USER_EMAIL=ebs-pages-deployer@example.invalid
EBS_SITE_BASE_PATH=/your-pages-repository/
EBS_SITE_ORIGIN=https://your-account.github.io
```

`EBE_VAULT_ROOT` はこのVaultの絶対パス。`EBE_WORKTREE_ROOT` はworker用の外部ディレクトリ。
`EBS_GITHUB_PAGES_DIR` はPages公開用repositoryをcloneした絶対パス。設定すると`deploy`が`dist/`を同期し、差分がある場合だけPages repositoryへcommit/pushする。

## インストールと起動

```powershell
cd .\automation\discord_bot
npm install
npm run typecheck
.\scripts\check-env.ps1
npm run register
npm run build
npm start
```

PowerShellの実行ポリシーで止まる場合:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\check-env.ps1
```

Slash Commandを追加・変更したときは、Bot起動前に必ず登録し直す。

```powershell
npm run register
```

## 起動後の確認

Discordで次を実行する。

```text
/bot-health
/git-status
```

小さな記事jobの例:

```text
/article query:"水分補給の基礎をEBE記事として作成する"
```

複数記事jobの例:

```text
/multi_article query:"英文法を網羅" count:15
```

Vaultルートで自由にCodexを実行する例:

```text
/codex query:"10_PublishedのMOCリンク切れを確認して、問題があれば修正して"
```

## Article Jobの流れ

```text
/article
  -> queued
  -> workerが外部Git worktreeを作成
  -> CodexがEBS workflowを実行
  -> durable artifactsがあればworker branchへcommit
  -> publisherがmainへrebase
  -> MOC conflictは修復処理
  -> mainへmerge
  -> private originへpush
```

`/multi_article` はこの通常article jobを複数作るだけで、各jobの実行・publish判定は通常と同じ。

## /codex の扱い

`/codex` は通常の記事生成とは違う。`EBE_VAULT_ROOT` を直接作業ディレクトリにしてCodex CLIを起動する。

用途:

- Botコードや設定の小修正
- Vault全体の調査
- MOCやログの点検
- 通常article flowに乗せにくい運用作業

注意:

- worktree分離がない。
- 自動commit/pushしない。
- 変更内容はmain worktreeへ直接出る。
- 実行ログは `_working/discord_codex/<job-id>/codex-output.log` に保存される。

## Codex Command Template

Codex CLIへのpromptはstdinで渡す。デフォルト:

```env
CODEX_COMMAND_TEMPLATE=codex exec --model {model} -c model_reasoning_effort={effort} --cd {cwd} --dangerously-bypass-approvals-and-sandbox -
```

使えるplaceholder:

- `{model}`
- `{effort}`
- `{cwd}`
- `{promptFile}`

手動テスト:

```powershell
"hello" | codex exec --model gpt-5.5 -c model_reasoning_effort=low --cd "<path-to-vault-or-worktree>" --dangerously-bypass-approvals-and-sandbox -
```

## 日次ニュース

手動実行:

```text
/daily-news
/daily-news date:"2026-05-02"
```

自動実行は `.env` で制御する。

```env
EBE_DAILY_NEWS_ENABLED=true
DISCORD_DAILY_NEWS_CHANNEL_ID=
EBE_DAILY_NEWS_HOUR_JST=6
EBE_DAILY_NEWS_MINUTE_JST=0
```

同じ日付の記事がすでに `11_Daily/` にある場合や、同日付の未失敗jobが残っている場合は重複投入を避ける。

## 日次Forecasting

手動実行:

```text
/daily_forecast
/daily_forecast date:"2026-05-02"
```

自動実行は `.env` で制御する。

```env
EBE_DAILY_FORECAST_ENABLED=true
DISCORD_DAILY_FORECAST_CHANNEL_ID=
EBE_DAILY_FORECAST_HOUR_JST=7
EBE_DAILY_FORECAST_MINUTE_JST=0
```

同じ日付の記事がすでに `12_Forecasting/` にある場合や、同日付の未失敗jobが残っている場合は重複投入を避ける。

## モバイルObsidianで読む

記事生成はBotを動かすPCに集約し、スマホやタブレットは読むだけにすると衝突が少ない。

おすすめ:

```text
Bot host:
  generate / commit / push

iPhone / Android:
  pull or sync / read
```

Obsidian Syncを使う場合は、同じVaultを同期するだけでよい。Git連携を使う場合、モバイル側はpull中心にする。

## Windowsで自動起動

Task Schedulerを使う。

```text
Program:
  powershell.exe

Arguments:
  -ExecutionPolicy Bypass -File "<path-to-repo>\automation\discord_bot\scripts\start-bot.ps1"

Start in:
  <path-to-repo>\automation\discord_bot
```

最初は「ログオン時」で試し、安定してから「スタートアップ時」にする。

## 運用メモ

- Botを複数プロセスで起動しない。
- main worktreeを手作業で大きく変更している間は、記事jobのpublish conflictが増えやすい。
- private repositoryへpushすると、既存のひな形public mirrorとは別に、公開記事用repositoryへ `10_Published/`、`11_Daily/`、関連MOC/index、参照assetsだけを同期できる。GitHub側で `PUBLIC_ARTICLES_TOKEN` と `PUBLIC_ARTICLES_REPOSITORY` を設定する。
- resource guardが有効な場合、CPUやmemory使用率が高いと新しいjob開始を遅らせる。
- 失敗worktreeは `EBE_KEEP_FAILED_WORKTREES=true` なら残る。
- 成功worktreeは通常削除される。
- Bot停止中にrunningだったjobは、次回起動時に `failed_review_required` になる。必要なら `/job-retry` を使う。

## トラブルシュート

Nodeプロセス確認:

```powershell
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Select-Object ProcessId, CommandLine
```

重複Bot停止:

```powershell
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*automation*discord_bot*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

ログ確認:

```powershell
Get-ChildItem .\logs
Get-Content .\logs\*.log
```

記事jobのCodexログ:

```powershell
notepad "<worktree-root>\<job-id>\_working\discord_jobs\<job-id>-codex-output.log"
```

`/codex` のCodexログ:

```powershell
notepad "<vault-root>\_working\discord_codex\<job-id>\codex-output.log"
```
