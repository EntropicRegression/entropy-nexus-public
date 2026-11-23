import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DirInfo, WorktreeInfo, WorktreeStatus } from '../shared/types';

/**
 * 獨立工作區:每個節點在自己的 git worktree 與分支上工作,互不覆寫。
 * worktree 只隔離工作檔案,不是沙箱:行程、連接埠、共用資料庫仍可能互相影響。
 * 新的工作區只有已追蹤的檔案,所以建立後會做環境初始化(見 setupWorktree):複製未追蹤的環境檔、把 node_modules 連結回原版本庫。
 */
let home = '';

export function initWorktrees(dir: string): void {
  home = join(dir, 'worktrees');
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() }));
  });
}

const fail = (what: string, r: { err: string; out: string }) => new Error(`${what}:${(r.err || r.out).split('\n').slice(-3).join(' ').slice(0, 300)}`);

/** 新增節點面板用:這個資料夾能不能建立獨立工作區。 */
export async function inspectDir(cwd: string): Promise<DirInfo> {
  if (!cwd.trim() || !existsSync(cwd)) return { exists: false, isRepo: false, branch: '', hasCommit: false };
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { exists: true, isRepo: false, branch: '', hasCommit: false };
  const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { exists: true, isRepo: true, branch: branch.ok ? branch.out : '', hasCommit: head.ok };
}

/** 不鑽進去找環境檔的大資料夾(除非 .worktreeinclude 直接點名這個資料夾)。node_modules 與 .git 永遠跳過。 */
const HEAVY = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'dist', 'build', 'out', 'target', 'coverage', '.cache', '.turbo', '.gradle', 'vendor']);
const MAX_WALK = 20000;

/** gitignore 風格的樣式轉成比對函式:支援 `*`、`**`、`?`、`[...]`、開頭 `!` 排除、開頭或中間有 `/` 時從根目錄比對、結尾 `/` 只比對資料夾。 */
export function compileRules(text: string): (rel: string, isDir: boolean) => boolean {
  const rules: { neg: boolean; dirOnly: boolean; re: RegExp }[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!');
    if (neg) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    if (!line) continue;
    let re = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '*' && line[i + 1] === '*') {
        i++;
        if (line[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else if (c === '[') { const end = line.indexOf(']', i + 1); if (end < 0) re += '\\['; else { re += `[${line.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end; } }
      else if (c === '\\' && i + 1 < line.length) re += line[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
    rules.push({ neg, dirOnly, re: new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`) });
  }
  // 和 gitignore 一樣:資料夾符合時底下全部算符合;後面的規則蓋過前面的
  return (rel, isDir) => {
    const parts = rel.split('/');
    let hit = false;
    for (let n = 1; n <= parts.length; n++) {
      const p = parts.slice(0, n).join('/');
      const dir = n < parts.length || isDir;
      for (const r of rules) if ((!r.dirOnly || dir) && r.re.test(p)) hit = !r.neg;
    }
    return hit;
  };
}

const isEnvFile = (rel: string, isDir: boolean) => !isDir && /^\.env(\..+)?$/.test(basename(rel));

/** 可能放 node_modules 的位置:根目錄與兩層內的子專案(例如 app/、packages/x/)。 */
function nodeModulesSpots(root: string): string[] {
  const spots = ['node_modules'];
  const dirs = (rel: string) => {
    try { return readdirSync(join(root, rel), { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && !HEAVY.has(d.name)).map(d => (rel ? `${rel}/${d.name}` : d.name)); } catch { return []; }
  };
  for (const a of dirs('')) {
    spots.push(`${a}/node_modules`);
    for (const b of dirs(a)) spots.push(`${b}/node_modules`);
  }
  return spots;
}

const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/**
 * 解除工作區裡指回原版本庫的 node_modules 連結(junction 或 symlink),只移除連結本身,不碰目標的內容。
 * 必須在 git 刪除工作區之前做,否則刪除時可能順著連結把原專案的 node_modules 清掉。回傳解除的連結;有解不掉的就丟出錯誤。
 */
export function unlinkWorktreeLinks(path: string): string[] {
  const done: string[] = [];
  for (const rel of nodeModulesSpots(path)) {
    const p = join(path, rel);
    if (!isLink(p)) continue;
    try { unlinkSync(p); } catch { rmdirSync(p); } // rmdirSync 不遞迴,對 junction 只會移除連結
    if (isLink(p) || existsSync(p)) throw new Error(`無法解除連結 ${p}`);
    done.push(rel);
  }
  return done;
}

function linkDir(target: string, at: string): void {
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * 原版本庫裡有、目標資料夾裡沒有的 node_modules(根目錄與兩層內的子專案)建立連結(Windows 用 junction),不必重裝。
 * 子專案資料夾不在目標裡、或目標已有自己的 node_modules 就跳過。回傳建立的連結(相對路徑)與失敗原因。
 * 清理時一定要先用 unlinkWorktreeLinks 解除連結,再刪資料夾。
 */
export function linkNodeModules(repoRoot: string, path: string): { linked: string[]; failed: string[] } {
  const linked: string[] = [], failed: string[] = [];
  for (const rel of nodeModulesSpots(repoRoot)) {
    const src = join(repoRoot, rel);
    const at = join(path, rel);
    try {
      if (!existsSync(src) || !lstatSync(realpathSync(src)).isDirectory()) continue;
      if (!existsSync(dirname(at)) || existsSync(at) || isLink(at)) continue; // 子專案不在工作區裡,或工作區已有自己的 node_modules
      linkDir(realpathSync(src), at);
      linked.push(rel);
    } catch (e) { failed.push(`連結 ${rel}:${(e as Error).message}`); }
  }
  return { linked, failed };
}

/**
 * 獨立工作區的環境初始化:
 * 1. 原版本庫有 .worktreeinclude 時,依它的 gitignore 風格規則複製符合的未追蹤檔案;沒有時複製 .env、.env.* 這類環境檔。
 * 2. 原版本庫裡有、工作區裡沒有的 node_modules(根目錄與兩層內的子專案)建立連結,不必每個節點重裝。
 * 3. 工作區裡沒有被忽略的連結與複製檔寫進 info/exclude,避免被當成未提交的修改,或在合併時被 git add -A 提交出去。
 * 不執行任何專案指令(安全考量)。任何一步失敗都只記在摘要裡,不會讓建立節點失敗。
 */
export async function setupWorktree(repoRoot: string, path: string): Promise<string> {
  const copied: string[] = [], linked: string[] = [], failed: string[] = [];
  let truncated = false;
  const includeFile = join(repoRoot, '.worktreeinclude');
  const hasInclude = existsSync(includeFile);
  let match = isEnvFile;
  if (hasInclude) {
    try { match = compileRules(readFileSync(includeFile, 'utf8')); } catch (e) { failed.push(`.worktreeinclude:${(e as Error).message}`); }
  }
  const root = resolve(path);
  const copy = (rel: string) => {
    const dest = resolve(root, rel);
    const back = relative(root, dest);
    // 防路徑跳脫:只寫在工作區之內,也不碰 .git
    if (!back || back.startsWith('..') || isAbsolute(back) || back.split(/[\\/]/).includes('.git')) return;
    if (existsSync(dest)) return; // 工作區已有(例如已追蹤)就不覆寫
    try {
      if (!lstatSync(join(repoRoot, rel)).isFile()) return; // 只複製一般檔案,不跟隨連結
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(repoRoot, rel), dest);
      copied.push(rel);
    } catch (e) { failed.push(`複製 ${rel}:${(e as Error).message}`); }
  };
  let walked = 0;
  // git 把整個未追蹤的資料夾收成一筆時,自己往下找,但跳過大資料夾、連結,也有數量上限
  const walk = (rel: string) => {
    let list;
    try { list = readdirSync(join(repoRoot, rel), { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (++walked > MAX_WALK) { truncated = true; return; }
      const sub = `${rel}/${d.name}`;
      if (d.isDirectory()) {
        if (d.name === 'node_modules' || d.name === '.git') continue;
        if (HEAVY.has(d.name) && !(hasInclude && match(sub, true))) continue;
        walk(sub);
      } else if (d.isFile() && match(sub, false)) copy(sub);
    }
  };
  try {
    // 未追蹤的檔案(含被忽略的);--directory 讓 node_modules 這類整包未追蹤的資料夾只列一筆,不會整棵掃過
    const lists = await Promise.all([
      git(repoRoot, ['ls-files', '-z', '--others', '--exclude-standard', '--directory']),
      git(repoRoot, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
    ]);
    if (lists.some(l => !l.ok)) failed.push('列出未追蹤的檔案失敗');
    const entries = new Set(lists.flatMap(l => (l.ok ? l.out.split('\0') : [])).filter(Boolean));
    for (const e of entries) {
      const rel = e.replace(/\/$/, '');
      if (!rel || rel.split('/').includes('.git')) continue;
      if (e.endsWith('/')) {
        const name = basename(rel);
        if (name === 'node_modules' || (HEAVY.has(name) && !(hasInclude && match(rel, true)))) continue;
        walk(rel);
      } else if (match(rel, false)) copy(rel);
    }
  } catch (e) { failed.push(`複製環境檔:${(e as Error).message}`); }

  const links = linkNodeModules(repoRoot, path);
  linked.push(...links.linked);
  failed.push(...links.failed);

  // 連結指向資料夾以外的地方,`node_modules/` 這種只比對資料夾的忽略規則對它無效,所以要另外排除
  const made = [...linked, ...copied];
  if (made.length) {
    try {
      const ignored = new Set((await git(path, ['check-ignore', '--no-index', '--', ...made])).out.split(/\r?\n/).map(s => s.trim().replace(/\\/g, '/')).filter(Boolean));
      const add = made.filter(p => !ignored.has(p));
      if (add.length) {
        const ex = await git(path, ['rev-parse', '--git-path', 'info/exclude']);
        if (!ex.ok) throw new Error('找不到 info/exclude');
        const file = resolve(path, ex.out);
        const have = existsSync(file) ? readFileSync(file, 'utf8') : '';
        const lines = add.map(p => `/${p.replace(/([*?[\]\\!#])/g, '\\$1')}`).filter(l => !have.split(/\r?\n/).includes(l));
        if (lines.length) {
          mkdirSync(dirname(file), { recursive: true });
          appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}# Entropy Nexus 獨立工作區複製或連結的檔案\n${lines.join('\n')}\n`);
        }
      }
    } catch (e) { failed.push(`寫入 info/exclude:${(e as Error).message}`); }
  }

  const show = (l: string[]) => (l.length > 8 ? `${l.slice(0, 8).join('、')} 等 ${l.length} 個` : l.join('、'));
  const parts = [
    copied.length ? `複製了 ${copied.length} 個檔案(${show(copied)})` : (hasInclude ? '沒有符合 .worktreeinclude 的未追蹤檔案' : '沒有找到 .env 類的環境檔'),
    linked.length ? `node_modules 連結回原版本庫(${show(linked)})` : '',
    truncated ? `部分資料夾超過 ${MAX_WALK} 個項目,沒有全部檢查` : '',
    failed.length ? `失敗:${show(failed)}` : '',
  ].filter(Boolean);
  return `獨立工作區環境初始化${hasInclude ? '(依 .worktreeinclude)' : ''}:${parts.join(';')}。`;
}

export async function createWorktree(cwd: string, name: string, id: string): Promise<{ info: WorktreeInfo; cwd: string; setup: string }> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error('這個資料夾不是 git 版本庫,無法建立獨立工作區。');
  const repoRoot = top.out;
  if (!(await git(repoRoot, ['rev-parse', '--verify', '-q', 'HEAD'])).ok) throw new Error('版本庫還沒有任何提交,無法建立獨立工作區。請先提交一次。');
  const abbrev = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const base = abbrev.ok && abbrev.out !== 'HEAD' ? abbrev.out : (await git(repoRoot, ['rev-parse', 'HEAD'])).out;
  const slug = name.replace(/[^\w-]+/g, '').slice(0, 20) || 'node';
  const short = id.slice(0, 6);
  mkdirSync(home, { recursive: true });
  // 同一個節點可能再開一個工作區(轉移工作區):分支或資料夾已存在就加 -2、-3
  let branch = '', path = '';
  for (let k = 1; k < 100; k++) {
    const tail = k === 1 ? '' : `-${k}`;
    branch = `nexus/${slug}-${short}${tail}`;
    path = join(home, `${basename(repoRoot).replace(/[^\w.-]+/g, '_')}-${slug}-${short}${tail}`);
    if (!existsSync(path) && !(await git(repoRoot, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).ok) break;
  }
  const add = await git(repoRoot, ['worktree', 'add', '-b', branch, path, 'HEAD']);
  if (!add.ok) throw fail('建立獨立工作區失敗', add);
  // 節點原本選的若是版本庫裡的子資料夾,在工作區裡也進到同一個子資料夾
  const sub = relative(repoRoot.replace(/\//g, '\\'), cwd.replace(/\//g, '\\'));
  const inner = sub && !sub.startsWith('..') ? join(path, sub) : path;
  const setup = await setupWorktree(repoRoot, path).catch(e => `獨立工作區環境初始化失敗:${(e as Error).message}`);
  return { info: { repoRoot, path, branch, base }, cwd: existsSync(inner) ? inner : path, setup };
}

export async function worktreeStatus(w: WorktreeInfo): Promise<WorktreeStatus> {
  if (!existsSync(w.path)) return { exists: false, dirty: false, ahead: 0, branch: w.branch, base: w.base };
  const dirty = (await git(w.path, ['status', '--porcelain'])).out.length > 0;
  const ahead = Number((await git(w.repoRoot, ['rev-list', '--count', `${w.base}..${w.branch}`])).out) || 0;
  return { exists: true, dirty, ahead, branch: w.branch, base: w.base };
}

/** 把工作區裡還沒提交的修改全部提交成一筆;沒有修改就什麼都不做。 */
export async function commitAll(w: WorktreeInfo, message: string): Promise<boolean> {
  if (!(await git(w.path, ['status', '--porcelain'])).out) return false;
  const add = await git(w.path, ['add', '-A']);
  if (!add.ok) throw fail('暫存修改失敗', add);
  const c = await git(w.path, ['commit', '-m', message]);
  if (!c.ok) throw fail('提交失敗(請確認已設定 git 的 user.name 與 user.email)', c);
  return true;
}

/** 合併回原本的分支。主版本庫必須正停在那個分支上;有衝突時會取消合併,不留下半成品。 */
export async function mergeBack(w: WorktreeInfo, message: string): Promise<string> {
  await commitAll(w, message);
  const st = await worktreeStatus(w);
  if (st.ahead === 0) throw new Error('這個工作區沒有新的提交可以合併。');
  const current = await git(w.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.out !== w.base) throw new Error(`主版本庫目前在分支「${current.out}」,不是「${w.base}」。請先切回 ${w.base} 再合併。`);
  const m = await git(w.repoRoot, ['merge', '--no-ff', '-m', `合併 ${w.branch}:${message}`, w.branch]);
  if (!m.ok) {
    await git(w.repoRoot, ['merge', '--abort']);
    throw fail('合併失敗,已取消這次合併(可能有衝突,或主版本庫有未提交的修改擋住)', m);
  }
  return (await git(w.repoRoot, ['rev-parse', '--short', 'HEAD'])).out;
}

/** 推送分支並用 gh 開 PR。需要已安裝並登入 GitHub CLI,且版本庫有名為 origin 的遠端。 */
export async function openPullRequest(w: WorktreeInfo, title: string): Promise<string> {
  const gh = await new Promise<boolean>(r => execFile('gh', ['--version'], { windowsHide: true, timeout: 15000 }, err => r(!err)));
  if (!gh) throw new Error('找不到 GitHub CLI(gh)。請先安裝並執行 gh auth login。');
  if (!(await git(w.repoRoot, ['remote', 'get-url', 'origin'])).ok) throw new Error('這個版本庫沒有名為 origin 的遠端,無法開 PR。');
  await commitAll(w, title);
  if ((await worktreeStatus(w)).ahead === 0) throw new Error('這個工作區沒有新的提交可以開 PR。');
  const push = await git(w.path, ['push', '-u', 'origin', w.branch]);
  if (!push.ok) throw fail('推送分支失敗', push);
  return new Promise((resolve, reject) => {
    execFile('gh', ['pr', 'create', '--base', w.base, '--head', w.branch, '--title', title, '--body', '由 Entropy Nexus 的節點建立。'], { cwd: w.path, windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => (err ? reject(new Error(`開 PR 失敗:${String(stderr || stdout).trim().slice(0, 300)}`)) : resolve(String(stdout).trim().split('\n').pop() ?? '')));
  });
}

/** 移除工作區與它的分支。force 為 false 時,有未提交的修改或還沒合併的提交就不移除。 */
export async function removeWorktree(w: WorktreeInfo, force: boolean): Promise<boolean> {
  if (!existsSync(w.path)) { await git(w.repoRoot, ['worktree', 'prune']); return true; }
  const st = await worktreeStatus(w);
  if (!force && (st.dirty || st.ahead > 0)) {
    // 提交都已合併回去的話,ahead 仍大於 0;改用「分支是否已被合併」判斷
    const merged = (await git(w.repoRoot, ['branch', '--merged', w.base, '--list', w.branch])).out.includes(w.branch);
    if (st.dirty || !merged) return false;
  }
  // 先解除指回原版本庫的 node_modules 連結,git 刪資料夾時才不會刪進原專案;解不掉就不刪
  let unlinked: string[];
  try { unlinked = unlinkWorktreeLinks(w.path); } catch { return false; }
  const rm = await git(w.repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), w.path]);
  if (!rm.ok) {
    // 沒刪成功就把連結接回去,保留下來的工作區仍可直接使用
    for (const rel of unlinked) { try { linkDir(realpathSync(join(w.repoRoot, rel)), join(w.path, rel)); } catch { /* 原版本庫已沒有這個資料夾 */ } }
    return false;
  }
  await git(w.repoRoot, ['branch', force ? '-D' : '-d', w.branch]);
  return true;
}
