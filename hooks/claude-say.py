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

import json
import os
import platform
import re
import signal
import subprocess
import sys
import time

# --- 設定 ---
VOICE = os.environ.get("CLAUDE_SAY_VOICE", "Kyoko")
RATE = int(os.environ.get("CLAUDE_SAY_RATE", "260"))  # 標準は約200、1.3倍で260
WORK_DIR = os.path.join(os.path.expanduser("~/.claude"), "tmp", "claude-say")
LOCK_DIR = os.path.join(WORK_DIR, "lock")
STATE_FILE = os.path.join(WORK_DIR, "state")  # PID:SESSION_ID を記録
STALE_CHECK_INTERVAL = 2  # ロック待ち中のステイルチェック間隔（秒）


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
        return re.sub(r"```[\s\S]*?```", "コードは省略します。", text)

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
        self._proc = None  # type: subprocess.Popen | None

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
    """セッション番号を考慮した排他制御

    同じセッション（同じタブ）:
      前の読み上げプロセスに SIGTERM を送って差し替える。
      手動の say やほかのタブの say は触らない。

    別セッション（別タブ）:
      ロックが解放されるまで順番待ちする。
    """

    def __init__(self, session_id: str):
        self._session_id = session_id
        self._locked = False

    def acquire(self) -> None:
        os.makedirs(WORK_DIR, exist_ok=True)
        while True:
            try:
                os.mkdir(LOCK_DIR)
                self._locked = True
                self._write_state()
                return
            except FileExistsError:
                if self._is_stale():
                    self._cleanup_lock()
                    continue
                if self._is_same_session():
                    # 同じタブ: 前のプロセスだけを止めて差し替え
                    self._kill_previous()
                    time.sleep(0.3)  # シグナルハンドラがロック解放するのを待つ
                    continue
                # 別タブ: 順番待ち
                time.sleep(STALE_CHECK_INTERVAL)

    def release(self) -> None:
        if not self._locked:
            return
        try:
            os.remove(STATE_FILE)
        except OSError:
            pass
        self._cleanup_tmp_files()
        try:
            os.rmdir(LOCK_DIR)
        except OSError:
            pass
        self._locked = False

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
        except (FileNotFoundError, ValueError, OSError):
            return None, None

    def _is_same_session(self) -> bool:
        _, session = self._read_state()
        return session == self._session_id

    def _kill_previous(self) -> None:
        """前のプロセスに SIGTERM を送り、終了を待つ"""
        pid, _ = self._read_state()
        if pid is None:
            return
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            return
        # 最大2秒間、プロセスの終了を待つ
        for _ in range(20):
            try:
                os.kill(pid, 0)
                time.sleep(0.1)
            except ProcessLookupError:
                return

    def _is_stale(self) -> bool:
        pid, _ = self._read_state()
        if pid is None:
            try:
                lock_age = time.time() - os.path.getctime(LOCK_DIR)
                return lock_age > 5
            except OSError:
                return True
        try:
            os.kill(pid, 0)
            return False
        except ProcessLookupError:
            return True
        except PermissionError:
            return False

    def _cleanup_tmp_files(self) -> None:
        my_pid = str(os.getpid())
        now = time.time()
        try:
            for name in os.listdir(WORK_DIR):
                if not name.startswith("state.tmp."):
                    continue
                path = os.path.join(WORK_DIR, name)
                if name == f"state.tmp.{my_pid}":
                    try:
                        os.remove(path)
                    except OSError:
                        pass
                    continue
                try:
                    age = now - os.path.getmtime(path)
                    if age > 10:
                        os.remove(path)
                except OSError:
                    pass
        except OSError:
            pass

    def _cleanup_lock(self) -> None:
        try:
            os.remove(STATE_FILE)
        except OSError:
            pass
        self._cleanup_tmp_files()
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
            for block in content:
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
    # stdin から hook の入力 JSON を読む
    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    session_id = input_data.get("session_id", "")

    # 応答テキストの取得
    message = input_data.get("last_assistant_message", "")
    if not message.strip():
        transcript_path = input_data.get("transcript_path", "")
        message = _extract_last_turn_text(transcript_path)

    if not message.strip():
        sys.exit(0)

    # フォルダ名を取得（冒頭アナウンス用）
    cwd = input_data.get("cwd", "")
    folder_name = os.path.basename(cwd) if cwd else ""

    # 末尾から探して最後の <speak>...</speak> だけを抽出する
    end = message.rfind("</speak>")
    start = message.rfind("<speak>", 0, end) if end != -1 else -1
    if start != -1 and end != -1:
        clean_text = message[start + len("<speak>"):end].strip()
    else:
        processor = TextProcessor()
        clean_text = processor.process(message)

    if not clean_text:
        sys.exit(0)

    # 冒頭にフォルダ名アナウンス
    if folder_name:
        clean_text = f"{folder_name}の作業です。\n\n{clean_text}"

    # TTS バックエンド取得
    tts = get_tts_backend()
    queue = SpeechQueue(session_id)

    # SIGTERM/SIGINT で say を即座に止めてロックを解放する
    # 注意: os._exit() は finally を飛ばすため、ロック解放は必ずその直前で行うこと
    def handle_signal(signum, frame):
        if tts._proc and tts._proc.poll() is None:
            tts._proc.kill()   # SIGKILL で即座に停止（SIGTERM だと待ちが発生する）
        queue.release()        # ← os._exit の前に必ず実行すること
        os._exit(0)            # sys.exit だと communicate() 内で伝播しない場合がある

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # 排他制御つきで読み上げ
    try:
        queue.acquire()
        tts.speak(clean_text)
    finally:
        queue.release()


if __name__ == "__main__":
    main()
