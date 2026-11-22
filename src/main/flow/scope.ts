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
  install: [
    /(?:^|[\s"'\\/&;|(])[\w .()-]*setup[\w .()-]*\.exe\b/i,
    /\.msi\b/i,
    /\bmsiexec\b/i,
    /Program Files/i,
    /(?:%LOCALAPPDATA%|\$env:LOCALAPPDATA|AppData[\\/]Local)[\\/]Programs\b/i,
  ],
  real_vault: [
    /(?:%APPDATA%|\$env:APPDATA|AppData[\\/]Roaming)[\\/]entropy-nexus\b/i,
  ],
};

const PATH_BASED = new Set<ForbiddenAction>(['install', 'real_vault']);

/**
 * 拆出「真正會被執行的指令文字」:引號外的部分(引號內容換成空白),加上交給 shell 執行的引號內容、
 * 雙引號裡的 $(…) 與反引號指令替換(遞迴處理)。
 */
export function commandSegments(command: string, depth = 0): string[] {
  const text = command.replace(/\r?\n/g, ' ; ');
  let outside = '';
  const inner: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '"' && ch !== "'") { outside += ch; i++; continue; }
    const end = text.indexOf(ch, i + 1);
    if (end < 0) { outside += text.slice(i); break; }
    const body = text.slice(i + 1, end);
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

/**
 * 指令文字命中哪些禁止動作(只檢查 forbidden 裡列的)。
 * protectedPaths:real_vault 用的額外路徑(設定中的記憶庫資料夾等),指令裡出現就算命中。
 * 注意:受保護路徑可能寫在引號裡(例如 "C:\Users\x\vault"),所以路徑比對看整段原始文字。
 */
export function matchForbidden(command: string, forbidden: readonly ForbiddenAction[], opts: { protectedPaths?: string[] } = {}): ForbiddenAction[] {
  const segs = commandSegments(command);
  const raw = command.replace(/\r?\n/g, ' ; ');
  const whole = command.replace(/\\/g, '/').toLowerCase();
  return forbidden.filter(a => {
    // install、real_vault 是看路徑:路徑常寫在引號裡,所以比對整段原始文字(寧可多擋)
    const texts = PATH_BASED.has(a) ? [raw] : segs;
    if ((FORBIDDEN_PATTERNS[a] ?? []).some(re => texts.some(s => re.test(s)))) return true;
    if (a === 'real_vault' && opts.protectedPaths?.length) {
      return opts.protectedPaths.filter(Boolean).some(p => whole.includes(p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()));
    }
    return false;
  });
}
