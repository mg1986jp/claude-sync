#!/bin/bash
set -euo pipefail

# ==================================================
# 定数
# ==================================================
readonly ANSI_RED="\033[31m"
readonly ANSI_YELLOW="\033[33m"
readonly ANSI_RESET="\033[0m"

readonly TOTAL_CONTEXT_WARN_K=3000
readonly TOTAL_CONTEXT_DANGER_K=5000
readonly CURRENT_CONTEXT_WARN_PCT=75
readonly CURRENT_CONTEXT_DANGER_PCT=90
readonly RATE_LIMIT_WARN_PCT=75
readonly RATE_LIMIT_DANGER_PCT=90
readonly CREATED_WARN_DAYS=15
readonly CREATED_DANGER_DAYS=30
readonly COST_WARN_USD=150
readonly COST_DANGER_USD=200

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
    # 親キーが存在する場合（2階層以上）、親オブジェクトの範囲に絞り込んでからキーを検索
    local parent=$(echo "$path" | sed 's/\.[^.]*$//' | sed 's/.*\.//')
    local search_text="$input"
    if [ "$parent" != "$key" ]; then
      search_text=$(echo "$input" | tr -d '\n' | grep -o "\"$parent\"[[:space:]]*:[[:space:]]*{[^}]*}" 2>/dev/null || echo "$input")
    fi
    local result
    result=$(echo "$search_text" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" 2>/dev/null | head -1 | sed 's/.*":\s*"\(.*\)"/\1/' || true)
    if [ -z "$result" ]; then
      result=$(echo "$search_text" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*[0-9.]*" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' || true)
    fi
    echo "${result:-$default}"
  fi
}

# 数値を千単位に変換して返す（例: 150000 → "150"）
convert_to_thousands() {
  echo $(($1 / 1000))
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

# 絶対パスの$HOME部分を~に置換する（例: "/Users/usr/project" → "~/project"）
shorten_path() {
  echo "${1/#$HOME/~}"
}

# UNIXエポックを日時文字列に変換（macOS: date -r, Linux: date -d で両対応）
format_epoch() {
  local epoch=$1 format=$2
  LANG=C date -r "$epoch" "$format" 2>/dev/null || LANG=C date -d "@$epoch" "$format" 2>/dev/null || echo "$epoch"
}

# 値が閾値を超えた場合のみ色付きで返す（超えなければ色なし）
apply_threshold_color() {
  local value=$1 warn=$2 danger=$3 text=$4
  if [ "$value" -ge "$danger" ]; then
    echo "${ANSI_RED}${text}${ANSI_RESET}"
  elif [ "$value" -ge "$warn" ]; then
    echo "${ANSI_YELLOW}${text}${ANSI_RESET}"
  else
    echo "$text"
  fi
}

# ==================================================
# データ取得（JSON構造順）
# ==================================================
input=$(cat)

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

# パス短縮（workspace, settings, transcript で使用）
short_dir=$(shorten_path "$project_dir")
short_transcript=$(shorten_path "$transcript_path")

# git ブランチ
git_branch="-"
if git rev-parse --git-dir > /dev/null 2>&1; then
  git_branch=$(git -c core.fileMode=false -c core.fsmonitor=false branch --show-current 2>/dev/null || echo "-")
  git_branch=${git_branch:-"-"}
fi

# settings マージ状況
settings_line="$USER_SETTINGS"
global_real=$(cd "$HOME" && realpath ".claude/settings.json" 2>/dev/null || echo "")
if [ -f "$PROJECT_SETTINGS" ]; then
  project_real=$(realpath "$PROJECT_SETTINGS" 2>/dev/null || echo "")
  if [ "$project_real" != "$global_real" ]; then
    settings_line="${settings_line} < ${short_dir}/${PROJECT_SETTINGS}"
  fi
fi
if [ -f "$LOCAL_SETTINGS" ]; then
  local_real=$(realpath "$LOCAL_SETTINGS" 2>/dev/null || echo "")
  if [ "$local_real" != "$global_real" ]; then
    settings_line="${settings_line} < ${short_dir}/${LOCAL_SETTINGS}"
  fi
fi

# セッション作成日時・API待ち時間
total_duration_sec=$((total_duration_ms / 1000))
created_epoch=$(($(date +%s) - total_duration_sec))
created_time=$(format_epoch "$created_epoch" '+%Y-%m-%d %a %H:%M:%S')
api_duration_display=$(format_duration "$((total_api_duration_ms / 60000))")
created_age_days=$((total_duration_sec / 86400))
created_time_display=$(apply_threshold_color "$created_age_days" "$CREATED_WARN_DAYS" "$CREATED_DANGER_DAYS" "$created_time")

# コンテキスト
used_k=$(convert_to_thousands "$((context_size * used_percent / 100))")
context_k=$(convert_to_thousands "$context_size")
total_k=$(convert_to_thousands "$((total_input + total_output))")
total_context_display=$(apply_threshold_color "$total_k" "$TOTAL_CONTEXT_WARN_K" "$TOTAL_CONTEXT_DANGER_K" "${total_k}k")
current_context_display=$(apply_threshold_color "$used_percent" "$CURRENT_CONTEXT_WARN_PCT" "$CURRENT_CONTEXT_DANGER_PCT" "${used_k}k(${used_percent}%)")

# レート制限
rate_limit_5h_resets_display=$(format_epoch "$rate_limit_5h_resets" '+%Y-%m-%d %a %H:%M')
rate_limit_7d_resets_display=$(format_epoch "$rate_limit_7d_resets" '+%Y-%m-%d %a %H:%M')
rate_limit_5h_int=$(printf "%.0f" "$rate_limit_5h")
rate_limit_7d_int=$(printf "%.0f" "$rate_limit_7d")
rate_limit_5h_display=$(apply_threshold_color "$rate_limit_5h_int" "$RATE_LIMIT_WARN_PCT" "$RATE_LIMIT_DANGER_PCT" "${rate_limit_5h_int}%")
rate_limit_7d_display=$(apply_threshold_color "$rate_limit_7d_int" "$RATE_LIMIT_WARN_PCT" "$RATE_LIMIT_DANGER_PCT" "${rate_limit_7d_int}%")

# コスト
cost_int=$(printf "%.0f" "$total_cost_usd")
cost_display=$(apply_threshold_color "$cost_int" "$COST_WARN_USD" "$COST_DANGER_USD" "\$$(printf '%.2f' "$total_cost_usd")")

# ==================================================
# 出力
# ==================================================
printf "cli-version: %s\n" "$version"
printf "model: %s | %s\n" "$model_name" "$model_id"
printf "workspace: %s\n" "$short_dir"
printf "branch: %s\n" "$git_branch"
printf "settings: %s\n" "$settings_line"
printf "created-at: %b (%s)\n" "$created_time_display" "$api_duration_display"
printf "context-total: %b\n" "$total_context_display"
printf "context-current: %b / %sk\n" "$current_context_display" "$context_k"
printf "rate-limit-week: %b / %s\n" "$rate_limit_7d_display" "$rate_limit_7d_resets_display"
printf "rate-limit-current: %b / %s\n" "$rate_limit_5h_display" "$rate_limit_5h_resets_display"
printf "transcript: %s\n" "$short_transcript"
printf "cost: %b\n" "$cost_display"
