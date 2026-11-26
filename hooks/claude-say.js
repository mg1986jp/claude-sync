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
 *   WindowsTTS     - Windows PowerShell 5.1 の System.Speech 呼び出し（Windows 固有）
 *   getTtsBackend  - OS ごとの TTS の選択
 *   SpeechQueue    - mkdir ベースの排他制御（OS 非依存。前の読み上げの止め方だけ OS ごとに違う）
 *
 * 設定（環境変数）:
 *   CLAUDE_SAY_VOICE     声の名前（macOS の初期値: Kyoko / Windows の初期値: Microsoft Haruka Desktop）
 *                        Windows では、指定した声が入っていなければ日本語の声に切り替える
 *   CLAUDE_SAY_RATE      macOS の速さ（say -r の値。正の整数、初期値 260）
 *   CLAUDE_SAY_WIN_RATE  Windows の速さ（System.Speech の Rate。-10〜10 の整数、初期値 3 ≒ 標準の約1.4倍）
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
// 声の名前も速さの目盛りも OS ごとに違うため、初期値は OS ごとに持つ
const MAC_DEFAULT_VOICE = 'Kyoko';
const MAC_DEFAULT_RATE = 260; // say -r の値（1分あたりの語数）
const WIN_DEFAULT_VOICE = 'Microsoft Haruka Desktop';
const WIN_DEFAULT_RATE = 3; // System.Speech の Rate（0 が標準の速さ。3 で約1.4倍）
const WIN_RATE_MIN = -10;
const WIN_RATE_MAX = 10;
const WORK_DIR = path.join(os.homedir(), '.claude', 'tmp', 'claude-say');
const LOCK_DIR = path.join(WORK_DIR, 'lock');
const STATE_FILE = path.join(WORK_DIR, 'state');
const STALE_CHECK_INTERVAL_MS = 2000;

// Windows のコマンドは絶対パスで呼ぶ（フックは作業中のフォルダで動くため、同名の実行ファイルを拾わないようにする）
const WIN_SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const WIN_POWERSHELL = path.join(WIN_SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const WIN_TASKKILL = path.join(WIN_SYSTEM32, 'taskkill.exe');
const WIN_TASKLIST = path.join(WIN_SYSTEM32, 'tasklist.exe');

/** say -r に渡す速さ。正の整数でなければ初期値を使う。 */
function parseMacRate(value) {
  const rate = Number.parseInt(value ?? '', 10);
  return Number.isInteger(rate) && rate > 0 ? rate : MAC_DEFAULT_RATE;
}

/** System.Speech の Rate に渡す速さ。-10〜10 の整数でなければ初期値を使う。 */
function parseWinRate(value) {
  const rate = Number.parseInt(value ?? '', 10);
  return Number.isInteger(rate) && rate >= WIN_RATE_MIN && rate <= WIN_RATE_MAX ? rate : WIN_DEFAULT_RATE;
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

/**
 * Windows PowerShell 5.1 に -EncodedCommand で渡す読み上げスクリプト
 *
 * - 文章は標準入力から UTF-8 のバイト列として読む
 *   （PowerShell 5.1 は標準入力を OEM コードページ（日本語環境では cp932）で解釈するため、そのままだと化ける）
 * - 声と速さは環境変数で受け取る（コマンドラインに埋め込むと引用符の扱いが必要になるため）
 * - 声は「指定した声 → 日本語の女性の声 → 日本語の声」の順に、入っているものを選ぶ
 * - Speak() は合成しながら再生し、読み終わるまで戻らない
 */
const WINDOWS_SPEAK_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$buffer = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($buffer)
$text = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
  $japanese = @($voices | Where-Object { $_.Culture.Name -eq 'ja-JP' })
  $candidates = @($voices | Where-Object { $_.Name -eq $env:CLAUDE_SAY_SAPI_VOICE }) + @($japanese | Where-Object { $_.Gender -eq 'Female' }) + $japanese
  if ($candidates.Count -gt 0) { $synth.SelectVoice($candidates[0].Name) }
  $synth.Rate = [int]$env:CLAUDE_SAY_SAPI_RATE
  $synth.SetOutputToDefaultAudioDevice()
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
`;

/** Windows の System.Speech（SAPI の声）で読み上げる */
class WindowsTTS {
  #voice;
  #rate;
  #proc = null;

  constructor(voice, rate) {
    this.#voice = voice;
    this.#rate = rate;
  }

  speak(text) {
    return new Promise((resolve) => {
      const encoded = Buffer.from(WINDOWS_SPEAK_SCRIPT, 'utf16le').toString('base64');
      this.#proc = spawn(WIN_POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        stdio: ['pipe', 'inherit', 'inherit'],
        windowsHide: true,
        env: { ...process.env, CLAUDE_SAY_SAPI_VOICE: this.#voice, CLAUDE_SAY_SAPI_RATE: String(this.#rate) },
      });
      this.#proc.on('error', () => resolve());
      this.#proc.on('close', () => resolve());
      this.#proc.stdin.on('error', () => {}); // PowerShell が先に終了した場合の EPIPE を無視する
      this.#proc.stdin.end(text, 'utf8');
    });
  }

  kill() {
    // 読み上げは PowerShell のプロセスの中で行うため、プロセスを終わらせれば声も止まる
    if (this.#proc && this.#proc.exitCode === null && this.#proc.signalCode === null) {
      this.#proc.kill();
    }
  }
}

/** 実行中の OS に応じた TTS バックエンドを返す。対応していない OS では null。 */
function getTtsBackend() {
  const voice = process.env.CLAUDE_SAY_VOICE;
  switch (process.platform) {
    case 'darwin':
      return new MacTTS(voice || MAC_DEFAULT_VOICE, parseMacRate(process.env.CLAUDE_SAY_RATE));
    case 'win32':
      return new WindowsTTS(voice || WIN_DEFAULT_VOICE, parseWinRate(process.env.CLAUDE_SAY_WIN_RATE));
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

/** SpeechQueue.#stopPrevious() の結果 */
const StopResult = Object.freeze({
  STOPPED: 'stopped', // 止めた（または、もう終わっていた）
  NOT_OWNER: 'not-owner', // PID が読み上げのプロセスではなかった（使い回し）→ 持ち主のいないロックとして片付ける
  KILL_FAILED: 'kill-failed', // 止められなかった → ロックは残して試し直す
  QUERY_FAILED: 'query-failed', // 止めてよいかを確かめられなかった → ロックは残して読み上げをあきらめる
});

/**
 * mkdir ロックによる排他制御
 *
 * 同じセッション（同じタブ）:
 *   前の読み上げプロセスに SIGTERM を送って差し替える（Windows では taskkill で子プロセスごと止める）。
 *   待っている間に同じタブから新しい返事が来たら、読まずに終了する。
 *   Windows で前の読み上げを止めてよいか確かめられないとき、または止められないときは、ロックを残して読まずに終了する。
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
  #retries = 0;

  constructor(sessionId) {
    this.#sessionId = sessionId;
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    this.#latestPath = path.join(WORK_DIR, `latest-${sessionHash}`);
  }

  /**
   * ロックを取得する。次のときは false を返す。
   *   - 同じタブの新しい返事に追い越された
   *   - 前の読み上げを止めてよいか確かめられなかった、または止められなかった（ロックは残す）
   *   - 試し直しが MAX_RETRIES 回を超えた
   */
  async acquire() {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    this.#registerRequest();
    while (this.#isLatestRequest()) {
      try {
        fs.mkdirSync(LOCK_DIR);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const { pid, session } = this.#readState();
        // 状態を読んだあとに確かめ直す。同じタブの新しい返事がもうロックを取っていたら、それを止めずに終わる
        if (!this.#isLatestRequest()) return false;
        if (this.#isStale(pid)) {
          if (!this.#countRetry()) return false;
          this.#cleanupLock();
          await sleep(100);
        } else if (session === this.#sessionId) {
          const result = await SpeechQueue.#stopPrevious(pid);
          if (result === StopResult.QUERY_FAILED) return false; // 止めてよいか分からないので、ロックは残す
          if (result === StopResult.NOT_OWNER || result === StopResult.KILL_FAILED) {
            if (!this.#countRetry()) return false;
            // 持ち主でなければロックを片付ける。止められなかったときは、ロックを残したまま試し直す
            if (result === StopResult.NOT_OWNER) this.#cleanupLock();
            await sleep(100);
          }
        } else {
          await sleep(STALE_CHECK_INTERVAL_MS);
        }
        continue;
      }
      this.#locked = true;
      // ロックを取ったあとにも確かめ直す。同じタブの新しい返事が来ていたら、ロックを譲って終わる
      if (!this.#isLatestRequest()) {
        this.release();
        return false;
      }
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

  /** 試し直しを1回数える。MAX_RETRIES 回を超えたら false を返す（延々と続けないため）。 */
  #countRetry() {
    this.#retries += 1;
    return this.#retries <= SpeechQueue.MAX_RETRIES;
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

  /**
   * 前の読み上げを止め、プロセスが終わるまで最大2秒待つ。結果は StopResult で返す。
   * 2秒待っても終わらなければ KILL_FAILED を返す。
   *
   * Windows では process.kill() が SIGTERM でも即座に終了させるため、前のプロセスの後片付け
   * （子の PowerShell を止める、ロックを解放する）が動かない。そこで taskkill で子プロセスごと止める。
   * 子プロセスごと止めるので、その前に PID が node.exe のものかを確かめ、違えば止めない。
   * 止めたあとに残ったロックは、acquire() の次のループで「持ち主のいないロック」として片付く。
   */
  static async #stopPrevious(pid) {
    if (process.platform === 'win32') {
      const isNode = await SpeechQueue.#isNodeProcessOnWindows(pid);
      if (isNode === null) return StopResult.QUERY_FAILED;
      if (!isNode) return StopResult.NOT_OWNER;
      // taskkill が失敗しても、その間に終わっていれば止める必要はない（ロックは次のループで片付く）
      if (!(await SpeechQueue.#killProcessTreeOnWindows(pid)) && isProcessAlive(pid)) return StopResult.KILL_FAILED;
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        return StopResult.STOPPED;
      }
    }
    for (let i = 0; i < 20; i++) {
      if (!isProcessAlive(pid)) return StopResult.STOPPED;
      await sleep(100);
    }
    // 2秒待っても終わらなければ止められなかったとみなし、試し直しの回数に数えさせる（MAX_RETRIES で打ち切る）
    return StopResult.KILL_FAILED;
  }

  /**
   * その PID のプロセスが node.exe かを tasklist で確かめる。
   *   true:  node.exe
   *   false: 別のプロセス、または、もういない
   *   null:  照会に失敗した（起動できない、終了コードが0以外、出力を読めない）
   */
  static #isNodeProcessOnWindows(pid) {
    return new Promise((resolve) => {
      const proc = spawn(WIN_TASKLIST, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let output = '';
      proc.stdout?.on('data', (chunk) => {
        output += chunk.toString('latin1'); // 見るのは ASCII のイメージ名と PID だけなので、文字コードは問わない
      });
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        if (code !== 0) return resolve(null);
        // 例: "node.exe","1234","Console","1","45,678 K"
        const row = /^"([^"]*)","(\d+)"/m.exec(output);
        if (row) return resolve(Number(row[2]) === pid ? row[1].toLowerCase() === 'node.exe' : null);
        // 一覧に出ないとき、tasklist は案内の文（言語によって違う）だけを出す。
        // プロセスがもういなければ「別のプロセス」と同じ扱い。いるのに出てこないなら、出力を読めなかったとみなす
        return resolve(isProcessAlive(pid) ? null : false);
      });
    });
  }

  /** taskkill で子プロセスごと止める。終了コードが0のときだけ true（起動できない、0以外は false） */
  static #killProcessTreeOnWindows(pid) {
    return new Promise((resolve) => {
      const proc = spawn(WIN_TASKKILL, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
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
