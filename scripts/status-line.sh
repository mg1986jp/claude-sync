#!/bin/bash
set -euo pipefail

# JSON値を抽出する関数
get_json_value() {
  echo "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*":\s*"\(.*\)"/\1/'
}

get_json_number() {
  echo "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*[0-9]*" | head -1 | sed 's/.*:[[:space:]]*//'
}

# 標準入力からJSON読み込み
input=$(cat)

# JSON値を抽出
current_dir=$(get_json_value "$input" "current_dir")
model_name=$(get_json_value "$input" "display_name")
context_size=$(get_json_number "$input" "context_window_size")
used_percent=$(get_json_number "$input" "used_percentage")

# デフォルト値を設定（JSON解析失敗時の対策）
context_size=${context_size:-200000}
used_percent=${used_percent:-0}

# 現在の使用トークン数を計算（used_percentage から逆算）
used_tokens=$(awk "BEGIN {printf \"%.0f\", ($context_size * $used_percent / 100)}")
used_k=$(awk "BEGIN {printf \"%.0f\", ($used_tokens / 1000)}")
context_k=$(awk "BEGIN {printf \"%.0f\", ($context_size / 1000)}")

# Gitブランチ情報を取得
git_branch=""
if git rev-parse --git-dir > /dev/null 2>&1; then
  git_branch=$(git -c core.fileMode=false -c core.fsmonitor=false branch --show-current 2>/dev/null || echo "")
  if [ -n "$git_branch" ]; then
    git_branch=" ($git_branch)"
  fi
fi

# 設定スコープを判定
config_scope=""
if [ -f .claude/settings.json ]; then
  config_scope="${config_scope}P"
fi
if [ -f .claude/settings.local.json ]; then
  config_scope="${config_scope}L"
fi
if [ -z "$config_scope" ]; then
  config_scope="U"
fi

# ステータスラインを出力
printf "%s | %s%s | [%s] | context: %sk(%s%%) / %sk" "$model_name" "$current_dir" "$git_branch" "$config_scope" "$used_k" "$used_percent" "$context_k"
