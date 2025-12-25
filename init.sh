#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo "=== claude-sync initialization ==="

# npm が利用可能かチェック
if ! command -v npm &> /dev/null; then
  echo "Warning: npm not found. Skipping package installations."
  echo "Please install Node.js and npm, then run this script again."
  NPM_AVAILABLE=false
else
  NPM_AVAILABLE=true
fi

# claude-code-ui をグローバルインストール（未インストールの場合のみ）
if [ "$NPM_AVAILABLE" = true ]; then
  if command -v claude-code-ui &> /dev/null; then
    echo "✓ claude-code-ui is already installed ($(claude-code-ui --version 2>/dev/null || echo 'version unknown'))"
  else
    echo "Installing @siteboon/claude-code-ui globally..."
    if npm install -g @siteboon/claude-code-ui; then
      echo "✓ claude-code-ui installed successfully"
    else
      echo "✗ Failed to install claude-code-ui"
    fi
  fi

  # claude-code-ui の auth.db 初期化チェック
  # npmパッケージにデフォルトのauth.db（adminユーザー）が含まれているため、
  # 初回起動時に登録画面ではなくログイン画面が表示される問題への対処
  NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null)"
  CLAUDE_CODE_UI_DIR="$NPM_GLOBAL_ROOT/@siteboon/claude-code-ui"

  if [ -d "$CLAUDE_CODE_UI_DIR" ]; then
    # auth.db を動的に検索（パッケージ内の配置場所が変わっても対応）
    AUTH_DB_PATH=$(find "$CLAUDE_CODE_UI_DIR" -name "auth.db" -type f 2>/dev/null | head -n 1)

    if [ -n "$AUTH_DB_PATH" ]; then
      if command -v sqlite3 &> /dev/null; then
        # auth.db内のユーザー名を取得
        USERNAME=$(sqlite3 "$AUTH_DB_PATH" "SELECT username FROM users LIMIT 1;" 2>/dev/null || echo "")

        if [ "$USERNAME" = "admin" ]; then
          # パッケージのデフォルトユーザー → 削除して登録画面を表示させる
          echo "Removing default auth.db (package includes pre-registered 'admin' user)..."
          rm -f "$AUTH_DB_PATH"
          echo "✓ Default auth.db removed. You will see registration screen on first launch."
        elif [ -n "$USERNAME" ]; then
          # admin以外のユーザー → ユーザーが既に登録済み
          echo "✓ User '$USERNAME' already registered. Keeping auth.db."
        fi
        # USERNAMEが空の場合（ユーザーなし）は何もしない
      else
        echo "Warning: sqlite3 not found. Cannot verify auth.db contents."
        echo "If you see a login screen instead of registration, manually delete:"
        echo "  $AUTH_DB_PATH"
      fi
    fi
  fi
fi

# MCP Puppeteer を設定（Claude Code CLI がインストール済みの場合のみ）
if ! command -v claude &> /dev/null; then
  echo "Warning: claude command not found."
  echo "Please install Claude Code CLI first: https://code.claude.com/docs/en/install"
  echo "Then manually configure MCP Puppeteer:"
  echo "  claude mcp add --transport stdio --scope user puppeteer -- npx -y @modelcontextprotocol/server-puppeteer"
elif [ "$NPM_AVAILABLE" = false ]; then
  echo "Warning: npm not found. Cannot configure MCP Puppeteer (requires npx)."
else
  echo "Configuring MCP Puppeteer..."
  if claude mcp list 2>/dev/null | grep -q "puppeteer"; then
    echo "✓ MCP Puppeteer is already configured"
  else
    if claude mcp add --transport stdio --scope user puppeteer -- npx -y @modelcontextprotocol/server-puppeteer 2>&1; then
      echo "✓ MCP Puppeteer configured successfully"
    else
      echo "✗ MCP Puppeteer configuration failed"
      echo "Please configure manually: claude mcp add --transport stdio --scope user puppeteer -- npx -y @modelcontextprotocol/server-puppeteer"
    fi
  fi
  echo "Verify with: claude, then /mcp"
fi

echo ""
echo "=== Initialization complete ==="
echo ""
echo "Next steps:"
echo "  1. Restart your terminal or run: source ~/.zshrc (or ~/.bashrc)"
echo "  2. Start Claude Code: claude"
echo "  3. Verify MCP: /mcp (should show 'puppeteer connected')"
