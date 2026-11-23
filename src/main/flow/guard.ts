import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { NEVER_ALLOWED_ACTIONS, type FlowDefinition, type ForbiddenAction, type HighRiskAction } from '../../shared/flow.ts';
import { commandActions, isInstallPath, matchForbidden, protectedHits } from './scope.ts';

/**
 * 範圍合約的攔截判斷(docs/協作流程實作計畫.md §6,里程碑 M3)。純判斷加一點讀檔(資料夾指紋),不碰 Electron。
 * - L1:流程交辦中的節點發出授權請求,命中禁止動作或寫入受保護的資料夾 → 自動拒絕(FlowService 呼叫 scanAction)。
 * - L2:工具啟動事件命中 → 中斷交辦並停機。
 * - L4:事後比對:refs(M2)、被忽略的建置產出(預設 dist/、release/,專案可設定)、流程定義資料夾 flows/ 與主控台設定資料夾頂層檔案的指紋。
 * 指令比對沿用 scope.ts:matchForbidden(引號內當資料,註解與 heredoc 內容不算);install 只看執行的程式與寫入的目的地。
 *
 * 受保護的資料夾(使用者裁示第 3、8 點)只管「寫入」:
 * - 永遠不能寫:流程定義資料夾(<資料夾>/flows/)、主控台設定資料夾(目前用的 userData 與真實的 %APPDATA%\entropy-nexus)。
 *   例外:寫入工具與指令只可以寫這個流程的審查副本。
 * - 記憶庫:real_vault 沒有在這一步授權時不能寫(授權後只開放記憶庫本身,flows/ 與主控台設定仍然不能寫)。
 * - 指令只是「提到」受保護的資料夾(讀取)不擋,只記紀錄(reads);這個流程自己的 runs/<id>/ 連紀錄都不記。
 * 路徑比對前先展開環境變數(%APPDATA%、$env:APPDATA、~)與 Git Bash 的 /c/… 寫法,並正規化 ..。
 */

/** 節點自己不能做的動作:流程定義的 forbidden_actions,加上高風險動作的 install、real_vault 與永遠禁止的動作,扣掉這一步已授權的高風險動作。 */
export function effectiveForbidden(flow: FlowDefinition, approved: readonly HighRiskAction[] = []): ForbiddenAction[] {
  const set = new Set<ForbiddenAction>([...flow.scope.forbiddenActions, 'install', 'real_vault', ...NEVER_ALLOWED_ACTIONS]);
  // 永遠禁止的動作不在 HighRiskAction 裡,授權卡也開放不了
  for (const a of approved) set.delete(a);
  return [...set];
}

/** 展開路徑用的環境變數。 */
export interface GuardEnv { APPDATA?: string; LOCALAPPDATA?: string; USERPROFILE?: string; HOME?: string }

export interface GuardContext {
  /** 要攔截的禁止動作(已扣掉這一步授權的)。 */
  forbidden: ForbiddenAction[];
  /** 永遠不能寫入的資料夾(流程定義、主控台設定資料夾)。 */
  protectedRoots: string[];
  /** 記憶庫(real_vault);forbidden 含 real_vault 時才檢查。 */
  vaultRoots: string[];
  /** 指令文字裡提到也不記紀錄的資料夾(這個流程自己的 runs/<id>/,以及授權後的記憶庫)。 */
  readExempt: string[];
  /** 可以寫的資料夾(審查副本,以及授權後的記憶庫)。 */
  writeExempt: string[];
  /** 相對路徑以這裡為準(節點的工作目錄)。 */
  cwd: string;
  env?: GuardEnv;
}

export interface GuardInput {
  tool: string;
  summary: string;
  detail?: string;
  /** 轉接器另外帶的結構化路徑(Codex 的檔案修改、ACP 的工具參數),有的話優先用它。 */
  paths?: string[];
}

export interface GuardScan {
  /** 命中的禁止動作。 */
  actions: ForbiddenAction[];
  /** 寫入的受保護資料夾。 */
  protected: string[];
  /** 命中的指令或路徑(給違規紀錄與說明用)。 */
  items: string[];
  /** 只是提到(讀取)的受保護資料夾:不擋,只記紀錄。 */
  reads: string[];
}

/** 要擋下的命中(禁止動作或寫入受保護的資料夾);只有 reads 時不擋。 */
export const isBlocking = (s: GuardScan | null): boolean => !!s && (s.actions.length > 0 || s.protected.length > 0);

/** 帶指令的欄位(Claude 的 command、Antigravity 的 CommandLine、Codex 的 cmd 等)。 */
const CMD_KEYS = new Set(['command', 'cmd', 'commandline', 'script', 'shell_command']);
/** 帶寫入路徑的欄位。 */
const PATH_KEYS = new Set(['file_path', 'filepath', 'path', 'notebook_path', 'targetfile', 'target_file', 'absolutepath', 'destination', 'new_path', 'old_path', 'dest', 'target']);
/** 會寫檔的工具(只有這些工具的路徑算寫入;讀檔、搜尋不算)。 */
const WRITE_TOOL = /write|edit|patch|notebook|create|replace|move|rename|delete|remove|apply|save|mkdir|copy/i;
/** 執行指令的工具。 */
const SHELL_TOOL = /^(?:bash|shell|sh|powershell|pwsh|cmd|exec|execute|terminal|local_shell|run_?command|run_?terminal)/i;
/** 主控台自己的 MCP 工具(step_report、ask_node、memory_* 等):參數是回報或對話內容,不是動作。 */
export function isNexusTool(tool: string, summary = ''): boolean {
  return /^mcp__nexus__/i.test(tool) || (/^mcp$/i.test(tool) && /^nexus\//i.test(summary.trim()));
}

/** 明細被截斷(不是完整的 JSON)時,盡力取出字串欄位的值。 */
function looseField(d: string, keys: Set<string>, complete: boolean): string[] {
  const out: string[] = [];
  for (const m of d.matchAll(/"([\w]+)"\s*:\s*"((?:[^"\\]|\\.)*)(")?/g)) {
    if (!keys.has(m[1].toLowerCase()) || (complete && !m[3])) continue;
    try { out.push(JSON.parse(`"${m[2]}"`)); } catch { out.push(m[2].replace(/\\\\/g, '\\')); }
  }
  return out;
}

/**
 * 從工具事件或授權請求拆出「會被執行的指令」與「會被寫入的路徑」。
 * - 主控台自己的 MCP 工具不比對(節點如實回報 commands_run 不算動作)。
 * - 指令欄位(command 之類):執行指令的工具往下找;其他工具只看明細頂層。
 * - 寫入路徑:寫檔工具才算;轉接器帶了結構化路徑(paths)就用它,否則從明細的 file_path 之類欄位取;
 *   純文字明細(Codex 的 Patch)只取第一行(diff 內容不當成路徑),加上授權請求的「要求寫入:<資料夾>」。
 * - 明細被截斷(ACP 只留 4000 字)時,用寬鬆的比對取出欄位值。
 */
export function actionTexts(tool: string, summary: string, detail = '', given?: string[]): { commands: string[]; paths: string[] } {
  if (isNexusTool(tool, summary)) return { commands: [], paths: [] };
  const commands: string[] = [];
  const paths: string[] = [];
  const writer = WRITE_TOOL.test(tool);
  const shell = SHELL_TOOL.test(tool);
  const structured = writer && Array.isArray(given) && given.length > 0;
  if (structured) paths.push(...given!.filter(p => typeof p === 'string' && p));
  const d = String(detail ?? '').trim();
  let obj: unknown;
  if (d.startsWith('{') || d.startsWith('[')) { try { obj = JSON.parse(d); } catch { obj = undefined; } }
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { if (shell) for (const x of v) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (CMD_KEYS.has(key) && (shell || depth === 0)) {
        if (typeof x === 'string') commands.push(x);
        else if (Array.isArray(x) && x.every(y => typeof y === 'string')) commands.push((x as string[]).join(' '));
      } else if (PATH_KEYS.has(key) && typeof x === 'string' && writer && !structured) paths.push(x);
      else if (typeof x === 'object' && (shell || writer)) walk(x, depth + 1);
    }
  };
  if (obj !== undefined) walk(obj, 0);
  else if (d.startsWith('{')) {
    // 截斷的 JSON
    if (shell) commands.push(...looseField(d, CMD_KEYS, false));
    if (writer && !structured) paths.push(...looseField(d, PATH_KEYS, true));
  } else if (d) {
    for (const m of d.matchAll(/^要求寫入:\s*(.+)$/gm)) paths.push(m[1].trim());
    if (shell) commands.push(d.split(/\r?\n/).filter(l => !/^(?:cwd|原因|reason|要求寫入):/i.test(l.trim())).join('\n'));
    else if (writer && !structured) {
      // Codex 的 Patch(沒有結構化路徑時):只信第一行
      const first = d.split(/\r?\n/)[0]?.trim() ?? '';
      if (first && !/^(?:原因|cwd|要求寫入):/.test(first) && first.length < 400) paths.push(first);
    }
  }
  if (!commands.length && !d && shell && summary.trim()) commands.push(summary);
  return { commands, paths };
}

/**
 * 展開路徑的寫法:%APPDATA%、$env:APPDATA、${APPDATA}、$HOME、~、Git Bash 的 /c/…(→ C:/…)。
 * 只展開 env 裡有的變數,其他原樣保留。
 */
export function expandPaths(text: string, env: GuardEnv = {}): string {
  const home = env.USERPROFILE || env.HOME || '';
  const vars: Record<string, string | undefined> = { appdata: env.APPDATA, localappdata: env.LOCALAPPDATA, userprofile: home || undefined, home: home || undefined };
  let out = text.replace(/%(\w+)%|\$env:(\w+)|\$\{env:(\w+)\}|\$\{(\w+)\}|\$(\w+)/gi, (m, a, b, c, d, e) => vars[String(a ?? b ?? c ?? d ?? e).toLowerCase()] ?? m);
  if (home) out = out.replace(/(^|[\s"'=(,;|&])~(?=[\\/]|$|[\s"'])/g, (_m, p) => `${p}${home}`);
  out = out.replace(/(^|[\s"'=(,;|&])\/([a-zA-Z])(?=\/)/g, (_m, p, d) => `${p}${String(d).toUpperCase()}:`);
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 資料夾路徑的比對樣式:斜線方向不拘、不分大小寫,後面不能緊接檔名字元(…\entropy-nexus 不會比到 …\entropy-nexus-dev)。 */
function rootRe(root: string, flags = 'i'): RegExp | null {
  const parts = resolve(root).replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return null;
  return new RegExp(`${parts.map(esc).join('[\\\\/]+')}(?![\\w.-])`, flags);
}

/** 佔位字後面的路徑用 .. 跳出資料夾(runs\r1\..\..\settings.json)時不豁免。 */
function escapesRoot(tail: string): boolean {
  const path = /^[^\s"'`;|&<>]*/.exec(tail)?.[0] ?? '';
  let depth = 0;
  for (const seg of path.split(/[\\/]+/).filter(Boolean)) {
    if (seg === '..') { depth--; if (depth < 0) return true; } else if (seg !== '.') depth++;
  }
  return false;
}

/** 把指令裡提到的豁免資料夾換成佔位字(這個流程自己的 runs/<id>/ 之類);用 .. 跳出資料夾的不換。 */
export function scrubRoots(text: string, roots: string[]): string {
  let out = text;
  for (const r of roots.filter(Boolean)) {
    const re = rootRe(r, 'gi');
    if (re) out = out.replace(re, (m: string, offset: number, all: string) => (escapesRoot(all.slice(offset + m.length)) ? m : '<流程資料>'));
  }
  return out;
}

/** 指令文字提到哪些資料夾(在引號裡也算:路徑常寫在引號裡)。 */
export function mentionedRoots(text: string, roots: string[]): string[] {
  return roots.filter(r => !!r && !!rootRe(r)?.test(text));
}

/** 判斷一個工具事件或授權請求有沒有命中禁止動作、寫入受保護的資料夾或提到它;都沒有回傳 null。 */
export function scanAction(input: GuardInput, ctx: GuardContext): GuardScan | null {
  const env = ctx.env ?? {};
  const { commands, paths } = actionTexts(input.tool ?? '', input.summary ?? '', input.detail ?? '', input.paths);
  const actions = new Set<ForbiddenAction>();
  const prot = new Set<string>();
  const reads = new Set<string>();
  const items: string[] = [];
  const vault = ctx.forbidden.includes('real_vault') ? ctx.vaultRoots.filter(Boolean) : [];
  /** 寫入的路徑:審查副本(與授權後的記憶庫)可以寫;受保護的資料夾、沒授權的記憶庫、安裝位置不行。 */
  const classify = (raw: string): boolean => {
    const p = expandPaths(raw, env);
    const abs = isAbsolute(p) ? resolve(p) : resolve(ctx.cwd || '.', p);
    if (protectedHits([abs], ctx.writeExempt).length) return false;
    let hit = false;
    for (const r of ctx.protectedRoots) if (r && protectedHits([abs], [r]).length) { prot.add(r); hit = true; }
    if (vault.length && protectedHits([abs], vault).length) { actions.add('real_vault'); hit = true; }
    if (ctx.forbidden.includes('install') && (isInstallPath(abs) || isInstallPath(p))) { actions.add('install'); hit = true; }
    return hit;
  };
  for (const raw of commands) {
    const text = expandPaths(raw, env);
    let hit = false;
    for (const a of matchForbidden(text, ctx.forbidden.filter(x => x !== 'real_vault'))) { actions.add(a); hit = true; }
    for (const w of commandActions(text).writes) if (classify(w)) hit = true;
    for (const r of mentionedRoots(scrubRoots(text, ctx.readExempt), [...ctx.protectedRoots, ...vault])) if (!prot.has(r)) reads.add(r);
    if (hit) items.push(raw.replace(/\s+/g, ' ').trim().slice(0, 300));
  }
  for (const p of paths) if (classify(p)) items.push(p);
  if (!actions.size && !prot.size && !reads.size) return null;
  return { actions: [...actions], protected: [...prot], items, reads: [...reads].filter(r => !prot.has(r)) };
}

/** 命中的指令或路徑正規化成比對用的鍵(L1 與 L2 是不是同一個動作)。 */
export const actionKey = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// ---- 事後比對:資料夾指紋 ----

/** 預設的被忽略建置產出資料夾(L4);專案可在 projects.yaml 用 artifact_dirs 改。 */
export const ARTIFACT_DIRS = ['dist', 'release'];

/** newIgnored 的結果裡屬於建置產出資料夾(任何一層)的項目。 */
export function artifactPaths(ignored: string[], dirs: readonly string[] = ARTIFACT_DIRS): string[] {
  const want = dirs.map(d => d.replace(/[\\/]+$/, '').toLowerCase()).filter(Boolean);
  return ignored.filter(p => {
    const s = p.replace(/\\/g, '/');
    const segs = s.split('/');
    // 結尾是 / 的是整包被忽略的資料夾,每一段都是資料夾;否則最後一段是檔名
    const parts = s.endsWith('/') ? segs.filter(Boolean) : segs.slice(0, -1);
    const joined = parts.join('/').toLowerCase();
    return want.some(w => w.includes('/') ? `${joined}/`.startsWith(`${w}/`) || joined.includes(`/${w}/`) || joined === w : parts.some(seg => seg.toLowerCase() === w));
  });
}

/**
 * 資料夾的指紋:相對路徑 → 「大小:修改時間」(資料夾記成 dir:修改時間),最多 depth 層、max 筆。
 * 鍵前面加 prefix(例如 flows/、repo/dist/),之後用 fingerprintDiff 比對。資料夾不存在時回傳空物件。
 */
export function dirFingerprint(dir: string, prefix: string, depth = 4, max = 3000): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  const visit = (abs: string, rel: string, level: number) => {
    if (n >= max) return;
    let names: string[];
    try { names = readdirSync(abs); } catch { return; }
    for (const name of names.sort()) {
      if (n >= max) return;
      const p = join(abs, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      const key = `${prefix}${rel}${name}`;
      n++;
      if (st.isDirectory()) {
        out[`${key}/`] = `dir:${Math.round(st.mtimeMs)}`;
        if (level + 1 < depth) visit(p, `${rel}${name}/`, level + 1);
      } else out[key] = `${st.size}:${Math.round(st.mtimeMs)}`;
    }
  };
  visit(dir, '', 0);
  return out;
}

/** 整個資料夾樹的低成本摘要:檔案數、總大小、最新修改時間(最多 max 筆);深層檔案的新增或修改也看得出來。不存在時回傳空字串。 */
export function treeSummary(dir: string, max = 20000): string {
  let files = 0, size = 0, newest = 0, n = 0;
  const visit = (abs: string) => {
    let names: string[];
    try { names = readdirSync(abs); } catch { return; }
    for (const name of names) {
      if (n++ >= max) return;
      const p = join(abs, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      newest = Math.max(newest, Math.round(st.mtimeMs));
      if (st.isDirectory()) visit(p); else { files++; size += st.size; }
    }
  };
  try { if (!statSync(dir).isDirectory()) return ''; } catch { return ''; }
  visit(dir);
  return `${files}:${size}:${newest}${n > max ? ':+' : ''}`;
}

/** 兩份指紋的差異:新增、刪除、改動的鍵。 */
export function fingerprintDiff(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(k => before[k] !== after[k]).sort();
}

/** 主控台設定資料夾頂層會被節點當成設定動手腳的檔案(副檔名);主控台自己一直在寫的資料庫與程序清單不算。 */
const DATA_FILE = /\.(?:json|ya?ml|md|txt|js|cjs|mjs|ts|ps1|bat|cmd|sh|exe|dll|node|ini|toml)$/i;
const DATA_SKIP = /^(?:children\.json|.*\.tmp.*|.*\.db(?:-wal|-shm|-journal)?)$/i;

export interface GuardFingerprintInput {
  flowsDir: string;
  /** 工作樹(建置產出資料夾相對於這裡)。 */
  repoDirs: string[];
  artifactDirs?: readonly string[];
  /** 主控台設定資料夾(拍頂層檔案)。 */
  dataDir?: string;
}

/**
 * 每一步交辦時記下的指紋:
 * - flows/…:流程定義資料夾(往下 4 層);
 * - data/<檔名>:主控台設定資料夾的頂層檔案(只拍設定、腳本類的副檔名,不含主控台自己一直寫的資料庫);
 * - repo/<產出資料夾>/…:建置產出資料夾往下 2 層的明細,加上整棵樹的摘要(repo/<資料夾>/**),深層的新增或修改也看得出來。
 * 收尾時再拍一次,用 fingerprintDiff 比對。
 */
export function guardFingerprint(i: GuardFingerprintInput): Record<string, string> {
  const out: Record<string, string> = { ...dirFingerprint(i.flowsDir, 'flows/', 4) };
  if (i.dataDir) {
    let names: string[] = [];
    try { names = readdirSync(i.dataDir); } catch { names = []; }
    for (const name of names) {
      if (!DATA_FILE.test(name) || DATA_SKIP.test(name)) continue;
      try { const st = statSync(join(i.dataDir, name)); if (st.isFile()) out[`data/${name}`] = `${st.size}:${Math.round(st.mtimeMs)}`; } catch { /* 讀不到就略過 */ }
    }
  }
  const seen = new Set<string>();
  for (const root of i.repoDirs.filter(Boolean)) {
    const k = resolve(root).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const tag = seen.size === 1 ? 'repo' : `repo${seen.size}`;
    for (const d of i.artifactDirs ?? ARTIFACT_DIRS) {
      const rel = d.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!rel || rel.split('/').includes('..')) continue;
      Object.assign(out, dirFingerprint(join(root, rel), `${tag}/${rel}/`, 2, 1500));
      const sum = treeSummary(join(root, rel));
      if (sum) out[`${tag}/${rel}/**`] = sum;
    }
  }
  return out;
}

/** 把指紋差異分成流程定義資料夾被寫入(flows/…)、主控台設定資料夾頂層檔案被寫入(userData/…)與建置產出被改動。 */
export function splitGuardDiff(diff: string[]): { flows: string[]; data: string[]; artifacts: string[] } {
  const artifacts = diff.filter(k => /^repo\d*\//.test(k)).map(k => k.replace(/^repo\d*\//, ''));
  // 只有摘要變了(深層檔案)才列摘要那一筆;明細有變就列明細
  const detail = artifacts.filter(k => !k.endsWith('/**'));
  const deep = artifacts.filter(k => k.endsWith('/**') && !detail.some(x => x.startsWith(k.slice(0, -2)))).map(k => `${k.slice(0, -2)}(深層檔案)`);
  return {
    flows: diff.filter(k => k.startsWith('flows/')),
    data: diff.filter(k => k.startsWith('data/')).map(k => `userData/${k.slice(5)}`),
    artifacts: [...detail, ...deep],
  };
}
