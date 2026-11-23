import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { changedPaths, snapshotTree } from '../changes.ts';
import { linkNodeModules } from '../worktree.ts';

/**
 * 協作流程的版本與副本(docs/協作流程實作計畫.md §5.1)。
 * - 版本:沿用 changes.ts 的 snapshotTree(獨立暫存索引、add -A、write-tree),tree ID 就是版本;涵蓋未被忽略的新檔與刪除。
 * - 副本:從版本 tree 匯出,不含 .git,審查者碰不到正本與 refs;被寫入時用 --git-dir/--work-tree 配暫存索引重拍一次比對。
 *   tree 一律是整個版本庫的結構(snapshotTree 從子資料夾拍,也只是只收那個子資料夾的檔案,路徑仍從 repo 根目錄算起),
 *   所以副本的根目錄對應 repo 根目錄;從子資料夾開始的工作,在副本裡要進到同一個相對路徑。
 * - 清理:副本與桌面核實的 worktree 裡的 node_modules 是指回原版本庫的 junction,一定要先確認刪除對象、解除連結、確認沒有殘留,
 *   才刪資料夾,否則可能順著連結把真正的 node_modules 刪掉。
 * 這裡只用到使用者已安裝的 git,不動使用者的暫存區、分支與 refs(桌面核實的 worktree 例外:會多一筆 worktree 紀錄,清理時移除)。
 */

/** 只用在副本與桌面核實 worktree 的 git 參數:不做換行轉換、允許長路徑。 */
const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.longpaths=true'];

function git(cwd: string, args: string[], env?: Record<string, string>, timeout = 120000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise(res => {
    execFile('git', [...BASE_ARGS, ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout },
      (err, stdout, stderr) => res({ ok: !err, out: String(stdout), err: String(stderr) }));
  });
}

const failText = (r: { err: string; out: string }) => (r.err || r.out).trim().split('\n').slice(-2).join(' ').slice(0, 300);

/** 用一份全新的暫存索引執行 fn,結束就刪掉(不碰使用者自己的 .git/index)。 */
async function withTempIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-flow-idx-'));
  try { return await fn({ GIT_INDEX_FILE: join(dir, 'index') }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 拍下工作目錄目前的內容,回傳 tree ID(版本);不是 git 版本庫或失敗時回傳 null。 */
export const snapshot = snapshotTree;

/** 版本庫的 git 資料夾(絕對路徑;worktree 會是 .git/worktrees/<名稱>,物件庫與主版本庫共用)。 */
async function gitDir(repo: string): Promise<string> {
  const r = await git(repo, ['rev-parse', '--absolute-git-dir']);
  if (!r.ok) throw new Error(`找不到 git 版本庫:${failText(r)}`);
  return r.out.trim();
}

/** 副本標記檔的副檔名(放在副本旁邊);removeCopy 只刪有標記檔的副本。 */
export const COPY_MARKER_SUFFIX = '.nexus-copy.json';

/**
 * 把版本 tree 匯出成資料夾(不含 .git)。dest 必須還不存在或是空資料夾。
 * 用暫存索引 read-tree 後 checkout-index,不經過工作區也不動 refs;換行不轉換(core.autocrlf=false)。
 * 匯出前先在旁邊寫標記檔(<dest>.nexus-copy.json),removeCopy 刪除前會確認它存在。
 */
export async function exportTree(repo: string, tree: string, dest: string): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`版本格式不對:${tree}`);
  if (existsSync(dest) && readdirSync(dest).length) throw new Error(`副本資料夾已存在而且不是空的:${dest}`);
  mkdirSync(dest, { recursive: true });
  writeFileSync(`${resolve(dest)}${COPY_MARKER_SUFFIX}`, JSON.stringify({ tree, repo: resolve(repo), createdAt: Date.now() }));
  const prefix = resolve(dest).replace(/\\/g, '/').replace(/\/?$/, '/');
  await withTempIndex(async env => {
    const rt = await git(repo, ['read-tree', tree], env);
    if (!rt.ok) throw new Error(`讀取版本失敗:${failText(rt)}`);
    const co = await git(repo, ['checkout-index', '-a', '-f', `--prefix=${prefix}`], env, 600000);
    if (!co.ok) throw new Error(`匯出副本失敗:${failText(co)}`);
  });
}

/**
 * 拍下副本目前的內容(tree ID),用來偵測副本有沒有被寫入。
 * 用正本的 git 資料夾配副本當工作區、獨立暫存索引,不碰 refs,也不靠 git status(副本沒有 .git)。
 * exclude 是要略過的相對路徑(例如連結進來的 node_modules:junction 不吃「node_modules/」這種只比對資料夾的忽略規則)。
 */
export async function snapshotCopy(repo: string, copy: string, exclude: string[] = []): Promise<string | null> {
  const dir = await gitDir(repo);
  return withTempIndex(async env => {
    // 用額外的忽略檔排除(不用 :(exclude) pathspec:路徑若已被 .gitignore 忽略,git add 會因為「指名了被忽略的路徑」而失敗)。
    // 規則不加結尾的 /,連結(git 視為檔案)才比對得到。
    const extra: string[] = [];
    if (exclude.length) {
      const file = join(dirname(env.GIT_INDEX_FILE), 'exclude');
      // core.excludesFile 會取代使用者的全域忽略檔,所以先把它的內容接上
      writeFileSync(file, await effectiveExcludes(repo) + '\n' + exclude.map(p => `/${p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/([*?[\]\\!#])/g, '\\$1')}`).join('\n') + '\n');
      extra.push('-c', `core.excludesFile=${file.replace(/\\/g, '/')}`);
    }
    const add = await git(copy, [...extra, `--git-dir=${dir}`, `--work-tree=${resolve(copy)}`, 'add', '-A', '--', '.'], env, 600000);
    if (!add.ok) return null;
    const w = await git(copy, [`--git-dir=${dir}`, `--work-tree=${resolve(copy)}`, 'write-tree'], env);
    const t = w.out.trim();
    return w.ok && /^[0-9a-f]{40,64}$/.test(t) ? t : null;
  });
}

/** 實際生效的忽略檔(core.excludesFile,依 system → global → repo 設定;沒設定時是 XDG 的 git/ignore)的內容;讀不到就是空字串。 */
async function effectiveExcludes(repo: string): Promise<string> {
  const r = await git(repo, ['config', '--path', 'core.excludesFile']);
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const file = r.ok && r.out.trim() ? r.out.trim() : join(xdg, 'git', 'ignore');
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 副本和版本 tree 不同的檔案(副本被寫入時非空)。拍不到副本的快照時丟出錯誤。 */
export async function copyChanges(repo: string, copy: string, version: string, exclude: string[] = []): Promise<string[]> {
  const now = await snapshotCopy(repo, copy, exclude);
  if (!now) throw new Error(`無法拍下副本的快照:${copy}`);
  if (now === version) return [];
  return (await changedPaths(repo, version, now)).map(f => f.path);
}

/** 被 .gitignore 略過的檔案與資料夾(整包被忽略的資料夾只列一筆,結尾帶 /)。 */
export async function ignoredList(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  if (!r.ok) throw new Error(`列出被忽略的檔案失敗:${failText(r)}`);
  return r.out.split('\0').filter(Boolean).sort();
}

/** 這次比 base 多出來的被忽略產出(差集)。 */
export function newIgnored(base: string[], now: string[]): string[] {
  const had = new Set(base);
  return now.filter(p => !had.has(p));
}

export interface RefsState {
  /** HEAD 指向的分支(refs/heads/…);detached 時為空字串。 */
  symbolic: string;
  /** HEAD 的提交;還沒有提交時為空字串。 */
  head: string;
  /** 所有 refs(refs/heads、refs/remotes、refs/tags、refs/stash…)→ 物件雜湊。 */
  refs: Record<string, string>;
}

/**
 * 記下 HEAD 與所有 refs(含遠端追蹤分支與標籤)。每一步前後各記一次,
 * 用 diffRefs 比對就知道節點有沒有自己 commit(HEAD 或 refs/heads 變了)或 push(refs/remotes 變了)。
 */
export async function refsState(cwd: string): Promise<RefsState> {
  const [refs, head, sym] = await Promise.all([
    git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']),
    git(cwd, ['rev-parse', '-q', '--verify', 'HEAD']),
    git(cwd, ['symbolic-ref', '-q', 'HEAD']),
  ]);
  if (!refs.ok) throw new Error(`讀取 refs 失敗:${failText(refs)}`);
  const map: Record<string, string> = {};
  for (const line of refs.out.split(/\r?\n/)) {
    const i = line.lastIndexOf(' ');
    if (i > 0) map[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return { symbolic: sym.out.trim(), head: head.out.trim(), refs: map };
}

/** 兩次 refsState 之間變動的 refs(新增、刪除、指向改變);HEAD 變了會列成 "HEAD"。 */
export function diffRefs(a: RefsState, b: RefsState): string[] {
  const out: string[] = [];
  if (a.head !== b.head || a.symbolic !== b.symbolic) out.push('HEAD');
  for (const k of new Set([...Object.keys(a.refs), ...Object.keys(b.refs)])) if (a.refs[k] !== b.refs[k]) out.push(k);
  return out.sort();
}

/** refs 指紋:refsState 的雜湊,前後不同表示有人 commit、切分支、建標籤或 push/fetch 更新了遠端追蹤分支。 */
export async function refsFingerprint(cwd: string): Promise<string> {
  const s = await refsState(cwd);
  const text = `HEAD ${s.symbolic || '(detached)'} ${s.head}\n${Object.entries(s.refs).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${k} ${v}`).join('\n')}`;
  return createHash('sha256').update(text).digest('hex');
}

/** 把原版本庫的 node_modules 連結進副本或 worktree(Windows 用 junction)。回傳建立的連結(相對路徑)。 */
export function linkDeps(repoRoot: string, dir: string): { linked: string[]; failed: string[] } {
  return linkNodeModules(repoRoot, dir);
}


const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const WIN = process.platform === 'win32';
/**
 * 實際路徑:展開 Windows 的 8.3 短名稱(例如 C:\Users\RUNNER~1\…),git 回報的一律是長名稱,不展開會比對不到。
 * 路徑還不存在時,展開最近一層存在的上層,再接回其餘部分。
 */
const longPath = (p: string): string => {
  const abs = resolve(p);
  try { return realpathSync.native(abs); } catch { /* 不存在:往上找 */ }
  const parent = dirname(abs);
  return parent === abs ? abs : join(longPath(parent), basename(abs));
};
/** 路徑比較用的正規化:絕對路徑、展開短名稱、斜線統一、去掉結尾斜線;Windows 不分大小寫。 */
const normPath = (p: string) => { const s = longPath(p).replace(/\\/g, '/').replace(/\/+$/, ''); return WIN ? s.toLowerCase() : s; };
const samePath = (a: string, b: string) => normPath(a) === normPath(b);
/** child 是否在 parent 底下(不含 parent 本身)。 */
const isInside = (child: string, parent: string) => normPath(child).startsWith(`${normPath(parent)}/`);
const realOr = (p: string) => { try { return realpathSync.native(p); } catch { return resolve(p); } };

/** 副本標記檔:放在副本旁邊(<副本>.nexus-copy.json),不放進副本,才不會被當成副本被寫入的檔案。 */
const markerOf = (copy: string) => `${resolve(copy)}${COPY_MARKER_SUFFIX}`;
/** 副本資料夾名稱:r-<tree 前 8 碼>(審查用)、v-<tree 前 8 碼>(核實用),後面可接 -<編號>。 */
export const COPY_NAME_RE = /^[rv]-([0-9a-f]{8})(?:-[\w-]+)?$/;

/**
 * 找出資料夾底下「指向資料夾外面」的連結(symlink、junction;Node 在 Windows 上把 junction 也當成符號連結),以及解不出目標的壞連結。
 * 用 lstat 判斷,不跟隨連結,所以不會走進連結指向的真正 node_modules。指向資料夾裡面的連結不用解除:刪除時最多刪到資料夾自己的內容。
 */
function findEscapingLinks(root: string): string[] {
  const rootReal = realOr(root);
  const found: string[] = [];
  const walk = (dir: string) => {
    let list;
    try { list = readdirSync(dir); } catch { return; }
    for (const name of list) {
      const p = join(dir, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        let target = '';
        try { target = realpathSync.native(p); } catch { /* 壞連結:一樣解除 */ }
        if (!target || !isInside(target, rootReal)) found.push(p);
      } else if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return found;
}

/** 解除指向外面的連結,只移除連結本身(rmdirSync 不遞迴,對 junction 只會移除連結),並確認沒有殘留。解不掉就丟出錯誤。 */
function unlinkEscaping(root: string): string[] {
  const links = findEscapingLinks(root);
  for (const p of links) {
    try { unlinkSync(p); } catch { rmdirSync(p); }
    if (isLink(p) || existsSync(p)) throw new Error(`無法解除連結 ${p}`);
  }
  const left = findEscapingLinks(root);
  if (left.length) throw new Error(`仍有連結沒有解除:${left.slice(0, 3).join('、')}`);
  return links;
}

/**
 * 刪除副本前的檢查,任何一項不符就拒絕、什麼都不動:
 * root 與 dir 都是絕對路徑;dir 是 root 的直接子資料夾、名稱符合 r-/v-<tree8>、本身不是連結、裡面沒有 .git;
 * 旁邊有 exportTree 寫的標記檔而且版本前 8 碼和名稱一致;root、dir 都不是家目錄或它的上層。
 */
function checkCopyTarget(root: string, dir: string): string | null {
  if (!isAbsolute(root) || !isAbsolute(dir)) return '路徑必須是絕對路徑';
  const home = homedir();
  for (const p of [root, dir]) if (samePath(p, home) || isInside(home, p)) return `${p} 是家目錄或它的上層`;
  const abs = resolve(dir);
  if (!samePath(dirname(abs), root)) return `${abs} 不在副本資料夾 ${root} 底下`;
  const m = COPY_NAME_RE.exec(basename(abs));
  if (!m) return `${basename(abs)} 不是副本資料夾的名稱(r-/v- 加版本前 8 碼)`;
  if (!existsSync(abs) && !isLink(abs)) return null; // 已經不在(路徑本身合法),由呼叫端當成已刪除
  if (isLink(abs)) return `${abs} 是連結,不是副本`;
  if (existsSync(join(abs, '.git'))) return `${abs} 裡有 .git,不是流程匯出的副本`;
  let marker: { tree?: string };
  try { marker = JSON.parse(readFileSync(markerOf(abs), 'utf8')); } catch { return `${abs} 沒有副本標記檔,不是流程匯出的副本`; }
  if (typeof marker.tree !== 'string' || !marker.tree.startsWith(m[1])) return `${abs} 的標記檔版本和資料夾名稱不符`;
  return null;
}

/**
 * 刪除副本:檢查目標(見 checkCopyTarget)→ 解除指向外面的連結 → 確認沒有殘留 → 刪資料夾(重試 5 次)→ 刪標記檔。
 * root 是允許刪除的副本資料夾(runs/<id>/copies)。失敗就留下來並回傳原因(不丟出錯誤,讓呼叫端記錄)。
 */
export function removeCopy(root: string, dir: string): { removed: boolean; unlinked: string[]; error?: string } {
  const bad = checkCopyTarget(root, dir);
  if (bad) return { removed: false, unlinked: [], error: `拒絕刪除:${bad}` };
  const abs = resolve(dir);
  if (!existsSync(abs) && !isLink(abs)) {
    // 已經不在:只清掉留下的標記檔(路徑已確認在允許的資料夾底下)
    rmSync(markerOf(abs), { force: true });
    return { removed: true, unlinked: [] };
  }
  let unlinked: string[];
  try { unlinked = unlinkEscaping(abs); } catch (e) { return { removed: false, unlinked: [], error: (e as Error).message }; }
  try {
    rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) { return { removed: false, unlinked, error: `刪除副本失敗:${(e as Error).message}` }; }
  if (existsSync(abs)) return { removed: false, unlinked, error: `刪除後資料夾仍在:${abs}` };
  rmSync(markerOf(abs), { force: true });
  return { removed: true, unlinked };
}

const DETACHED_MESSAGE = 'Entropy Nexus 協作流程核實版本';

/**
 * 桌面核實用的獨立 worktree:commit-tree 做一個不掛在任何 ref 上的提交,再 worktree add --detach,
 * 最後把 node_modules 連結進去。不建分支、不動 refs(HEAD 之外)。
 * checkout 時不執行使用者 repo 的 hooks(core.hooksPath 指向空資料夾),也不讓 Git LFS 下載大檔(GIT_LFS_SKIP_SMUDGE)。
 * 回傳的 commit 要留著,移除時用來確認對象。
 */
export async function addDetachedWorktree(repo: string, tree: string, dest: string): Promise<{ path: string; commit: string; linked: string[]; failed: string[] }> {
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`版本格式不對:${tree}`);
  if (existsSync(dest)) throw new Error(`worktree 資料夾已存在:${dest}`);
  // 不依賴使用者有沒有設定 user.name/email
  const who = { GIT_AUTHOR_NAME: 'Entropy Nexus', GIT_AUTHOR_EMAIL: 'flow@entropy-nexus.local', GIT_COMMITTER_NAME: 'Entropy Nexus', GIT_COMMITTER_EMAIL: 'flow@entropy-nexus.local' };
  const c = await git(repo, ['commit-tree', tree, '-m', `${DETACHED_MESSAGE} ${tree.slice(0, 8)}`], who);
  const commit = c.out.trim();
  if (!c.ok || !/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`建立核實用提交失敗:${failText(c)}`);
  const top = await git(repo, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error(`找不到 git 版本庫:${failText(top)}`);
  const noHooks = mkdtempSync(join(tmpdir(), 'nexus-flow-nohooks-'));
  try {
    const add = await git(repo, ['-c', `core.hooksPath=${noHooks.replace(/\\/g, '/')}`, 'worktree', 'add', '--detach', resolve(dest), commit], { GIT_LFS_SKIP_SMUDGE: '1' }, 600000);
    if (!add.ok) throw new Error(`建立核實用 worktree 失敗:${failText(add)}`);
  } finally { rmSync(noHooks, { recursive: true, force: true }); }
  const links = linkNodeModules(top.out.trim(), dest);
  return { path: resolve(dest), commit, ...links };
}

interface WorktreeEntry { path: string; head: string; detached: boolean; bare: boolean }

function parseWorktreeList(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const wt = lines.find(l => l.startsWith('worktree '));
    if (!wt) continue;
    out.push({
      path: wt.slice('worktree '.length),
      head: lines.find(l => l.startsWith('HEAD '))?.slice(5).trim() ?? '',
      detached: lines.includes('detached'),
      bare: lines.includes('bare'),
    });
  }
  return out;
}

/** 移除前確認 dest 是 addDetachedWorktree 建的那個 worktree;不是就回傳拒絕的原因。 */
async function checkDetachedTarget(repo: string, dest: string, commit: string): Promise<string | null> {
  if (!isAbsolute(dest)) return '路徑必須是絕對路徑';
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return `提交格式不對:${commit}`;
  const home = homedir();
  if (samePath(dest, home) || isInside(home, dest)) return `${dest} 是家目錄或它的上層`;
  const top = await git(repo, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return `找不到 git 版本庫:${failText(top)}`;
  if (samePath(top.out.trim(), dest)) return `${dest} 是版本庫本身,不是核實用 worktree`;
  const list = await git(repo, ['worktree', 'list', '--porcelain']);
  if (!list.ok) return `讀取 worktree 清單失敗:${failText(list)}`;
  const entries = parseWorktreeList(list.out);
  const i = entries.findIndex(e => samePath(e.path, dest));
  if (i < 0) return `${dest} 不是這個版本庫登記的 worktree`;
  const e = entries[i];
  if (i === 0 || e.bare) return `${dest} 是主工作樹,不是核實用 worktree`;
  if (!e.detached) return `${dest} 停在分支上,不是核實用的 detached worktree`;
  if (e.head !== commit) return `${dest} 的 HEAD(${e.head.slice(0, 8)})不是核實用提交 ${commit.slice(0, 8)}`;
  const msg = await git(repo, ['log', '-1', '--format=%P%x00%s', commit]);
  const [parents, subject] = msg.out.trim().split('\0');
  if (!msg.ok || parents || !subject?.startsWith(DETACHED_MESSAGE)) return `${commit.slice(0, 8)} 不是主控台建立的核實用提交`;
  return null;
}

/**
 * 移除桌面核實的 worktree:先確認對象(已登記、不是主工作樹、detached、HEAD 是建立時的那筆核實用提交)→
 * 解除指向外面的連結 → 確認沒有殘留 → worktree remove --force <這個路徑>。任何一項不符就拒絕、什麼都不動。
 * 只處理這一個 worktree:不跑全域的 git worktree prune(會連帶清掉使用者自己暫時不在的 worktree,例如外接碟上的)。
 * 資料夾已經不在時:還登記著就只移除這一筆登記(worktree remove --force 對不存在的路徑也只動那一筆),沒登記就當成已移除。
 */
export async function removeDetachedWorktree(repo: string, dest: string, commit: string): Promise<{ removed: boolean; unlinked: string[]; error?: string }> {
  if (isAbsolute(dest) && !existsSync(dest)) {
    const list = await git(repo, ['worktree', 'list', '--porcelain']);
    if (!list.ok || !parseWorktreeList(list.out).some(e => samePath(e.path, dest))) return { removed: true, unlinked: [] };
    const bad = await checkDetachedTarget(repo, dest, commit);
    if (bad) return { removed: false, unlinked: [], error: `拒絕移除:${bad}` };
    const rm = await git(repo, ['worktree', 'remove', '--force', resolve(dest)]);
    return rm.ok ? { removed: true, unlinked: [] } : { removed: false, unlinked: [], error: `移除核實用 worktree 的登記失敗:${failText(rm)}` };
  }
  const bad = await checkDetachedTarget(repo, dest, commit);
  if (bad) return { removed: false, unlinked: [], error: `拒絕移除:${bad}` };
  const abs = resolve(dest);
  let unlinked: string[];
  try { unlinked = unlinkEscaping(abs); } catch (e) { return { removed: false, unlinked: [], error: (e as Error).message }; }
  const rm = await git(repo, ['worktree', 'remove', '--force', abs], undefined, 600000);
  if (!rm.ok) return { removed: false, unlinked, error: `移除核實用 worktree 失敗:${failText(rm)}` };
  return existsSync(abs) ? { removed: false, unlinked, error: `移除後資料夾仍在:${abs}` } : { removed: true, unlinked };
}
