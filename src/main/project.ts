import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * 專案識別:把工作目錄對應到「專案」,記憶與統計都依專案歸類。
 * - git 版本庫:用 `git rev-parse --git-common-dir` 找到主版本庫,所以同一個 repo 的所有 worktree(包括主控台的獨立工作區)是同一個專案。
 * - 不是 git 版本庫:用正規化後的工作目錄(實際路徑、斜線統一、去掉結尾斜線、Windows 不分大小寫)。
 * id 就是正規化後的專案根目錄路徑(可讀、同一個資料夾永遠得到同一個值、不必另外存對照表);name 是根目錄的資料夾名稱。
 */
export interface Project { id: string; name: string; root: string; /** 根目錄是不是 git 版本庫;快取還沒算出來之前是 undefined。 */ isGit?: boolean }

/** 路徑正規化:實際路徑(解開符號連結與短檔名,資料夾不存在時用原路徑)、反斜線改斜線、去掉結尾斜線;Windows 另外轉小寫。 */
export function normalizePath(p: string, caseFold = process.platform === 'win32'): string {
  let full = resolve(p);
  try { full = realpathSync.native(full); } catch { /* 資料夾不存在就用原本的路徑 */ }
  let out = full.replace(/\\/g, '/');
  // 磁碟機根目錄(C:/)與 / 本身要保留斜線
  if (!/^([a-zA-Z]:)?\/$/.test(out)) out = out.replace(/\/+$/, '');
  return caseFold ? out.toLowerCase() : out;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise(res => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, timeout: 15000 },
      (err, stdout) => res(err ? null : String(stdout).trim()));
  });
}

/** 資料夾實際的名稱(保留大小寫);失敗時用 fallback。 */
function folderName(dir: string, fallback: string): string {
  let real = dir;
  try { real = realpathSync.native(resolve(dir)); } catch { /* 用原路徑 */ }
  return basename(real.replace(/[\\/]+$/, '')) || fallback;
}

/** 不看快取,直接算一次;isGit 表示是靠 git 找到的根目錄。 */
export async function resolveProject(cwd: string): Promise<Project & { isGit: boolean }> {
  const common = await git(cwd, ['rev-parse', '--git-common-dir']);
  let root: string | null = null;
  if (common) {
    const dir = resolve(cwd, common);
    // 一般版本庫是 <根>/.git;子模組的共用資料夾在 <上層>/.git/modules/<名稱> 底下,改用它自己的工作樹;bare 版本庫就是資料夾本身
    if (/[\\/]\.git[\\/]modules[\\/]/.test(dir)) root = await git(cwd, ['rev-parse', '--show-toplevel']);
    else root = basename(dir) === '.git' ? dirname(dir) : dir;
  }
  const base = root ?? cwd;
  const id = normalizePath(base);
  return { id, name: folderName(base, id), root: id, isGit: root !== null };
}

const cache = new Map<string, { at: number; isGit: boolean; p: Promise<Project> }>();
/** 不是 git 的結果只快取這麼久:使用者可能之後才 git init。git 的結果不會變(除非搬動資料夾)。 */
const NON_GIT_TTL = 60 * 1000;

/** 工作目錄所屬的專案(有快取)。 */
export function projectOf(cwd: string): Promise<Project> {
  const key = normalizePath(cwd);
  const hit = cache.get(key);
  if (hit && (hit.isGit || Date.now() - hit.at < NON_GIT_TTL)) return hit.p;
  const entry = { at: Date.now(), isGit: false, p: Promise.resolve({ id: key, name: basename(key), root: key }) };
  const p = resolveProject(cwd).then(r => { entry.isGit = r.isGit; return { id: r.id, name: r.name, root: r.root, isGit: r.isGit }; });
  entry.p = p;
  cache.set(key, entry);
  p.catch(() => cache.delete(key));
  return p;
}

export function clearProjectCache(): void { cache.clear(); }

/**
 * 只有專案ID(根目錄路徑)時判斷它是不是 git 版本庫,給沒有記下類型的舊任務用:根目錄有 .git(資料夾或檔案),
 * 或本身是 bare 版本庫(有 HEAD 與 objects)就是 git;其餘、或路徑已經不存在,都算資料夾。不執行 git,只看檔案。
 */
export function projectKindFromPath(id: string, exists: (p: string) => boolean = existsSync): 'git' | '資料夾' {
  try {
    if (exists(join(id, '.git')) || (exists(join(id, 'HEAD')) && exists(join(id, 'objects')))) return 'git';
  } catch { /* 讀不到就當資料夾 */ }
  return '資料夾';
}
