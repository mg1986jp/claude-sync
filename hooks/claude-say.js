#!/usr/bin/env node
/**
 * Claude Code 読み上げフック (Stop hook)
 *
 * Claude Code の応答を OS の音声合成で読み上げる。
 * hooks.Stop に async: true で登録し、バックグラウンドで動作する。
 *
 * 応答の末尾に <speak>〜</speak> タグがあればその中身だけを読む。
 * なければ全文から Markdown を除去して読む。
 *
 * 排他制御:
 *   同じタブ（同一セッション）→ 前の読み上げを止めて新しい方に差し替え
 *   別のタブ（別セッション）→ 順番待ち
 *   手動の say は一切触らない
 *
 * 構成:
 *   TextProcessor  - Markdown 除去・コードブロック置換（OS 非依存）
 *   MacTTS         - say コマンド呼び出し（macOS 固有）
 *   getTtsBackend  - OS ごとの TTS の選択（Windows はここに追加する）
 *   SpeechQueue    - mkdir ベースの排他制御（OS 非依存）
 *
 * Node の標準モジュールだけで動く（npm パッケージ不要）。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

// --- 設定 ---
const DEFAULT_VOICE = 'Kyoko';
const DEFAULT_RATE = 260;
const VOICE = process.env.CLAUDE_SAY_VOICE || DEFAULT_VOICE;
const RATE = parseRate(process.env.CLAUDE_SAY_RATE);
const WORK_DIR = path.join(os.homedir(), '.claude', 'tmp', 'claude-say');
const LOCK_DIR = path.join(WORK_DIR, 'lock');
const STATE_FILE = path.join(WORK_DIR, 'state');
const STALE_CHECK_INTERVAL_MS = 2000;

function parseRate(value) {
  const rate = Number.parseInt(value ?? '', 10);
  return Number.isInteger(rate) && rate > 0 ? rate : DEFAULT_RATE;
}

// ============================================================
// テキスト処理（OS 非依存）
// ============================================================

// Python の str.splitlines() と同じ文字で行を区切る（改行文字は行に残す）
const LINE_WITH_END = /[^\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])?/g;

function splitLinesKeepEnds(text) {
  return (text.match(LINE_WITH_END) || []).filter((line) => line !== '');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Markdown 記法を除去し、読み上げに適したプレーンテキストに変換する */
class TextProcessor {
  process(text) {
    text = this.#removeTimestamp(text);
    text = this.#replaceCodeBlocks(text);
    text = this.#removeInsightDecoration(text);
    text = this.#replaceUrls(text);
    text = this.#shortenLongPaths(text);
    text = this.#removeTableSeparators(text);
    text = this.#cleanTableRows(text);
    text = this.#removeHeadings(text);
    text = this.#removeEmphasis(text);
    text = this.#removeInlineCode(text);
    text = this.#removeListMarkers(text);
    text = this.#removeBlockquotes(text);
    text = this.#compressBlankLines(text);
    return text.trim();
  }

  #removeTimestamp(text) {
    return text.replace(/^回答日時：.*$/gm, '');
  }

  /** CommonMark 準拠の行単位フェンス処理。``` と ~~~ の両方に対応。 */
  #replaceCodeBlocks(text) {
    const result = [];
    let closingFence = null;
    for (const line of splitLinesKeepEnds(text)) {
      if (closingFence !== null) {
        if (closingFence.test(line.replace(/[\r\n]+$/, ''))) {
          closingFence = null;
        }
        continue;
      }
      const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
      if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
        const char = escapeRegExp(match[1][0]);
        closingFence = new RegExp(`^ {0,3}${char}{${match[1].length},}[ \\t]*$`);
        result.push('コードは省略します。\n');
      } else {
        result.push(line);
      }
    }
    return result.join('');
  }

  #removeInsightDecoration(text) {
    return text.replace(/^.*[★].*Insight.*$/gm, '').replace(/─{3,}/g, '');
  }

  #replaceUrls(text) {
    return text.replace(/https?:\/\/[^\s)>\]]+/g, 'URLは省略します');
  }

  #shortenLongPaths(text) {
    // Python の \w は日本語も含むため、JS では \p{L}\p{N}_ で同じ範囲にする
    return text.replace(/(?<![.\p{L}\p{N}_])[~/](?:[^\s/]+\/){2,}[^\s/]*/gu, (p) => {
      const basename = p.replace(/\/+$/, '').split('/').pop();
      return basename ? `ファイル ${basename}` : '';
    });
  }

  #removeTableSeparators(text) {
    return text.replace(/^\|[\s\-:|]+\|$/gm, '');
  }

  #cleanTableRows(text) {
    return text.replace(/^\|(.+)\|$/gm, (_, inner) => inner.replaceAll('|', '、'));
  }

  #removeHeadings(text) {
    return text.replace(/^#{1,6}\s+/gm, '');
  }

  #removeEmphasis(text) {
    return text.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
  }

  #removeInlineCode(text) {
    return text.replace(/`([^`]+)`/g, '$1');
  }

  #removeListMarkers(text) {
    // Python の \d は全角数字も含むため、JS では \p{Nd} を使う
    return text.replace(/^\s*[-*]\s+/gm, '').replace(/^\s*\p{Nd}+\.\s+/gmu, '');
  }

  #removeBlockquotes(text) {
    return text.replace(/^>\s*/gm, '');
  }

  #compressBlankLines(text) {
    return text.replace(/\n{3,}/g, '\n\n');
  }
}

// ============================================================
// TTS バックエンド（OS ごとに実装を分離）
//   どのバックエンドも次の2つを持つ:
//     speak(text): Promise<void>  読み終わったら（失敗しても）resolve する
//     kill(): void                読み上げを即座に止める（シグナル受信時に使う）
// ============================================================

/** macOS の say コマンドで読み上げる */
class MacTTS {
  #voice;
  #rate;
  #proc = null;

  constructor(voice, rate) {
    this.#voice = voice;
    this.#rate = rate;
  }

  speak(text) {
    return new Promise((resolve) => {
      this.#proc = spawn('say', ['-v', this.#voice, '-r', String(this.#rate)], {
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      this.#proc.on('error', () => resolve());
      this.#proc.on('close', () => resolve());
      this.#proc.stdin.on('error', () => {}); // say が先に終了した場合の EPIPE を無視する
      this.#proc.stdin.end(text, 'utf8');
    });
  }

  kill() {
    if (this.#proc && this.#proc.exitCode === null && this.#proc.signalCode === null) {
      this.#proc.kill('SIGKILL');
    }
  }
}

/** 実行中の OS に応じた TTS バックエンドを返す。対応していない OS では null。 */
function getTtsBackend() {
  switch (process.platform) {
    case 'darwin':
      return new MacTTS(VOICE, RATE);
    case 'win32':
      // TODO(Windows): speak(text) と kill() を持つ WindowsTTS を作り、ここで返す
      return null;
    default:
      return null;
  }
}

// ============================================================
// 排他制御（mkdir ロック + セッション番号による差し替え）
// ============================================================

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM は「プロセスはいるが権限がない」なので生きている扱い
    return err.code !== 'ESRCH';
  }
}

function removeQuietly(remove, target) {
  try {
    remove(target);
  } catch {
    // 既に無い場合などは無視する
  }
}

/**
 * mkdir ロックによる排他制御
 *
 * 同じセッション（同じタブ）:
 *   前の読み上げプロセスに SIGTERM を送って差し替える。
 *   待っている間に同じタブから新しい返事が来たら、読まずに終了する。
 *
 * 別セッション（別タブ）:
 *   ロックが解放されるまで順番待ちする。
 */
class SpeechQueue {
  static MAX_RETRIES = 10;

  #sessionId;
  #locked = false;
  #requestId = crypto.randomUUID();
  #latestPath;

  constructor(sessionId) {
    this.#sessionId = sessionId;
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    this.#latestPath = path.join(WORK_DIR, `latest-${sessionHash}`);
  }

  /** ロックを取得する。同じタブの新しい返事に追い越されたら false を返す。 */
  async acquire() {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    this.#registerRequest();
    let retries = 0;
    while (this.#isLatestRequest()) {
      try {
        fs.mkdirSync(LOCK_DIR);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const { pid, session } = this.#readState();
        if (this.#isStale(pid)) {
          retries += 1;
          if (retries > SpeechQueue.MAX_RETRIES) return false;
          this.#cleanupLock();
          await sleep(100);
        } else if (session === this.#sessionId) {
          await SpeechQueue.#stopPrevious(pid);
        } else {
          await sleep(STALE_CHECK_INTERVAL_MS);
        }
        continue;
      }
      this.#locked = true;
      this.#writeState();
      return true;
    }
    return false;
  }

  release() {
    if (!this.#locked) return;
    this.#cleanupLock();
    this.#locked = false;
  }

  #registerRequest() {
    const tmp = `${this.#latestPath}.${process.pid}`;
    fs.writeFileSync(tmp, this.#requestId);
    fs.renameSync(tmp, this.#latestPath);
  }

  #isLatestRequest() {
    try {
      return fs.readFileSync(this.#latestPath, 'utf8').trim() === this.#requestId;
    } catch {
      return true;
    }
  }

  #writeState() {
    const tmp = `${STATE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${process.pid}:${this.#sessionId}`);
    fs.renameSync(tmp, STATE_FILE);
  }

  /** { pid, session } を返す。読めない場合はどちらも null。 */
  #readState() {
    try {
      const content = fs.readFileSync(STATE_FILE, 'utf8').trim();
      const sep = content.indexOf(':');
      const pidStr = sep === -1 ? '' : content.slice(0, sep);
      // 0 や負の PID はプロセスグループ宛てになるため、壊れた state として扱う
      if (!/^\d+$/.test(pidStr) || Number(pidStr) === 0) return { pid: null, session: null };
      return { pid: Number(pidStr), session: content.slice(sep + 1) };
    } catch {
      return { pid: null, session: null };
    }
  }

  #isStale(pid) {
    if (pid === null) {
      // mkdir 直後で state がまだ書かれていない場合があるため、猶予を置く
      try {
        return Date.now() - fs.statSync(LOCK_DIR).ctimeMs > 5000;
      } catch {
        return true;
      }
    }
    return !isProcessAlive(pid);
  }

  static async #stopPrevious(pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
    for (let i = 0; i < 20; i++) {
      if (!isProcessAlive(pid)) return;
      await sleep(100);
    }
  }

  #cleanupLock() {
    removeQuietly(fs.rmSync, STATE_FILE);
    removeQuietly(fs.rmSync, `${STATE_FILE}.tmp.${process.pid}`);
    removeQuietly(fs.rmdirSync, LOCK_DIR);
  }
}

// ============================================================
// transcript からテキスト抽出
// ============================================================

/** transcript JSONL から直近ターンの全アシスタントテキストを抽出する。 */
function extractLastTurnText(transcriptPath) {
  if (!transcriptPath) return '';
  let raw;
  try {
    if (!fs.statSync(transcriptPath).isFile()) return '';
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }

  const lines = raw.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  const textParts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;

    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j];
        if (block?.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
    } else if (entry.type === 'user') {
      if ('toolUseResult' in entry) continue;
      break;
    }
  }

  return textParts.reverse().join('\n\n');
}

// ============================================================
// 読む文章の決定
// ============================================================

const SPEAK_OPEN = '<speak>';
const SPEAK_CLOSE = '</speak>';

/**
 * 末尾の <speak>...</speak> だけを要約として採用する。
 * </speak> の後ろが空白のみの場合に限り、途中のタグは無視して全文処理に進む。
 * 末尾の要約が空なら、そのタグを除いた本文を読む。
 */
function buildSpeechText(message) {
  const end = message.lastIndexOf(SPEAK_CLOSE);
  const start = end >= SPEAK_OPEN.length ? message.lastIndexOf(SPEAK_OPEN, end - SPEAK_OPEN.length) : -1;
  let cleanText = '';
  if (start !== -1 && message.slice(end + SPEAK_CLOSE.length).trim() === '') {
    cleanText = message.slice(start + SPEAK_OPEN.length, end).trim();
    if (!cleanText) message = message.slice(0, start);
  }
  if (!cleanText) cleanText = new TextProcessor().process(message);
  return cleanText;
}

// ============================================================
// メイン
// ============================================================

function readHookInput() {
  try {
    const data = JSON.parse(fs.readFileSync(0, 'utf8'));
    return data !== null && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

async function main() {
  const input = readHookInput();
  if (!input) return;

  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';

  let message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (!message.trim()) {
    message = extractLastTurnText(typeof input.transcript_path === 'string' ? input.transcript_path : '');
  }
  if (!message.trim()) return;

  let speechText = buildSpeechText(message);
  if (!speechText) return;

  const folderName = typeof input.cwd === 'string' && input.cwd ? path.basename(input.cwd) : '';
  if (folderName) speechText = `${folderName}の作業です。\n\n${speechText}`;

  const tts = getTtsBackend();
  if (!tts) return;
  const queue = new SpeechQueue(sessionId);

  // process.exit() は finally を飛ばすため、ロック解放は必ずその直前で行う
  const handleSignal = () => {
    tts.kill();
    queue.release();
    process.exit(0);
  };
  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  try {
    if (!(await queue.acquire())) return;
    await tts.speak(speechText);
  } finally {
    queue.release();
  }
}

if (require.main === module) {
  main().catch(() => process.exit(0));
} else {
  module.exports = { TextProcessor, buildSpeechText, extractLastTurnText };
}
