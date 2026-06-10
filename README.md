# claude-sync

複数Mac間でClaude Code CLIの設定を共有するためのリポジトリ。<br>
`~/.claude` にクローンすることで、全プロジェクトに共通設定が自動適用される。

## 主な機能

| 機能 | 説明 |
|------|------|
| 設定の共有 | 別のMacでも同じClaude Code環境をすぐに構築できる |
| 権限制御 | 危険なコマンド（`rm -rf /`、`git push --force` 等）を自動ブロック |
| ブラウザ操作 | MCP Puppeteerにより、Claudeがブラウザを操作可能 |
| AI指示の統一 | コミットメッセージ形式や開発方針をCLAUDE.mdで一元管理 |

## セットアップ

### 前提条件

| 種別 | ツール | 確認コマンド | インストール |
|------|--------|-------------|-------------|
| 必須 | Claude Code CLI | `claude --version` | https://code.claude.com/docs/ja/setup |
| オプション | Node.js / npm | `npm --version` | https://nodejs.org/ |

※ Node.js / npm はブラウザ操作機能（MCP Puppeteer）を使う場合に必要。

### 手順

```bash
# 1. 既存設定のバックアップ（~/.claude が存在する場合のみ）
if [ -d ~/.claude ]; then
  mv ~/.claude ~/.claude_$(date +"%Y%m%d%H%M%S")
fi

# 2. クローン
git clone git@github.com:mg1986jp/claude-sync.git ~/.claude
cd ~/.claude

# 3. セットアップスクリプト実行
bash init.sh
```

`init.sh` の実行内容:
- **claude-code-ui のインストール** — Claude Codeの操作UIツール（npm必須）
- **MCP Puppeteer の設定** — ブラウザ操作機能の有効化（Claude Code CLI + npm 必須）

前提条件を満たさない機能はスキップされる。<br>
該当ツールをインストール後に `bash init.sh` を再実行すれば有効化される。

### 動作確認

Claude Code を起動して以下を確認する。

```bash
claude
```

| 確認項目 | 期待結果 |
|---------|---------|
| 設定の読み込み | statusLine の `settings:` 行に `~/.claude/settings.json` が表示される（→「[設定の適用範囲](#設定の適用範囲)」参照） |
| 権限制御 | `rm -rf /tmp/test` のような危険なコマンドがブロックされる |
| MCP Puppeteer（オプション） | `/mcp` を実行して `puppeteer ✔ connected` と表示される |

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `settings.json` | 権限設定、statusLine設定、環境変数（全プロジェクトで有効） |
| `CLAUDE.md` | Claudeへの指示（開発方針、Git規約、コミュニケーションスタイル等） |
| `init.sh` | claude-code-ui と MCP Puppeteer のセットアップスクリプト |
| `scripts/status-line.sh` | statusLine 表示用スクリプト |
| `.gitignore` | 個人データ（セッション履歴等）を除外 |

## 設定の適用範囲

`~/.claude` にクローンした本リポジトリが Global 設定（`~/.claude/settings.json`）として機能する。<br>
全プロジェクトに自動適用されるため、プロジェクト毎に設定ファイルを作る必要がない。

Claude Code は以下の優先順位で設定を読み込み、後勝ちでディープマージする:

```text
優先度（低） ~/.claude/settings.json           — Global設定（このリポジトリ）
           .claude/settings.json             — Project設定（チーム共有）
優先度（高） .claude/settings.local.json       — Local設定（個人用、gitignore推奨）
```

statusLine の `settings:` 行で、現在適用されている設定ファイルを確認できる:

| 構成 | statusLine 表示 |
|---|---|
| Global設定のみ | `settings: ~/.claude/settings.json` |
| Global + Project設定 | `settings: ~/.claude/settings.json < {workspace}/.claude/settings.json` |
| Global + Local設定 | `settings: ~/.claude/settings.json < {workspace}/.claude/settings.local.json` |
| Global + Project + Local設定 | `settings: ~/.claude/settings.json < {workspace}/.claude/settings.json < {workspace}/.claude/settings.local.json` |

特定のプロジェクトだけ設定を変えたい場合のみ、Project設定やLocal設定を追加すればよい。

## カスタマイズ

### 確認プロンプトの無効化

`~/.claude/settings.json` の `permissions.allow` から `AskUserQuestion` を削除すると、Claudeが確認なしで作業を進める。<br>
予期しない変更が発生する可能性があるため、信頼できるタスクのみで使用すること。

### ブロックコマンドの変更

ブロック対象は `~/.claude/settings.json` の `permissions.deny` に定義されている。<br>
追加・削除する場合は `permissions.deny` を直接編集する。

## トラブルシューティング

### `/mcp` で `puppeteer` が表示されない

1. Claude Code CLI と npm が両方インストールされているか確認
2. `bash init.sh` を再実行
3. 新しいセッションを起動（`claude -r` ではなく `claude`）

### Global設定（本リポジトリの設定）が反映されない

statusLine の `settings:` 行で、`~/.claude/settings.json` が表示されているか確認する。<br>
プロジェクト内に `.claude/settings.json` や `.claude/settings.local.json` がある場合、そちらが優先されて Global 設定が上書きされる。<br>
プロジェクト固有の設定を削除するか、Global 設定の内容をプロジェクト設定にコピーして対応する。

