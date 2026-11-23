import { isAbsolute, join, resolve } from 'node:path';
import type { ForbiddenAction, ScopeException } from '../../shared/flow.ts';
import { compileRules } from '../worktree.ts';

/**
 * 範圍合約(docs/協作流程實作計畫.md §6)。
 * - allowed_paths:用 gitignore 風格的樣式比對 changedPaths 的結果;改到範圍外只標示、不擋,交給審查者與使用者判斷。
 * - forbidden_actions:比對指令文字(CLI 詢問授權的摘要、工具啟動事件),命中就擋下或中斷。
 *   引號裡的字串是資料不是指令(例如 rg "git push" src),不比對;但 bash -c "…"、cmd /c "…"、powershell -Command "…"
 *   這種交給 shell 執行的引號內容,以及 $(…)、反引號裡的指令替換,仍會比對。
 * - 受保護的資料夾:真實的 userData(%APPDATA%\entropy-nexus)、設定中的記憶庫、流程定義資料夾,節點不能寫入(protectedHits)。
 */

const WIN = process.platform === 'win32';
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/** 改到範圍外的檔案。allowed 為空表示不限制(回傳 [])。Windows 上不分大小寫。 */
export function outOfScope(paths: string[], allowed: string[], caseInsensitive = WIN): string[] {
  if (!allowed.length) return [];
  const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const match = compileRules(fold(allowed.join('\n')));
  return paths.filter(p => !match(fold(norm(p)), false));
}

/** 範圍外、卻沒有在 step_report 的 scope_exceptions 寫原因的檔案。 */
export function unexplained(outside: string[], exceptions: ScopeException[], caseInsensitive = WIN): string[] {
  const fold = (s: string) => (caseInsensitive ? norm(s).toLowerCase() : norm(s));
  const told = new Set(exceptions.filter(e => e.reason.trim()).map(e => fold(e.path)));
  return outside.filter(p => !told.has(fold(p)));
}

// ---- 受保護的資料夾 ----

/** 真實的主控台資料夾(userData):%APPDATA%\entropy-nexus;取不到 APPDATA 時回傳空字串。 */
export function realUserDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.APPDATA ? join(env.APPDATA, 'entropy-nexus') : '';
}

const foldPath = (p: string) => { const s = resolve(p).replace(/\\/g, '/').replace(/\/+$/, ''); return WIN ? s.toLowerCase() : s; };

/**
 * 落在受保護資料夾(或就是它本身)裡的路徑。paths 可以是 repo 相對路徑(配 base)或絕對路徑。
 * 用途:real_vault(真實 userData、設定中的記憶庫路徑)、流程定義與主控台設定資料夾(節點的寫入範圍不得包含)。
 */
export function protectedHits(paths: string[], roots: string[], base = ''): string[] {
  const rs = roots.filter(Boolean).map(foldPath);
  return paths.filter(p => {
    const abs = foldPath(isAbsolute(p) || !base ? p : join(base, p));
    return rs.some(r => abs === r || abs.startsWith(`${r}/`));
  });
}

// ---- 禁止動作的指令比對 ----

/** git 子指令前面可能出現的全域選項:-C <路徑>、-c <設定>、--git-dir <路徑>、--work-tree=<路徑> 之類;路徑可能帶引號。 */
const VAL = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|"']+)`;
const GIT_OPTS = String.raw`(?:\s+(?:-[Cc]\s*${VAL}|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env|attr-source)(?:=|\s+)${VAL}|--[\w-]+(?:=${VAL})?|-[a-zA-Z]))*`;
/** 指令開頭,或接在 ; & | ( { 反引號 換行 之後;git 也可能寫成 git.exe 或完整路徑,前面也可能有 VAR=x 這種環境變數設定。 */
const GIT = String.raw`(?:^|[;&|({\s\x60])(?:[\w.:\\/-]*[\\/])?git(?:\.exe)?`;
/** 同一個指令的其餘參數(到 ; & | 換行 為止)。 */
const ARGS = String.raw`[^;&|\n]*?`;
const gitSub = (sub: string, tail = '') => new RegExp(`${GIT}${GIT_OPTS}\\s+${sub}(?![\\w-])${tail}`, 'i');
/** npm、pnpm、yarn、bun 與它們的全域選項(--prefix x、--silent、-w 之類)。 */
const RUNNER = String.raw`\b(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?(?:\s+-{1,2}[\w-]+(?:[= ](?!run\b)[^\s;&|]+)?)*?`;
/** 執行 shell 的寫法:後面接的引號內容是指令,要比對。 */
const SHELL_EXEC = /(?:\b(?:bash|sh|zsh|dash|pwsh|powershell)(?:\.exe)?(?:\s+-\w+)*\s+-(?:c|Command)|\bcmd(?:\.exe)?(?:\s+\/\w)*\s+\/[ck]|\beval|\bInvoke-Expression|\biex)\s*$/i;

/**
 * 各禁止動作的指令樣式。
 * - install(安裝或覆蓋,使用者裁示第 3 點):執行 *Setup*.exe、.msi、msiexec,或寫到 Program Files、%LOCALAPPDATA%\Programs。
 * - real_vault:指令裡出現真實 userData 或記憶庫路徑(記憶庫路徑是設定值,由呼叫端用 protectedPaths 傳入)。
 * - merge_pr、approve_pr、force_push、delete_branch 永遠禁止(使用者裁示第 7 點)。
 */
export const FORBIDDEN_PATTERNS: Record<ForbiddenAction, RegExp[]> = {
  // commit(?![\w-]) 不會誤判 git commit-tree
  commit: [gitSub('commit')],
  push: [gitSub('push')],
  force_push: [gitSub('push', String.raw`${ARGS}\s(?:--force(?:-with-lease|-if-includes)?(?:=[^\s;&|]*)?|-[a-zA-Z]*f[a-zA-Z]*|\+[^\s;&|]+)(?=[\s;&|)}\x60]|$)`)],
  delete_branch: [
    gitSub('push', String.raw`${ARGS}\s(?:--delete|-d|:[^\s;&|]+)(?=[\s;&|)}\x60]|$)`),
    gitSub('branch', String.raw`${ARGS}\s(?:--delete|-[a-zA-Z]*[dD][a-zA-Z]*)(?=[\s;&|)}\x60]|$)`),
  ],
  dist: [
    new RegExp(String.raw`${RUNNER}\s+run(?:-script)?(?:\s+-{1,2}[\w-]+)*\s+dist(?![\w.:-])`, 'i'),
    new RegExp(String.raw`\b(?:pnpm|yarn|bun)(?:\.cmd|\.exe)?(?:\s+-{1,2}[\w-]+(?:[= ](?!dist\b)[^\s;&|]+)?)*?\s+dist(?![\w.:-])`, 'i'),
    /\belectron-builder\b/i,
  ],
  merge_pr: [
    /\bgh(?:\.exe)?\s+pr\s+merge\b/i,
    /\bgh(?:\.exe)?\s+api\b[^;&|\n]*\/pulls\/\d+\/merge\b/i,
  ],
  approve_pr: [
    /\bgh(?:\.exe)?\s+pr\s+review\b[^;&|\n]*\s(?:--approve|-a)(?=[\s;&|)}]|$)/i,
    /\bgh(?:\.exe)?\s+api\b[^;&|\n]*\/reviews\b[^;&|\n]*\bAPPROVE\b/i,
  ],
  // install 不用樣式比對(只「提到」Program Files、Setup.exe 不算):見 matchInstall,只看執行的程式與寫入的目的地
  install: [],
  real_vault: [
    // 結尾要是路徑分隔、引號、空白或字串結尾:entropy-nexus-dev 之類的相鄰名稱不算
    /(?:%APPDATA%|\$env:APPDATA|\$\{?APPDATA\}?|AppData[\\/]Roaming)[\\/]entropy-nexus(?=[\\/"'\s;&|)]|$)/i,
  ],
};

// ---- 去掉不會被執行的部分 ----

/** 執行 shell 的程式(後面接 -c、-Command、/c 的引數是指令)。 */
const SHELL_NAMES = /^(?:bash|sh|zsh|dash|pwsh|powershell|cmd)$/i;
/** 程式名稱:去掉路徑、副檔名(.exe、.cmd、.bat),小寫。 */
export const exeName = (w: string): string => (w.split(/[\\/]/).pop() ?? '').replace(/\.(?:exe|cmd|bat|com)$/i, '').toLowerCase();

/** 去掉一行裡 # 開頭的註解(引號外、詞首的 #)。 */
function stripComment(line: string): string {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '#' && (i === 0 || /[\s;&|(]/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * 去掉不會被執行的部分:# 開頭的註解;heredoc 的內容(cat > x <<EOF … EOF 的內容是資料)。
 * 例外:heredoc 餵給 shell(bash <<EOF、pwsh <<EOF)時內容就是指令,保留。
 */
export function stripNonCode(command: string): string {
  const lines = command.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    out.push(line);
    const m = /(?<!<)<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(line);
    if (!m) continue;
    const before = line.slice(0, m.index).split(/[;&|]/).pop() ?? '';
    const first = before.trim().split(/\s+/).find(w => !/^\w+=/.test(w)) ?? '';
    if (SHELL_NAMES.test(exeName(first.replace(/^["']|["']$/g, '')))) continue;
    const delim = m[3];
    let j = i + 1;
    while (j < lines.length && (m[1] ? lines[j].replace(/^\t+/, '') : lines[j]).trim() !== delim) j++;
    i = j; // 跳過內容與結尾那一行
  }
  return out.join('\n');
}

/** 引號裡的程式路徑(例如 "C:\Program Files\PowerShell\7\pwsh.exe")在指令開頭時是要執行的程式,不是資料。 */
const QUOTED_EXE = /^(?:[A-Za-z]:)?[^"']*[\\/][^\\/"']+\.(?:exe|cmd|bat)$/i;

/**
 * 拆出「真正會被執行的指令文字」:引號外的部分(引號內容換成空白),加上交給 shell 執行的引號內容、
 * 雙引號裡的 $(…) 與反引號指令替換(遞迴處理)。註解與 heredoc 的內容先去掉。
 * 指令開頭的引號程式路徑換成程式名稱("C:\…\pwsh.exe" -Command "git push" 的內容照樣比對)。
 */
export function commandSegments(command: string, depth = 0): string[] {
  const text = stripNonCode(command).replace(/\r?\n/g, ' ; ');
  let outside = '';
  const inner: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '"' && ch !== "'") { outside += ch; i++; continue; }
    const end = text.indexOf(ch, i + 1);
    if (end < 0) { outside += text.slice(i); break; }
    const body = text.slice(i + 1, end);
    if (QUOTED_EXE.test(body) && /(?:^|[;&|({]\s*|^\s*)$/.test(outside.replace(/&\s*$/, ''))) {
      outside += ` ${exeName(body)} `;
      i = end + 1;
      continue;
    }
    if (SHELL_EXEC.test(outside)) inner.push(body);
    else if (ch === '"') {
      // 雙引號裡的指令替換仍會執行
      for (const m of body.matchAll(/\$\(([^)]*)\)|\x60([^\x60]*)\x60/g)) inner.push(m[1] ?? m[2]);
    }
    outside += `${ch}${' '.repeat(body.length)}${ch}`;
    i = end + 1;
  }
  const out = [outside];
  if (depth < 3) for (const s of inner) out.push(...commandSegments(s, depth + 1));
  return out;
}

// ---- 指令的結構:執行的程式與寫入的目的地 ----

export interface SimpleCommand {
  /** 詞(引號已去掉)。 */
  words: string[];
  /** 輸出轉向(> 、>>)的目的地。 */
  redirects: string[];
}

/** 把指令切成簡單指令(; & | 換行 分隔),詞照引號切開;> 、>> 的下一個詞是寫入的目的地,< 的下一個詞丟掉。 */
export function simpleCommands(command: string, depth = 0): SimpleCommand[] {
  const s = stripNonCode(command);
  const out: SimpleCommand[] = [];
  let words: string[] = [], redirects: string[] = [], cur = '', has = false, quote = '', next: '' | 'out' | 'in' = '';
  const endWord = () => {
    if (has) { if (next === 'out') redirects.push(cur); else if (next !== 'in') words.push(cur); next = ''; }
    cur = ''; has = false;
  };
  const endCmd = () => { endWord(); if (words.length || redirects.length) out.push({ words, redirects }); words = []; redirects = []; next = ''; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = ''; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '>') {
      // 2>、1>、*> 的數字不是詞;>&1 是轉到另一個輸出,不是檔案
      if (has && /^[12*]$/.test(cur)) { cur = ''; has = false; } else endWord();
      if (s[i + 1] === '>') i++;
      if (s[i + 1] === '&') { i++; while (/[\d-]/.test(s[i + 1] ?? '')) i++; continue; }
      next = 'out';
      continue;
    }
    if (ch === '<') { endWord(); next = 'in'; continue; }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') { endCmd(); continue; }
    if (/\s/.test(ch)) { endWord(); continue; }
    cur += ch; has = true;
  }
  endCmd();
  // 交給 shell 執行的引數(bash -c "…"、pwsh -Command …、cmd /c …)也是指令
  const more: SimpleCommand[] = [];
  if (depth < 3) {
    for (const c of out) {
      const { exe, args } = commandWord(c.words);
      if (!SHELL_NAMES.test(exeName(exe))) continue;
      const k = args.findIndex(a => /^(?:-c|-command|\/c|\/k)$/i.test(a));
      if (k >= 0 && k + 1 < args.length) more.push(...simpleCommands(exeName(exe) === 'cmd' || /^-command$/i.test(args[k]) ? args.slice(k + 1).join(' ') : args[k + 1], depth + 1));
    }
  }
  return [...out, ...more];
}

/** 指令開頭不是程式本身的詞:環境變數設定、sudo、nohup、time、env 等。 */
const PREFIX = new Set(['sudo', 'nohup', 'time', 'exec', 'call', 'command', 'builtin', 'env', 'nice']);

/** 簡單指令裡要執行的程式與它的引數(跳過 VAR=x、sudo 之類的前綴,以及開頭的 ( { )。 */
export function commandWord(words: string[]): { exe: string; args: string[] } {
  let i = 0;
  const ws = words.map((w, k) => (k === 0 ? w.replace(/^[({]+/, '') : w));
  while (i < ws.length && (!ws[i] || /^\w+=/.test(ws[i]) || PREFIX.has(ws[i].toLowerCase()))) i++;
  return { exe: ws[i] ?? '', args: ws.slice(i + 1) };
}

/** 複製、搬移類:最後一個位置參數(或 -Destination)是寫入的目的地。 */
const COPY_LIKE = new Set(['cp', 'copy', 'xcopy', 'move', 'mv', 'copy-item', 'cpi', 'move-item', 'mi', 'ln', 'install', 'rsync', 'scp']);
/** 寫入、建立、刪除類:每個位置參數(與 -Path、-LiteralPath、-FilePath)都是寫入的目的地。 */
const WRITERS = new Set(['tee', 'tee-object', 'set-content', 'add-content', 'ac', 'out-file', 'new-item', 'ni', 'mkdir', 'md', 'touch', 'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'truncate', 'clear-content', 'clc', 'rename-item', 'rni', 'ren', 'rename', 'new-itemproperty']);
/** cmd 風格的指令:/s、/y 是選項,不是路徑。 */
const CMD_STYLE = new Set(['copy', 'xcopy', 'robocopy', 'move', 'del', 'erase', 'rd', 'rmdir', 'ren', 'rename', 'md']);
/** PowerShell 帶值的參數(值不是位置參數)。 */
const PS_VALUE = new Set(['path', 'literalpath', 'destination', 'filepath', 'value', 'itemtype', 'name', 'encoding', 'filter', 'include', 'exclude', 'newname', 'inputobject', 'argumentlist', 'workingdirectory', 'verb', 'credential', 'type']);

export interface CommandActions {
  /** 要執行的程式(含 Start-Process、start 的目標)。 */
  execs: string[];
  /** 寫入、建立或刪除的路徑(輸出轉向、複製目的地、寫檔與刪除指令的參數)。 */
  writes: string[];
}

/** 指令會執行哪些程式、寫入哪些路徑(盡力而為的靜態判斷;腳本內部的寫入看不到)。 */
export function commandActions(command: string): CommandActions {
  const execs: string[] = [];
  const writes: string[] = [];
  for (const c of simpleCommands(command)) {
    writes.push(...c.redirects);
    const { exe, args } = commandWord(c.words);
    if (!exe) continue;
    const name = exeName(exe);
    const ps = name.includes('-') || ['cpi', 'mi', 'ni', 'ri', 'ac', 'clc', 'rni', 'saps'].includes(name);
    const named: Record<string, string> = {};
    const pos: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      const m = /^-{1,2}([\w-]+)(?::(.*))?$/.exec(a);
      if (m && a.length > 1) {
        const key = m[1].toLowerCase();
        if (m[2] !== undefined) named[key] = m[2];
        else if (ps && PS_VALUE.has(key) && k + 1 < args.length) named[key] = args[++k];
        continue;
      }
      if (CMD_STYLE.has(name) && /^\/[A-Za-z?][\w:?-]{0,8}$/.test(a)) continue;
      pos.push(a);
    }
    if (name === 'start-process' || name === 'saps' || name === 'start') {
      const target = named.filepath ?? pos.find(p => p !== '') ?? '';
      if (target) execs.push(target);
      continue;
    }
    execs.push(exe);
    if (COPY_LIKE.has(name)) {
      const dest = named.destination ?? (pos.length >= 2 ? pos[pos.length - 1] : undefined);
      if (dest) writes.push(dest);
    } else if (name === 'robocopy') {
      if (pos[1]) writes.push(pos[1]);
    } else if (WRITERS.has(name)) {
      writes.push(...pos, ...['path', 'literalpath', 'filepath'].map(k => named[k]).filter((x): x is string => !!x));
    } else if (name === 'sed' && args.some(a => /^-i/.test(a) || a === '--in-place')) {
      writes.push(...pos.slice(1));
    } else if (name === 'dd') {
      for (const a of args) if (/^of=/.test(a)) writes.push(a.slice(3));
    }
  }
  return { execs, writes: writes.filter(Boolean) };
}

/** 安裝檔:*Setup*.exe、.msi(副檔名後面不能再接東西,例如 foo.msi.json 不算)、msiexec。 */
export function isInstallerExe(word: string): boolean {
  const base = word.split(/[\\/]/).pop() ?? '';
  return /setup[^\\/]*\.exe$/i.test(base) || /\.msi$/i.test(base) || /^msiexec(?:\.exe)?$/i.test(base);
}

/** 安裝位置:Program Files(含 x86)、%LOCALAPPDATA%\Programs(各種環境變數寫法)。 */
export function isInstallPath(p: string): boolean {
  return /(?:^|[\\/])Program Files(?: \(x86\))?(?:[\\/]|$)/i.test(p)
    || /(?:%LOCALAPPDATA%|\$env:LOCALAPPDATA|\$\{?LOCALAPPDATA\}?|AppData[\\/]Local)[\\/]Programs(?:[\\/]|$)/i.test(p);
}

/**
 * install(安裝或覆蓋,使用者裁示第 3 點):只有「執行」安裝檔(指令的執行位置是 *Setup*.exe、.msi、msiexec,或 Start-Process 的目標),
 * 以及「寫入」Program Files、%LOCALAPPDATA%\Programs(輸出轉向、複製目的地、寫檔與刪除指令的參數)才算。
 * 只是提到(ls "C:\Program Files\nodejs"、rg "Program Files" src、從 Program Files 執行 pwsh)不算。
 */
export function matchInstall(command: string): boolean {
  const { execs, writes } = commandActions(command);
  return execs.some(isInstallerExe) || writes.some(isInstallPath);
}

/**
 * 指令文字命中哪些禁止動作(只檢查 forbidden 裡列的)。
 * protectedPaths:real_vault 用的額外路徑(設定中的記憶庫資料夾等),指令裡出現就算命中。
 * 注意:受保護路徑可能寫在引號裡(例如 "C:\Users\x\vault"),所以 real_vault 的路徑比對看整段文字(去掉註解與 heredoc 的內容)。
 */
export function matchForbidden(command: string, forbidden: readonly ForbiddenAction[], opts: { protectedPaths?: string[] } = {}): ForbiddenAction[] {
  const segs = commandSegments(command);
  const code = stripNonCode(command);
  const raw = code.replace(/\r?\n/g, ' ; ');
  const whole = code.replace(/\\/g, '/').toLowerCase();
  return forbidden.filter(a => {
    if (a === 'install') return matchInstall(command);
    // real_vault 是看路徑:路徑常寫在引號裡,所以比對整段文字(寧可多擋)
    const texts = a === 'real_vault' ? [raw] : segs;
    if ((FORBIDDEN_PATTERNS[a] ?? []).some(re => texts.some(s => re.test(s)))) return true;
    if (a === 'real_vault' && opts.protectedPaths?.length) {
      return opts.protectedPaths.filter(Boolean).some(p => {
        const root = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        let at = whole.indexOf(root);
        while (at >= 0) {
          if (!/[\w.-]/.test(whole[at + root.length] ?? '')) return true;
          at = whole.indexOf(root, at + 1);
        }
        return false;
      });
    }
    return false;
  });
}
