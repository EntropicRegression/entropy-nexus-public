import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLockers, lockedPathsFromOutput } from './lockers.ts';
import type { LockerInfo, VerifyCommandDef, VerifyCommandOutcome, VerifyCommandResult, VerifyLocation, VerifyOutcome, VerifyResult } from '../../shared/flow.ts';

/**
 * 核實(docs/協作流程實作計畫.md §5.2):主控台自己重跑流程定義裡的核實指令,不採信節點的自述。
 * - 每條指令都有逾時;逾時時連同它啟動的子程序、孫程序一起終止(Windows 用 taskkill /T /F,posix 用程序群組)。
 * - 一層 needs:前置指令沒通過時,後面的指令標「略過(前置失敗)」,不再記成另一筆失敗。
 * - 結果:通過、失敗、被環境擋住(找不到指令、或找到鎖住檔案的程序)、逾時(附卡在哪條指令、最後一行輸出)、
 *   核實指令改到受版本控制的檔案(modified:交給使用者,逐指令列出改了哪些檔)。
 * - 環境隔離:清掉主控台與 npm 的環境變數,NEXUS_DATA_DIR 指到臨時資料夾(被測的主控台不碰真實的 userData 與記憶庫設定)。
 * - desktop: true 的指令只有允許桌面核實、而且呼叫端給了獨立 worktree 時才跑;沒跑就在 notVerified 寫「未跑桌面核實」。
 * 這個檔案不知道副本怎麼建立:改檔偵測與找鎖定程序都由呼叫端注入。
 */

/** 輸出只保留最後這麼多位元組(寫進 log)。 */
const TAIL_BYTES = 64 * 1024;
/** 終止程序樹之後,最多再等這麼久讓 close 事件進來。 */
const KILL_GRACE_MS = 5000;

/** 判斷環境原因時只看輸出的最後這麼多行(前面的內容可能是測試名稱、斷言訊息、清理暫存時印出的錯誤)。 */
const TAIL_LINES = 20;

/** 找不到指令:這種情況一定是環境問題(指令根本沒跑起來),直接判被環境擋住。 */
const NOT_FOUND_RE = /不是內部或外部命令|is not recognized as an internal or external command|command not found/i;

/**
 * 可能的環境原因。單憑輸出不足以判定(實作錯誤的訊息也可能含這些字),所以只附在失敗結果上;
 * lockable 的那幾類若真的找到鎖住檔案的程序,才改判被環境擋住。
 */
const ENV_HINTS: { re: RegExp; why: string; lockable: boolean }[] = [
  { re: /\bEBUSY\b|resource busy or locked|being used by another process|另一個程序正在使用|正由另一個程序使用/i, why: '檔案可能被其他程式鎖住', lockable: true },
  { re: /\bEPERM\b|operation not permitted/i, why: '沒有權限(可能是檔案被其他程式鎖住)', lockable: true },
  { re: /\bEACCES\b|permission denied|存取被拒/i, why: '存取被拒(可能是權限或檔案被鎖住)', lockable: true },
  { re: /\bEADDRINUSE\b|address already in use/i, why: '連接埠可能已被占用', lockable: false },
  { re: /\bENOSPC\b|no space left on device|磁碟空間不足/i, why: '磁碟空間可能不足', lockable: false },
];

const tailLines = (text: string, n = TAIL_LINES) => text.split(/\r?\n/).filter(l => l.trim()).slice(-n).join('\n');

/** 依一層 needs 排出執行順序:照定義順序,遇到還沒排的前置指令就先排它。 */
export function orderCommands(cmds: VerifyCommandDef[]): VerifyCommandDef[] {
  const byId = new Map(cmds.map(c => [c.id, c]));
  const out: VerifyCommandDef[] = [];
  const placed = new Set<VerifyCommandDef>();
  const place = (c: VerifyCommandDef, depth: number) => {
    if (placed.has(c)) return;
    placed.add(c);
    // 定義檔只允許一層且已擋掉循環;萬一還是有,深度上限讓它照原順序排,執行時會因為前置沒通過而略過
    if (depth < 2) for (const n of c.needs) { const d = byId.get(n); if (d) place(d, depth + 1); }
    out.push(c);
  };
  for (const c of cmds) place(c, 0);
  return out;
}

export interface Classified {
  outcome: 'pass' | 'fail' | 'blocked';
  reason?: string;
  /** 失敗時「可能的環境原因」(只看最後 20 行)。 */
  envHint?: string;
  /** envHint 屬於檔案被鎖這一類:找到鎖定程序時改判被環境擋住。 */
  lockable?: boolean;
}

/**
 * 單條指令的結果分類(不含找鎖定程序那一步,見 runVerify):
 * - 根本沒能啟動(spawnError)、結束代碼 9009/127、最後 20 行出現「找不到指令」→ 被環境擋住;
 * - 結束代碼 0 → 通過;
 * - 其他 → 失敗;最後 20 行有 EBUSY、EPERM、EACCES、EADDRINUSE、ENOSPC 之類的字,附成 envHint。
 */
export function classify(exitCode: number | null, output: string, spawnError?: string): Classified {
  if (spawnError) return { outcome: 'blocked', reason: `無法啟動:${spawnError}` };
  if (exitCode === 0) return { outcome: 'pass' };
  // Windows 的 cmd 找不到指令是 9009,posix 的 shell 是 127
  if (exitCode === 9009 || exitCode === 127) return { outcome: 'blocked', reason: '找不到指令' };
  const tail = tailLines(output);
  if (NOT_FOUND_RE.test(tail)) return { outcome: 'blocked', reason: '找不到指令' };
  const hint = ENV_HINTS.find(h => h.re.test(tail));
  return hint ? { outcome: 'fail', envHint: hint.why, lockable: hint.lockable } : { outcome: 'fail' };
}

/** 終止程序與它所有的子孫程序。Windows 用 taskkill /T /F;posix 程序是用 detached 啟動的,送訊號給整個程序群組。 */
export function killTree(pid: number): Promise<void> {
  return new Promise(res => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, () => res());
      return;
    }
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已經結束 */ } }
    res();
  });
}

/**
 * 核實時不能帶過去的環境變數:主控台自己的 NEXUS_*;Electron 的 ELECTRON_*(例如 npm run dev 時的 ELECTRON_RENDERER_URL
 * 會讓被測的 Electron 專案載入錯誤的頁面);npm 腳本注入的 npm_*、INIT_CWD;會改變 git 對象的 GIT_DIR、GIT_WORK_TREE、GIT_INDEX_FILE;NODE_OPTIONS。
 */
const DROP_ENV = /^(?:NEXUS_.*|ELECTRON_.*|npm_.*|INIT_CWD|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|NODE_OPTIONS)$/i;

/** 核實用的環境變數:清掉 DROP_ENV 列的,設 CI=1、FORCE_COLOR=0。 */
export function verifyEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || DROP_ENV.test(k)) continue;
    env[k] = v;
  }
  env.CI = '1';
  env.FORCE_COLOR = '0';
  return env;
}

/** Windows 主控台字碼頁對應的 TextDecoder 編碼;cmd 自己的訊息(例如「不是內部或外部命令」)用這個編碼輸出。 */
const CODEPAGES: Record<number, string> = { 950: 'big5', 936: 'gbk', 932: 'shift_jis', 949: 'euc-kr', 1252: 'windows-1252', 65001: 'utf-8' };

let codepageOnce: Promise<number | null> | null = null;
/** 目前的主控台字碼頁(只在 Windows 查一次);查不到時為 null。 */
function consoleCodepage(): Promise<number | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  codepageOnce ??= new Promise(res => {
    execFile('cmd.exe', ['/d', '/c', 'chcp'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const m = /(\d+)\s*$/.exec(String(stdout).trim());
      res(err || !m ? null : Number(m[1]));
    });
  });
  return codepageOnce;
}

/**
 * 輸出解碼,逐行判斷:先當 UTF-8(node、npm、tsc 都輸出 UTF-8);某一行解出亂碼(U+FFFD)而且主控台字碼頁不是 UTF-8 時,
 * 只有那一行改用字碼頁的編碼(同一段輸出常常混著 cmd 的訊息與工具的 UTF-8 輸出)。
 * 以 0x0A 切行是安全的:Big5、GBK、Shift_JIS、EUC-KR 的雙位元組字元都不會用到 0x0A。
 */
export function decodeOutput(buf: Buffer, codepage: number | null): string {
  const enc = codepage ? CODEPAGES[codepage] : undefined;
  if (!enc || enc === 'utf-8') return buf.toString('utf8');
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(enc); } catch { return buf.toString('utf8'); }
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0x0a) continue;
    const line = buf.subarray(start, i);
    const utf8 = line.toString('utf8');
    lines.push(utf8.includes('\uFFFD') ? decoder.decode(line) : utf8);
    start = i + 1;
  }
  return lines.join('\n');
}

const lastLineOf = (text: string) => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop()?.slice(0, 500) ?? '';

interface RunOne { exitCode: number | null; output: string; timedOut: boolean; aborted?: boolean; spawnError?: string; ms: number }

/** 跑一條指令,收最後 64KB 的輸出;逾時或中止(signal)就終止整個程序樹。 */
function runOne(run: string, cwd: string, timeoutSec: number, env: Record<string, string>, codepage: number | null, signal?: AbortSignal): Promise<RunOne> {
  return new Promise(resolveRun => {
    if (signal?.aborted) { resolveRun({ exitCode: null, output: '', timedOut: false, aborted: true, ms: 0 }); return; }
    const t0 = Date.now();
    let chunks: Buffer[] = [];
    let size = 0;
    const keep = (d: Buffer) => {
      chunks.push(d); size += d.length;
      while (size > TAIL_BYTES * 2 && chunks.length > 1) size -= chunks.shift()!.length;
    };
    let finished = false;
    let timedOut = false;
    let aborted = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      let buf = Buffer.concat(chunks);
      if (buf.length > TAIL_BYTES) buf = buf.subarray(buf.length - TAIL_BYTES);
      chunks = [];
      resolveRun({ exitCode: timedOut || aborted ? null : exitCode, output: decodeOutput(buf, codepage), timedOut, ...(aborted ? { aborted } : {}), spawnError, ms: Date.now() - t0 });
    };
    // 停止流程或關閉主控台:終止整個程序樹,給一段寬限後收尾
    const onAbort = () => {
      if (finished || aborted) return;
      aborted = true;
      const pid = child?.pid;
      if (pid) void killTree(pid);
      grace = setTimeout(() => finish(null), KILL_GRACE_MS);
    };
    let child: ChildProcess | undefined;
    try {
      child = spawn(run, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolveRun({ exitCode: null, output: '', timedOut: false, spawnError: (e as Error).message, ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child?.pid;
      if (pid) void killTree(pid);
      // 孫程序若還握著輸出管線,close 可能遲遲不來;給一段寬限後直接收尾
      grace = setTimeout(() => finish(null), KILL_GRACE_MS);
    }, timeoutSec * 1000);
    signal?.addEventListener('abort', onAbort);
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', err => finish(null, err.message));
    child.on('close', code => finish(code));
  });
}

export interface VerifyOptions {
  /** 一般指令的執行位置:核實副本(預設)或獨立 worktree(專案設定 verify_in: worktree),已接上 node_modules。 */
  cwd: string;
  /** cwd 是副本還是 worktree(只用來標在結果上)。 */
  location?: VerifyLocation;
  commands: VerifyCommandDef[];
  /** 核實的版本(tree ID)。 */
  version: string;
  /** 專案是否勾了「允許桌面核實」。 */
  allowDesktop: boolean;
  /** desktop 指令的執行位置(獨立 worktree);沒給就不跑 desktop 指令。 */
  desktopCwd?: string;
  /** 每條指令的完整輸出寫在這裡(<id>.log,只保留最後 64KB);沒給就不寫檔。 */
  logDir?: string;
  /** 中止(停止流程、關閉主控台):終止正在跑的指令的程序樹,其餘指令標成略過。 */
  signal?: AbortSignal;
  /**
   * 隔離用的主控台資料夾(設成 NEXUS_DATA_DIR,被測的 Entropy Nexus 不會碰到真實的 %APPDATA%\entropy-nexus 與記憶庫設定)。
   * 沒給就在系統暫存區建一個,核實結束後刪除。
   */
  dataDir?: string;
  /** 改檔偵測:回傳執行位置目前和版本 tree 不同的檔案。每條指令跑完都會呼叫。 */
  detectChanges?: (cwd: string) => Promise<string[]>;
  /** 找鎖定程序;預設用 lockers.ts。 */
  findLockers?: (output: string) => Promise<LockerInfo[]>;
  env?: Record<string, string>;
  now?: () => number;
}

/**
 * 依序跑完核實指令,回傳整組結果。整組的分類(都是交給使用者的優先):
 * 有被環境擋住 → blocked;否則有逾時 → timeout;否則有指令改到受版本控制的檔案 → modified;否則有失敗 → fail;否則 pass。
 * blocked、timeout、modified 都不算實作者失敗、不計退回輪數;同時有失敗的指令另外列在 failed,畫面要一併顯示。
 */
export async function runVerify(o: VerifyOptions): Promise<VerifyResult> {
  const now = o.now ?? Date.now;
  const startedAt = now();
  const ownData = o.dataDir ? null : mkdtempSync(join(tmpdir(), 'nexus-flow-data-'));
  const env = { ...(o.env ?? verifyEnv()), NEXUS_DATA_DIR: o.dataDir ?? ownData! };
  const codepage = await consoleCodepage();
  const results: VerifyCommandResult[] = [];
  const outcomes = new Map<string, VerifyCommandOutcome>();
  const notVerified: string[] = [];
  const modifiedAll = new Set<string>();
  const seen = new Map<string, Set<string>>();
  if (o.logDir) mkdirSync(o.logDir, { recursive: true });

  try {
    for (const cmd of orderCommands(o.commands)) {
      const location: VerifyLocation = cmd.desktop ? 'worktree' : (o.location ?? 'copy');
      const base: VerifyCommandResult = { id: cmd.id, run: cmd.run, outcome: 'skipped', exitCode: null, ms: 0, lastLine: '', logFile: '', modified: [], location };
      if (o.signal?.aborted) {
        results.push({ ...base, reason: '略過(核實已中止)' });
        outcomes.set(cmd.id, 'skipped');
        continue;
      }
      const badNeed = cmd.needs.find(n => outcomes.get(n) !== 'pass');
      if (badNeed) {
        results.push({ ...base, reason: `略過(前置失敗):${badNeed}` });
        outcomes.set(cmd.id, 'skipped');
        continue;
      }
      let cwd = o.cwd;
      if (cmd.desktop) {
        if (!o.allowDesktop || !o.desktopCwd) {
          results.push({ ...base, reason: o.allowDesktop ? '未跑桌面核實(沒有可用的獨立 worktree)' : '未跑桌面核實(專案沒有勾選「允許桌面核實」)' });
          outcomes.set(cmd.id, 'skipped');
          notVerified.push(`未跑桌面核實:${cmd.id}(${cmd.run})`);
          continue;
        }
        cwd = o.desktopCwd;
      }
      const r = await runOne(cmd.run, cwd, cmd.timeout, env, codepage, o.signal);
      let logFile = '';
      if (o.logDir) {
        logFile = join(o.logDir, `${cmd.id}.log`);
        try { writeFileSync(logFile, `$ ${cmd.run}\n(位置:${cwd})\n\n${r.output}${r.timedOut ? `\n[核實] 逾時 ${cmd.timeout} 秒,已終止\n` : ''}`); } catch { logFile = ''; }
      }
      const result: VerifyCommandResult = { ...base, exitCode: r.exitCode, ms: r.ms, lastLine: lastLineOf(r.output), logFile };
      if (r.aborted) {
        result.outcome = 'skipped';
        result.reason = '略過(核實已中止)';
        notVerified.push(`核實已中止:${cmd.id}`);
      } else if (r.timedOut) {
        result.outcome = 'timeout';
        result.reason = `逾時(${cmd.timeout} 秒),卡在:${result.lastLine || '(沒有輸出)'}`;
      } else {
        const c = classify(r.exitCode, r.output, r.spawnError);
        result.outcome = c.outcome;
        if (c.reason) result.reason = c.reason;
        if (c.envHint) result.envHint = c.envHint;
        // 檔案被鎖的跡象:真的找到鎖住檔案的程序才改判被環境擋住,否則仍是失敗(附上可能的環境原因)
        if (c.outcome === 'fail' && c.lockable) {
          let lockers: LockerInfo[] = [];
          try { lockers = await (o.findLockers ?? defaultLockers)(r.output); } catch { /* 找不到就當沒有 */ }
          if (lockers.length) {
            result.outcome = 'blocked';
            result.lockers = lockers;
            result.reason = `${c.envHint}:${lockers.map(l => `${l.name}(${l.pid})`).join('、')}`;
          }
        }
      }
      if (o.detectChanges) {
        try {
          const now2 = await o.detectChanges(cwd);
          const prev = seen.get(cwd) ?? new Set<string>();
          result.modified = now2.filter(p => !prev.has(p));
          seen.set(cwd, new Set(now2));
          for (const p of now2) modifiedAll.add(p);
        } catch (e) {
          notVerified.push(`無法確認指令 ${cmd.id} 有沒有改到檔案:${(e as Error).message}`);
        }
      }
      outcomes.set(cmd.id, result.outcome);
      results.push(result);
    }
  } finally {
    if (ownData) rmSync(ownData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }

  const ids = (x: VerifyCommandOutcome) => results.filter(r => r.outcome === x).map(r => r.id);
  const blocked = ids('blocked'), timedOut = ids('timeout'), failed = ids('fail');
  const modifiedBy = results.filter(r => r.modified.length).map(r => r.id);
  const outcome: VerifyOutcome = blocked.length ? 'blocked' : timedOut.length ? 'timeout' : modifiedBy.length ? 'modified' : failed.length ? 'fail' : 'pass';
  const stuckAt = outcome === 'blocked' ? blocked[0] : outcome === 'timeout' ? timedOut[0] : undefined;
  return {
    version: o.version, outcome, commands: results, stuckAt, failed, blocked, modifiedBy,
    notVerified, modified: [...modifiedAll].sort(), startedAt, endedAt: now(),
  };
}

function defaultLockers(output: string): Promise<LockerInfo[]> {
  return findLockers(lockedPathsFromOutput(output));
}
