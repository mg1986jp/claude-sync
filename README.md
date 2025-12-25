# claude-sync

複数のMac間でClaude Code CLIの設定を共有するためのリポジトリです。

## このリポジトリで何ができるか

- **複数Mac間での設定共有**: 別のMacでも同じClaude Code環境をすぐに構築できます
- **権限設定の自動化**: 危険なコマンド（`rm -rf /`、`git push --force`等）を自動的にブロックします
- **ブラウザ操作機能**: MCP Puppeteerにより、Claudeがブラウザを操作できるようになります
- **AI指示の統一**: コミットメッセージ形式や開発方針をClaude Code全体で統一できます

## セットアップ

### 前提条件

以下のソフトウェアが必要です。未インストールの場合は先にインストールしてください。

#### 必須
- **Claude Code CLI** - このリポジトリの設定を適用するために必要です
  - インストール: [公式ガイド](https://code.claude.com/docs/ja/setup)
  - 確認方法: `claude --version`

#### オプション（ブラウザ操作機能を使う場合）
- **Node.js / npm** - MCP Puppeteerのインストールに必要です
  - インストール: [公式サイト](https://nodejs.org/)
  - 確認方法: `npm --version`

### 1. 既存設定のバックアップ

既に`~/.claude`ディレクトリが存在する場合、上書きされてしまうため先にバックアップします。

```bash
# ~/.claudeが存在する場合のみ実行してください
if [ -d ~/.claude ]; then
  mv ~/.claude ~/.claude_$(date +"%Y%m%d%H%M%S")
  echo "既存の~/.claudeをバックアップしました"
fi
```

### 2. リポジトリのクローン

このリポジトリを`~/.claude`にクローンします。

```bash
git clone git@github.com:mg1986jp/claude-sync.git ~/.claude
cd ~/.claude
```

**結果**: `~/.claude`に設定ファイル（settings.json、CLAUDE.md等）が配置されます。

### 3. セットアップスクリプトの実行

`init.sh`を実行して、追加機能をインストールします。

```bash
bash init.sh
```

**実行される内容**:
1. **claude-code-ui のインストール** - Claude Codeの操作UIツール（未インストールの場合のみ）
2. **MCP Puppeteerの設定** - ブラウザ操作機能の有効化（Claude Code CLIとnpmが両方インストールされている場合のみ）

**スキップされる場合**:
- Claude Code CLIが未インストール → MCP Puppeteer設定がスキップされます
  - **対処方法**: Claude Code CLIをインストール後、再度`bash init.sh`を実行してください
- npmが未インストール → claude-code-ui とMCP Puppeteer設定がスキップされます
  - **対処方法**: Node.js/npmをインストール後、再度`bash init.sh`を実行してください

### 4. 動作確認

Claude Codeを起動して設定が反映されているか確認します。

```bash
claude
```

**確認ポイント**:
- 画面右下に`[U]`と表示される → User設定（このリポジトリの設定）が読み込まれています
- 危険なコマンドがブロックされるか試す（例: `rm -rf /tmp/test`）→ 拒否されれば成功

**MCP Puppeteerの確認**:
```bash
claude
/mcp
```

**期待される表示**:
```text
 1 server

 ❯ 1. puppeteer  ✔ connected
```
`puppeteer ✔ connected`と表示されればブラウザ操作機能が使えます。

## このリポジトリに含まれるファイル

- **settings.json** - 権限設定とstatusLine設定（全プロジェクトで有効）
- **CLAUDE.md** - Claudeへの指示（開発方針、Git規約等）
- **init.sh** - claude-code-ui とMCP Puppeteerのセットアップスクリプト
- **scripts/status-line.sh** - statusLine表示用スクリプト
- **.gitignore** - 個人データ（セッション履歴等）を除外

## 設定の適用範囲

このリポジトリは`~/.claude/settings.json`（User設定）として機能します。これにより、**全てのプロジェクトで共通の設定が自動的に適用されます**。プロジェクト毎に`.claude/settings.json`を作成・管理する手間を省くことができます。

Claude Codeは複数の設定ファイルを優先順位に従って読み込みます。

```text
優先度（高） 1. .claude/settings.local.json  - プロジェクト固有、個人用
           2. .claude/settings.json        - プロジェクト固有、チーム共有
優先度（低） 3. ~/.claude/settings.json      - 全プロジェクト共通（このリポジトリの設定）
```

**このリポジトリの利点**: プロジェクト内に設定ファイルを作らなくても、全てのプロジェクトで同じ権限設定・AI指示が自動適用されます。特定のプロジェクトだけカスタマイズしたい場合のみ、プロジェクト設定を追加すればOKです。

**statusLineで確認可能**: 画面右下に表示される設定スコープで、どの設定が有効か確認できます。
- `[U]` - User設定のみ（このリポジトリの設定）
- `[P]` - Project設定あり
- `[L]` - Local設定あり
- `[PL]` - Project + Local 両方あり

## カスタマイズ

### 確認プロンプトを完全に無効化する

Claudeの作業を長時間監視できない場合、確認プロンプトを完全に無効化できます。

**方法**: `~/.claude/settings.json`の`permissions.allow`から`AskUserQuestion`を削除

```json
{
  "permissions": {
    "allow": [
      "Bash",
      "Read(//**)",
      // ... 他の設定 ...
      // "AskUserQuestion"  ← この行を削除またはコメントアウト
    ]
  }
}
```

**影響**: Claudeが確認なしで作業を進めます。予期しない変更が発生する可能性があるため、信頼できるタスクのみで使用してください。

### ブロックされるコマンドをカスタマイズする

現在ブロックされるコマンド:
- `rm -rf /`, `rm -rf ~` - ファイルシステムの破壊
- `dd if=/dev/zero` - ディスクの破壊
- `shutdown`, `reboot` - システム停止
- `git push --force` - Git強制push

**変更方法**: `~/.claude/settings.json`の`permissions.deny`を編集してください。

## トラブルシューティング

### MCP Puppeteerが動作しない

**確認方法**:
```bash
claude
/mcp
```

**対処方法**:
1. Claude Code CLIとnpmが両方インストールされているか確認
2. `bash init.sh`を再実行
3. 新しいClaude Codeセッションを起動（`claude -r`ではなく`claude`）

### 設定が反映されない

**確認方法**: 画面右下のstatusLineで`[U]`が表示されているか確認

**対処方法**:
- プロジェクト内に`.claude/settings.json`や`.claude/settings.local.json`がある場合、そちらが優先されます
- プロジェクト固有の設定を削除するか、このリポジトリの設定をプロジェクト設定にコピーしてください

## 別のMacでのセットアップ

同じ手順で`~/.claude`にクローンして`bash init.sh`を実行するだけで、同じ環境が構築されます。

```bash
# 既存設定のバックアップ
if [ -d ~/.claude ]; then
  mv ~/.claude ~/.claude_$(date +"%Y%m%d%H%M%S")
fi

# クローンとセットアップ
git clone git@github.com:mg1986jp/claude-sync.git ~/.claude
cd ~/.claude
bash init.sh
```
