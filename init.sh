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
