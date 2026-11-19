import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangedFile, ChangeSet, NexusEvent, RevertResult } from '../shared/types';

/**
 * 變更檢視的資料來源。
 * 工作目錄是 git 版本庫時,在任務前後各拍一張「工作區快照」(一個 git tree 物件),兩張相減就是這個任務期間的變更,
 * 不論是哪一家 CLI、用工具還是用指令改的都算得到,也不受任務開始前就存在的未提交修改影響。
 * 快照用獨立的暫存索引檔建立,不會動到使用者自己的暫存區、分支或提交;只會在版本庫裡留下沒有被引用的物件,git 之後會自行清理。
 */
const MAX_PATCH = 200_000;
const MAX_FILES = 300;

function git(cwd: string, args: string[], env?: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    // 快照與還原都以檔案的原始位元組為準,不做換行轉換;否則還原時 LF 會被寫成 CRLF
    execFile('git', ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 },
      (err, stdout) => resolve({ ok: !err, out: String(stdout) }));
  });
}

/** 拍下工作目錄目前的內容,回傳 tree 的雜湊;不是 git 版本庫或失敗時回傳 null。 */
export async function snapshotTree(cwd: string): Promise<string | null> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') return null;
  // 工作目錄本身被上層版本庫的 .gitignore 排除時,快照會是空的,等同沒有版本控制
  if ((await git(cwd, ['check-ignore', '-q', '.'])).ok) return null;
  const dir = mkdtempSync(join(tmpdir(), 'nexus-idx-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    // 只納入工作目錄底下的檔案,並遵守 .gitignore
    const add = await git(cwd, ['add', '-A', '--', '.'], env);
    if (!add.ok) return null;
    const tree = await git(cwd, ['write-tree'], env);
    return tree.ok && /^[0-9a-f]{40,64}$/.test(tree.out.trim()) ? tree.out.trim() : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function summarizeTrees(cwd: string, base: string, end: string): Promise<{ files: number; added: number; removed: number }> {
  const r = await git(cwd, ['diff', '--numstat', base, end]);
  let files = 0, added = 0, removed = 0;
  for (const line of r.out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files++;
    added += Number(m[1]) || 0;
    removed += Number(m[2]) || 0;
  }
  return { files, added, removed };
}

/** 兩張快照之間的完整差異,依檔案切開。 */
export async function diffTrees(cwd: string, base: string, end: string): Promise<ChangeSet> {
  const [status, numstat, patch] = await Promise.all([
    git(cwd, ['diff', '--name-status', base, end]),
    git(cwd, ['diff', '--numstat', base, end]),
    git(cwd, ['diff', '--no-color', '--no-ext-diff', '-U3', base, end]),
  ]);
  const files = new Map<string, ChangedFile>();
  for (const line of status.out.split('\n')) {
    const [code, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!code || !path) continue;
    const s = code[0] === 'A' ? 'A' : code[0] === 'D' ? 'D' : 'M';
    files.set(path, { path, status: s, added: 0, removed: 0, binary: false, patch: '' });
  }
  for (const line of numstat.out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    const f = m && files.get(m[3]);
    if (!m || !f) continue;
    f.binary = m[1] === '-';
    f.added = Number(m[1]) || 0;
    f.removed = Number(m[2]) || 0;
  }
  for (const chunk of patch.out.split(/^diff --git /m).slice(1)) {
    const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1];
    const minus = /^--- a\/(.+)$/m.exec(chunk)?.[1];
    const header = /^a\/(.+) b\/(.+)$/m.exec(chunk.split('\n')[0]);
    const f = files.get(plus ?? '') ?? files.get(minus ?? '') ?? files.get(header?.[2] ?? '');
    if (!f) continue;
    const at = chunk.indexOf('\n@@');
    const body = at >= 0 ? chunk.slice(at + 1) : '';
    f.patch = body.length > MAX_PATCH ? `${body.slice(0, MAX_PATCH)}\n… 內容過長,後面省略` : body;
  }
  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { source: 'git', note: '', files: list.slice(0, MAX_FILES), truncated: list.length > MAX_FILES };
}

const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|Patch|write_file|write_to_file|replace_file_content|multi_replace_file_content|edit_file)$/i;

/**
 * 工作目錄不是 git 版本庫時的替代做法:只能列出 CLI 透過編輯工具回報的修改,
 * 看不到用指令(例如 PowerShell)改的檔案,也沒有修改前的完整內容。
 */
export function changesFromEvents(events: NexusEvent[]): ChangeSet {
  const files: ChangedFile[] = [];
  for (const e of events) {
    if (e.type !== 'tool' || e.phase !== 'start' || !EDIT_TOOLS.test(e.name)) continue;
    let patch = e.detail ?? '';
    let path = e.summary;
    let added = 0, removed = 0;
    let status: ChangedFile['status'] = 'M';
    try {
      const input = JSON.parse(e.detail ?? '');
      path = input.file_path ?? input.Path ?? input.TargetFile ?? path;
      const lines = (s: string, sign: string) => s.replace(/\r?\n$/, '').split('\n').map(l => sign + l);
      if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
        patch = ['@@ 這次編輯 @@', ...lines(input.old_string, '-'), ...lines(input.new_string, '+')].join('\n');
      } else if (typeof input.content === 'string') {
        status = 'A';
        patch = ['@@ 寫入的內容 @@', ...lines(input.content, '+')].join('\n');
      } else if (typeof input.CodeContent === 'string') {
        status = 'A';
        patch = ['@@ 寫入的內容 @@', ...lines(input.CodeContent, '+')].join('\n');
      }
    } catch { /* 不是 JSON(例如 Codex 的 patch 文字)就原樣顯示 */ }
    for (const l of patch.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) added++; else if (l.startsWith('-') && !l.startsWith('---')) removed++; }
    files.push({ path: String(path), status, added, removed, binary: false, patch: patch.slice(0, MAX_PATCH) });
  }
  return {
    source: 'tools',
    note: '這個工作目錄不是 git 版本庫,只能列出 CLI 透過編輯工具回報的修改;用指令改的檔案不會出現在這裡。',
    files: files.slice(0, MAX_FILES),
    truncated: files.length > MAX_FILES,
  };
}

async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.out.trim() : null;
}

/**
 * 還原一個任務的修改(paths 省略時還原整個任務)。
 * 只還原「現在的內容仍等於任務結束時內容」的檔案;任務之後又被改過的會跳過並回報,避免蓋掉較新的修改。
 * 還原只動工作區的檔案,不動暫存區與提交。
 */
export async function revertChanges(cwd: string, base: string, end: string, paths?: string[]): Promise<RevertResult> {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('找不到 git 版本庫');
  const set = await diffTrees(cwd, base, end);
  const result: RevertResult = { reverted: [], skipped: [] };
  for (const f of set.files) {
    if (paths && !paths.includes(f.path)) continue;
    const abs = join(root, f.path);
    const now = existsSync(abs) ? (await git(root, ['hash-object', '--', f.path])).out.trim() : '';
    const atEnd = f.status === 'D' ? '' : (await git(root, ['rev-parse', `${end}:${f.path}`])).out.trim();
    if (now !== atEnd) { result.skipped.push({ path: f.path, reason: '任務結束後又被修改過' }); continue; }
    if (f.status === 'A') {
      try { rmSync(abs, { force: true }); result.reverted.push(f.path); } catch (e) { result.skipped.push({ path: f.path, reason: String((e as Error).message) }); }
    } else {
      const r = await git(root, ['restore', `--source=${base}`, '--worktree', '--', f.path]);
      if (r.ok) result.reverted.push(f.path); else result.skipped.push({ path: f.path, reason: '還原失敗' });
    }
  }
  return result;
}

/** 把一個任務改過的檔案提交成一筆 commit。提交的是這些檔案「現在」的內容。 */
export async function commitChanges(cwd: string, base: string, end: string, message: string): Promise<string> {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('找不到 git 版本庫');
  const paths = (await diffTrees(cwd, base, end)).files.map(f => f.path);
  if (!paths.length) throw new Error('這個任務沒有可以提交的修改。');
  // 提交走使用者自己的 git 設定(包含換行轉換),不套用快照用的設定
  const add = await gitFull(root, ['add', '-A', '--', ...paths]);
  if (!add.ok) throw new Error('暫存檔案失敗');
  const c = await gitFull(root, ['commit', '-m', message, '--', ...paths]);
  if (!c.ok) throw new Error(`提交失敗:${(c.err || c.out).split('\n').slice(-2).join(' ').slice(0, 240)}`);
  return (await git(root, ['rev-parse', '--short', 'HEAD'])).out.trim();
}

function gitFull(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout), err: String(stderr) }));
  });
}
