#!/usr/bin/env python3
"""
Claude Code 読み上げフック (Stop hook)

Claude Code の応答を macOS の say コマンドで読み上げる。
hooks.Stop に async: true で登録し、バックグラウンドで動作する。

応答に <speak>〜</speak> タグがあればその中身だけを読む。
なければ全文から Markdown を除去して読む。

排他制御:
  同じタブ（同一セッション）→ 前の読み上げを止めて新しい方に差し替え
  別のタブ（別セッション）→ 順番待ち
  手動の say は一切触らない

構成（将来の Windows 移植を考慮して分離）:
  TextProcessor  - Markdown 除去・コードブロック置換（OS 非依存）
  MacTTS         - say コマンド呼び出し（macOS 固有）
  SpeechQueue    - mkdir ベースの排他制御（OS 非依存）
"""

import hashlib
import json
import os
import platform
import re
import signal
import subprocess
import sys
import time
import uuid

# --- 設定 ---
VOICE = os.environ.get("CLAUDE_SAY_VOICE", "Kyoko")
RATE = int(os.environ.get("CLAUDE_SAY_RATE", "260"))
WORK_DIR = os.path.join(os.path.expanduser("~/.claude"), "tmp", "claude-say")
LOCK_DIR = os.path.join(WORK_DIR, "lock")
STATE_FILE = os.path.join(WORK_DIR, "state")
STALE_CHECK_INTERVAL = 2


# ============================================================
# テキスト処理（OS 非依存）
# ============================================================
class TextProcessor:
    """Markdown 記法を除去し、読み上げに適したプレーンテキストに変換する"""

    def process(self, text: str) -> str:
        text = self._remove_timestamp(text)
        text = self._replace_code_blocks(text)
        text = self._remove_insight_decoration(text)
        text = self._replace_urls(text)
        text = self._shorten_long_paths(text)
        text = self._remove_table_separators(text)
        text = self._clean_table_rows(text)
        text = self._remove_headings(text)
        text = self._remove_emphasis(text)
        text = self._remove_inline_code(text)
        text = self._remove_list_markers(text)
        text = self._remove_blockquotes(text)
        text = self._compress_blank_lines(text)
        return text.strip()

    def _remove_timestamp(self, text: str) -> str:
        return re.sub(r"^回答日時：.*$", "", text, flags=re.MULTILINE)

    def _replace_code_blocks(self, text: str) -> str:
        """CommonMark 準拠の行単位フェンス処理。``` と ~~~ の両方に対応。"""
        result = []
        fence = None
        for line in text.splitlines(keepends=True):
            if fence is not None:
                char, length = fence
                stripped = line.rstrip("\r\n")
                if re.fullmatch(
                    r" {0,3}" + re.escape(char)
                    + r"{" + str(length) + r",}[ \t]*",
                    stripped,
                ):
                    fence = None
                continue
            match = re.match(r"^ {0,3}(`{3,}|~{3,})([^\r\n]*)", line)
            if match and not (match[1][0] == "`" and "`" in match[2]):
                fence = (match[1][0], len(match[1]))
                result.append("コードは省略します。\n")
            else:
                result.append(line)
        return "".join(result)

    def _remove_insight_decoration(self, text: str) -> str:
        text = re.sub(r"^.*[★].*Insight.*$", "", text, flags=re.MULTILINE)
        text = re.sub(r"─{3,}", "", text)
        return text

    def _replace_urls(self, text: str) -> str:
        return re.sub(r"https?://[^\s)>\]]+", "URLは省略します", text)

    def _shorten_long_paths(self, text: str) -> str:
        def _shorten(m):
            basename = os.path.basename(m.group(0).rstrip("/"))
            return f"ファイル {basename}" if basename else ""
        return re.sub(
            r"(?<![.\w])[~/](?:[^\s/]+/){2,}[^\s/]*", _shorten, text
        )

    def _remove_table_separators(self, text: str) -> str:
        return re.sub(r"^\|[\s\-:|]+\|$", "", text, flags=re.MULTILINE)

    def _clean_table_rows(self, text: str) -> str:
        return re.sub(
            r"^\|(.+)\|$",
            lambda m: m.group(1).replace("|", "、"),
            text,
            flags=re.MULTILINE,
        )

    def _remove_headings(self, text: str) -> str:
        return re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)

    def _remove_emphasis(self, text: str) -> str:
        return re.sub(r"\*{1,2}([^*]+)\*{1,2}", r"\1", text)

    def _remove_inline_code(self, text: str) -> str:
        return re.sub(r"`([^`]+)`", r"\1", text)

    def _remove_list_markers(self, text: str) -> str:
        text = re.sub(r"^[\s]*[-*]\s+", "", text, flags=re.MULTILINE)
        text = re.sub(r"^[\s]*\d+\.\s+", "", text, flags=re.MULTILINE)
        return text

    def _remove_blockquotes(self, text: str) -> str:
        return re.sub(r"^>\s*", "", text, flags=re.MULTILINE)

    def _compress_blank_lines(self, text: str) -> str:
        return re.sub(r"\n{3,}", "\n\n", text)


# ============================================================
# TTS バックエンド（OS ごとに実装を分離）
# ============================================================
class MacTTS:
    """macOS の say コマンドで読み上げる"""

    def __init__(self, voice: str = "Kyoko"):
        self.voice = voice
        self._proc = None

    def speak(self, text: str) -> None:
        self._proc = subprocess.Popen(
            ["say", "-v", self.voice, "-r", str(RATE)],
            stdin=subprocess.PIPE,
        )
        self._proc.communicate(input=text.encode("utf-8"))

    def stop(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()


def get_tts_backend():
    """実行中の OS に応じた TTS バックエンドを返す"""
    system = platform.system()
    if system == "Darwin":
        return MacTTS(voice=VOICE)
    sys.exit(0)


# ============================================================
# 排他制御（mkdir ロック + セッション番号による差し替え）
# ============================================================
class SpeechQueue:
    """mkdir ロックによる排他制御

    同じセッション（同じタブ）:
      前の読み上げプロセスに SIGTERM を送って差し替える。
      待っている間に同じタブから新しい返事が来たら、読まずに終了する。

    別セッション（別タブ）:
      ロックが解放されるまで順番待ちする。
    """

    MAX_RETRIES = 10

    def __init__(self, session_id: str):
        self._session_id = session_id
        self._locked = False
        self._request_id = uuid.uuid4().hex
        session_hash = hashlib.sha256(session_id.encode()).hexdigest()[:16]
        self._latest_path = os.path.join(WORK_DIR, f"latest-{session_hash}")

    def acquire(self) -> bool:
        """ロックを取得する。同じタブの新しい返事に追い越されたら False を返す。"""
        os.makedirs(WORK_DIR, exist_ok=True)
        self._register_request()
        retries = 0
        while self._is_latest_request():
            try:
                os.mkdir(LOCK_DIR)
            except FileExistsError:
                pid, session = self._read_state()
                if self._is_stale(pid):
                    retries += 1
                    if retries > self.MAX_RETRIES:
                        return False
                    self._cleanup_lock()
                    time.sleep(0.1)
                elif session == self._session_id:
                    self._stop_previous(pid)
                else:
                    time.sleep(STALE_CHECK_INTERVAL)
                continue
            self._locked = True
            self._write_state()
            return True
        return False

    def release(self) -> None:
        if not self._locked:
            return
        self._cleanup_lock()
        self._locked = False

    def _register_request(self) -> None:
        tmp = f"{self._latest_path}.{os.getpid()}"
        with open(tmp, "w") as f:
            f.write(self._request_id)
        os.replace(tmp, self._latest_path)

    def _is_latest_request(self) -> bool:
        try:
            with open(self._latest_path, "r") as f:
                return f.read().strip() == self._request_id
        except OSError:
            return True

    def _write_state(self) -> None:
        tmp = f"{STATE_FILE}.tmp.{os.getpid()}"
        with open(tmp, "w") as f:
            f.write(f"{os.getpid()}:{self._session_id}")
        os.replace(tmp, STATE_FILE)

    def _read_state(self):
        """(pid, session_id) を返す。読めない場合は (None, None)。"""
        try:
            with open(STATE_FILE, "r") as f:
                content = f.read().strip()
            pid_str, session = content.split(":", 1)
            return int(pid_str), session
        except (ValueError, OSError):
            return None, None

    def _is_stale(self, pid) -> bool:
        if pid is None:
            # mkdir 直後で state がまだ書かれていない場合があるため、猶予を置く
            try:
                return time.time() - os.path.getctime(LOCK_DIR) > 5
            except OSError:
                return True
        try:
            os.kill(pid, 0)
            return False
        except ProcessLookupError:
            return True
        except PermissionError:
            return False

    @staticmethod
    def _stop_previous(pid) -> None:
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            return
        for _ in range(20):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)

    def _cleanup_lock(self) -> None:
        try:
            os.remove(STATE_FILE)
        except OSError:
            pass
        try:
            os.remove(f"{STATE_FILE}.tmp.{os.getpid()}")
        except OSError:
            pass
        try:
            os.rmdir(LOCK_DIR)
        except OSError:
            pass


# ============================================================
# transcript からテキスト抽出
# ============================================================
def _extract_last_turn_text(transcript_path: str) -> str:
    """transcript JSONL から直近ターンの全アシスタントテキストを抽出する。"""
    if not transcript_path or not os.path.isfile(transcript_path):
        return ""

    lines = []
    with open(transcript_path, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                lines.append(stripped)

    text_parts = []
    for raw_line in reversed(lines):
        try:
            entry = json.loads(raw_line)
        except json.JSONDecodeError:
            continue

        entry_type = entry.get("type")

        if entry_type == "assistant":
            msg = entry.get("message", {})
            content = msg.get("content", [])
            for block in reversed(content):
                if isinstance(block, dict) and block.get("type") == "text":
                    text_parts.append(block["text"])

        elif entry_type == "user":
            if "toolUseResult" in entry:
                continue
            break

    text_parts.reverse()
    return "\n\n".join(text_parts)


# ============================================================
# メイン
# ============================================================
def main():
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    session_id = input_data.get("session_id", "")

    message = input_data.get("last_assistant_message", "")
    if not message.strip():
        transcript_path = input_data.get("transcript_path", "")
        message = _extract_last_turn_text(transcript_path)

    if not message.strip():
        sys.exit(0)

    cwd = input_data.get("cwd", "")
    folder_name = os.path.basename(cwd) if cwd else ""

    # 末尾の <speak>...</speak> だけを要約として採用する
    # </speak> の後ろが空白のみの場合に限り、途中のタグは無視して全文処理に進む
    # 末尾の要約が空なら、そのタグを除いた本文を読む
    end = message.rfind("</speak>")
    start = message.rfind("<speak>", 0, end) if end != -1 else -1
    clean_text = ""
    if start != -1 and end != -1 and message[end + len("</speak>"):].strip() == "":
        clean_text = message[start + len("<speak>"):end].strip()
        if not clean_text:
            message = message[:start]
    if not clean_text:
        clean_text = TextProcessor().process(message)

    if not clean_text:
        sys.exit(0)

    if folder_name:
        clean_text = f"{folder_name}の作業です。\n\n{clean_text}"

    tts = get_tts_backend()
    queue = SpeechQueue(session_id)

    # os._exit() は finally を飛ばすため、ロック解放は必ずその直前で行う
    def handle_signal(signum, frame):
        if tts._proc and tts._proc.poll() is None:
            tts._proc.kill()
        queue.release()
        os._exit(0)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    try:
        if not queue.acquire():
            sys.exit(0)
        tts.speak(clean_text)
    finally:
        queue.release()


if __name__ == "__main__":
    main()
