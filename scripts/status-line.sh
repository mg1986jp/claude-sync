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

# JSONパスから値を取得（jq優先、なければgrepフォールバック）
# 使い方: get_json ".model.display_name" "デフォルト値"
HAS_JQ=$(command -v jq >/dev/null 2>&1 && echo 1 || echo 0)

get_json() {
  local path=$1 default=${2:-"-"}
  if [ "$HAS_JQ" = "1" ]; then
    echo "$input" | jq -r "$path // \"$default\"" 2>/dev/null || echo "$default"
  else
    local key=${path##*.}
    local result
    result=$(echo "$input" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" 2>/dev/null | head -1 | sed 's/.*":\s*"\(.*\)"/\1/' || true)
    if [ -z "$result" ]; then
      result=$(echo "$input" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*[0-9.]*" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' || true)
    fi
    echo "${result:-$default}"
  fi
}

convert_to_thousands() {
  awk "BEGIN {printf \"%.0f\", ($1 / 1000)}"
}

# 分数を人間が読みやすい形式に変換（例: 688 → "11h28m", 86400 → "2mo0d"）
format_duration() {
  local total_min=$1
  local months=$((total_min / 43200))
  local remainder=$((total_min % 43200))
  local weeks=$((remainder / 10080))
  remainder=$((remainder % 10080))
  local hours=$((remainder / 60))
  local mins=$((remainder % 60))

  local result=""
  [ "$months" -gt 0 ] && result="${result}${months}mo"
  [ "$weeks" -gt 0 ] && result="${result}${weeks}w"
  [ "$hours" -gt 0 ] && result="${result}${hours}h"
  [ "$mins" -gt 0 ] && result="${result}${mins}m"
  echo "${result:-0m}"
}

shorten_path() {
  echo "$1" | sed "s|^$HOME|~|"
}

# 値を色付きで返す（値, 警告閾値, 危険閾値, フォーマット済み文字列）
apply_threshold_color() {
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
# データ取得（JSON構造順）
# ==================================================
input=$(cat)
echo "$(date '+%H:%M:%S') $(echo "$input" | jq -c '{ti: .context_window.total_input_tokens, to: .context_window.total_output_tokens, pct: .context_window.used_percentage}' 2>/dev/null)" >> /tmp/statusline-debug.log

# transcript_path
transcript_path=$(get_json ".transcript_path")

# model
model_id=$(get_json ".model.id")
model_name=$(get_json ".model.display_name")

# workspace
project_dir=$(get_json ".workspace.project_dir")

# version
version=$(get_json ".version")

# cost
total_cost_usd=$(get_json ".cost.total_cost_usd" "0")
total_duration_ms=$(get_json ".cost.total_duration_ms" "0")
total_api_duration_ms=$(get_json ".cost.total_api_duration_ms" "0")

# context_window
total_input=$(get_json ".context_window.total_input_tokens" "0")
total_output=$(get_json ".context_window.total_output_tokens" "0")
context_size=$(get_json ".context_window.context_window_size" "$DEFAULT_CONTEXT_SIZE")
used_percent=$(get_json ".context_window.used_percentage" "0")

# rate_limits
rate_limit_5h=$(get_json ".rate_limits.five_hour.used_percentage")
rate_limit_5h_resets=$(get_json ".rate_limits.five_hour.resets_at")
rate_limit_7d=$(get_json ".rate_limits.seven_day.used_percentage")
rate_limit_7d_resets=$(get_json ".rate_limits.seven_day.resets_at")

# ==================================================
# 整形（計算・変換・フォーマット）
# ==================================================

# コンテキスト
used_k=$(convert_to_thousands "$((context_size * used_percent / 100))")
context_k=$(convert_to_thousands "$context_size")
total_k=$(convert_to_thousands "$((total_input + total_output))")
total_context_display=$(apply_threshold_color "$total_k" "$TOTAL_CONTEXT_WARN_K" "$TOTAL_CONTEXT_DANGER_K" "${total_k}k")
current_context_display=$(apply_threshold_color "$used_percent" "$CURRENT_CONTEXT_WARN_PCT" "$CURRENT_CONTEXT_DANGER_PCT" "${used_k}k(${used_percent}%)")

# セッション作成日時・API待ち時間
total_duration_sec=$((total_duration_ms / 1000))
created_epoch=$(($(date +%s) - total_duration_sec))
created_time=$(LANG=C date -r "$created_epoch" '+%Y-%m-%d %a %H:%M:%S')
api_duration_display=$(format_duration "$((total_api_duration_ms / 60000))")

# レート制限リセット日時
rate_limit_5h_resets_display=$(LANG=C date -r "$rate_limit_5h_resets" '+%Y-%m-%d %a %H:%M' 2>/dev/null || echo "$rate_limit_5h_resets")
rate_limit_7d_resets_display=$(LANG=C date -r "$rate_limit_7d_resets" '+%Y-%m-%d %a %H:%M' 2>/dev/null || echo "$rate_limit_7d_resets")

# パス短縮
short_dir=$(shorten_path "$project_dir")
short_transcript=$(shorten_path "$transcript_path")

# git ブランチ（現在のブランチ + 前回ブランチと比較）
git_branch="-"
if git rev-parse --git-dir > /dev/null 2>&1; then
  git_branch=$(git -c core.fileMode=false -c core.fsmonitor=false branch --show-current 2>/dev/null || echo "-")
  git_branch=${git_branch:-"-"}
fi

session_meta="${transcript_path%.jsonl}.meta.json"
if [ -f "$session_meta" ]; then
  saved_branch=$(jq -r '.branch // "-"' "$session_meta" 2>/dev/null || echo "-")
  if [ "$git_branch" != "$saved_branch" ]; then
    git_branch="${git_branch} (last: ${saved_branch})"
  fi
fi
echo "{\"branch\":\"${git_branch%%' '*}\"}" > "$session_meta"

# settings マージ状況
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
printf "cli-version: %s\n" "$version"
printf "model: %s / %s\n" "$model_name" "$model_id"
printf "workspace: %s\n" "$short_dir"
printf "branch: %s\n" "$git_branch"
printf "settings: %s\n" "$settings_line"
printf "created-at: %s (%s)\n" "$created_time" "$api_duration_display"
printf "context-total: %b\n" "$total_context_display"
printf "context-current: %b / %sk\n" "$current_context_display" "$context_k"
printf "rate-limit-week: %.0f%% / %s\n" "$rate_limit_7d" "$rate_limit_7d_resets_display"
printf "rate-limit-current: %.0f%% / %s\n" "$rate_limit_5h" "$rate_limit_5h_resets_display"
printf "transcript: %s\n" "$short_transcript"
printf "cost: \$%.2f\n" "$total_cost_usd"
