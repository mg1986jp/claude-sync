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
total_input=$(get_json_number "$input" "total_input_tokens")
total_output=$(get_json_number "$input" "total_output_tokens")
context_size=$(get_json_number "$input" "context_window_size")

# コンテキスト使用率を計算
total_tokens=$((total_input + total_output))
if [ "$context_size" -gt 0 ]; then
  usage_percent=$(awk "BEGIN {printf \"%.1f\", ($total_tokens / $context_size) * 100}")
else
  usage_percent="0.0"
fi

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
if [ -f .claude/settings.local.json ]; then
  config_scope="${config_scope}L"
fi
if [ -f .claude/settings.json ]; then
  config_scope="${config_scope}P"
fi
if [ -z "$config_scope" ]; then
  config_scope="U"
fi

# ステータスラインを出力
printf "%s | %s%s | [%s] | context: %s%%" "$model_name" "$current_dir" "$git_branch" "$config_scope" "$usage_percent"
