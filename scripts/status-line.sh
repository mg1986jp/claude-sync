#!/bin/bash
set -euo pipefail

# ==================================================
# 定数
# ==================================================
readonly ANSI_RED="\033[31m"
readonly ANSI_YELLOW="\033[33m"
readonly ANSI_GREEN="\033[32m"
readonly ANSI_RESET="\033[0m"

readonly TOTAL_CONTEXT_WARN_K=3000
readonly TOTAL_CONTEXT_DANGER_K=5000
readonly CURRENT_CONTEXT_WARN_PCT=75
readonly CURRENT_CONTEXT_DANGER_PCT=90

readonly DEFAULT_CONTEXT_SIZE=200000
readonly USER_SETTINGS="~/.claude/settings.json"
readonly PROJECT_SETTINGS=".claude/settings.json"
readonly LOCAL_SETTINGS=".claude/settings.local.json"

# ==================================================
# 関数
# ==================================================

get_json_value() {
  echo "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*":\s*"\(.*\)"/\1/'
}

get_json_number() {
  echo "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*[0-9]*" | head -1 | sed 's/.*:[[:space:]]*//'
}

shorten_path() {
  echo "$1" | sed "s|^$HOME|~|"
}

to_k() {
  awk "BEGIN {printf \"%.0f\", ($1 / 1000)}"
}

# 値を色付きで返す（値, 警告閾値, 危険閾値, フォーマット済み文字列）
colorize() {
  local value=$1 warn=$2 danger=$3 text=$4
  local color="$ANSI_GREEN"
  if [ "$value" -ge "$danger" ]; then
    color="$ANSI_RED"
  elif [ "$value" -ge "$warn" ]; then
    color="$ANSI_YELLOW"
  fi
  echo "${color}${text}${ANSI_RESET}"
}

# ==================================================
# データ取得
# ==================================================
input=$(cat)

current_dir=$(get_json_value "$input" "current_dir")
model_name=$(get_json_value "$input" "display_name")
context_size=$(get_json_number "$input" "context_window_size")
used_percent=$(get_json_number "$input" "used_percentage")
total_input=$(get_json_number "$input" "total_input_tokens")
total_output=$(get_json_number "$input" "total_output_tokens")

context_size=${context_size:-$DEFAULT_CONTEXT_SIZE}
used_percent=${used_percent:-0}
total_input=${total_input:-0}
total_output=${total_output:-0}

# ==================================================
# 計算
# ==================================================
used_k=$(to_k "$((context_size * used_percent / 100))")
context_k=$(to_k "$context_size")
total_k=$(to_k "$((total_input + total_output))")

git_branch="-"
if git rev-parse --git-dir > /dev/null 2>&1; then
  git_branch=$(git -c core.fileMode=false -c core.fsmonitor=false branch --show-current 2>/dev/null || echo "-")
  git_branch=${git_branch:-"-"}
fi

short_dir=$(shorten_path "$current_dir")
settings_line="$USER_SETTINGS"
if [ -f "$PROJECT_SETTINGS" ]; then
  settings_line="${settings_line} < ${short_dir}/${PROJECT_SETTINGS}"
fi
if [ -f "$LOCAL_SETTINGS" ]; then
  settings_line="${settings_line} < ${short_dir}/${LOCAL_SETTINGS}"
fi

# ==================================================
# 出力
# ==================================================
total_context_display=$(colorize "$total_k" "$TOTAL_CONTEXT_WARN_K" "$TOTAL_CONTEXT_DANGER_K" "${total_k}k")
current_context_display=$(colorize "$used_percent" "$CURRENT_CONTEXT_WARN_PCT" "$CURRENT_CONTEXT_DANGER_PCT" "${used_k}k(${used_percent}%)")

printf "model: %s\n" "$model_name"
printf "workspace: %s\n" "$short_dir"
printf "branch: %s\n" "$git_branch"
printf "settings: %s\n" "$settings_line"
printf "total-context: %b\n" "$total_context_display"
printf "current-context: %b / %sk" "$current_context_display" "$context_k"
